import { describe, it, expect, afterAll } from 'vitest';
import { prisma, CallStatus } from '@comm/database';
import { GROUP_CALL_MAX_PARTICIPANTS } from '@comm/types';
import { createGroup } from '../../modules/groups/service';
import { registerDevice } from '../../modules/devices/service';
import { startGroupCall, joinGroupCall, leaveGroupCall, assertValidGroupCallTarget, getGroupCallRoster } from '../../modules/calls/group-service';
import { listCallHistory } from '../../modules/calls/history';
import { createActiveUser, deleteTestUser, fakeDeviceRegistration } from '../helpers';

/**
 * Group call signaling/roster/history correctness (docs/13-roadmap.md). Exercises
 * `group-service.ts` (the WS handlers themselves are thin wrappers around these —
 * see message-handlers.ts's `group-call.*` cases) plus `listCallHistory`'s
 * group-aware `groupName` branch fixed alongside this feature.
 */
describe('group calls', () => {
  const createdUserIds: string[] = [];
  const createdGroupIds: string[] = [];

  afterAll(async () => {
    await Promise.all(createdGroupIds.map((id) => prisma.group.delete({ where: { id } }).catch(() => undefined)));
    await Promise.all(createdUserIds.map(deleteTestUser));
  });

  async function makeMember(name: string) {
    const user = await createActiveUser();
    createdUserIds.push(user.userId);
    const { deviceId } = await registerDevice(prisma, user.userId, fakeDeviceRegistration(name));
    return { ...user, deviceId };
  }

  async function setupGroup(memberCount: number) {
    const admin = await makeMember('Admin device');
    const others = await Promise.all(Array.from({ length: memberCount - 1 }, (_, i) => makeMember(`Member ${i} device`)));
    const group = await createGroup(admin.userId, 'Group call test', undefined, others.map((m) => m.username));
    createdGroupIds.push(group.id);
    return { admin, others, group };
  }

  it('refuses to start a group call against a direct conversation', async () => {
    const admin = await makeMember('Solo device 1');
    const other = await makeMember('Solo device 2');
    const conversation = await prisma.conversation.create({
      data: { type: 'direct', members: { create: [{ userId: admin.userId }, { userId: other.userId }] } },
    });

    await expect(startGroupCall(admin.userId, admin.deviceId, conversation.id, crypto.randomUUID())).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
  });

  it('refuses a non-member from starting or joining a group call', async () => {
    const { group } = await setupGroup(2);
    const outsider = await makeMember('Outsider device');
    const callId = crypto.randomUUID();

    await expect(startGroupCall(outsider.userId, outsider.deviceId, group.conversationId, callId)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(joinGroupCall(outsider.userId, outsider.deviceId, group.conversationId, callId)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  it('start → join grows the roster, and re-joining the same device is idempotent', async () => {
    const { admin, others, group } = await setupGroup(3);
    const callId = crypto.randomUUID();

    await startGroupCall(admin.userId, admin.deviceId, group.conversationId, callId);
    let roster = await getGroupCallRoster(admin.userId, group.conversationId, callId);
    expect(roster).toHaveLength(1);
    expect(roster[0]?.userId).toBe(admin.userId);

    await joinGroupCall(others[0]!.userId, others[0]!.deviceId, group.conversationId, callId);
    roster = await getGroupCallRoster(admin.userId, group.conversationId, callId);
    expect(roster).toHaveLength(2);

    // Retried/duplicate join for the exact same device — no duplicate entry.
    await joinGroupCall(others[0]!.userId, others[0]!.deviceId, group.conversationId, callId);
    roster = await getGroupCallRoster(admin.userId, group.conversationId, callId);
    expect(roster).toHaveLength(2);

    // A second participant joining is what makes this a genuinely connected call.
    const call = await prisma.call.findUniqueOrThrow({ where: { id: callId } });
    expect(call.status).toBe(CallStatus.answered);
  });

  it(`rejects a join once the roster already has ${GROUP_CALL_MAX_PARTICIPANTS} participants`, async () => {
    const { admin, others, group } = await setupGroup(GROUP_CALL_MAX_PARTICIPANTS + 1);
    const callId = crypto.randomUUID();

    await startGroupCall(admin.userId, admin.deviceId, group.conversationId, callId);
    for (let i = 0; i < GROUP_CALL_MAX_PARTICIPANTS - 1; i++) {
      await joinGroupCall(others[i]!.userId, others[i]!.deviceId, group.conversationId, callId);
    }
    const roster = await getGroupCallRoster(admin.userId, group.conversationId, callId);
    expect(roster).toHaveLength(GROUP_CALL_MAX_PARTICIPANTS);

    const overflow = others[GROUP_CALL_MAX_PARTICIPANTS - 1]!;
    await expect(joinGroupCall(overflow.userId, overflow.deviceId, group.conversationId, callId)).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
  });

  it('leaving shrinks the roster, and the call auto-ends once everyone has left', async () => {
    const { admin, others, group } = await setupGroup(3);
    const callId = crypto.randomUUID();

    await startGroupCall(admin.userId, admin.deviceId, group.conversationId, callId);
    await joinGroupCall(others[0]!.userId, others[0]!.deviceId, group.conversationId, callId);

    await leaveGroupCall(others[0]!.userId, others[0]!.deviceId, group.conversationId, callId);
    let roster = await getGroupCallRoster(admin.userId, group.conversationId, callId);
    expect(roster).toHaveLength(1);

    let call = await prisma.call.findUniqueOrThrow({ where: { id: callId } });
    expect(call.endedAt).toBeNull(); // one person's left, but the admin is still on it

    await leaveGroupCall(admin.userId, admin.deviceId, group.conversationId, callId);
    roster = await getGroupCallRoster(admin.userId, group.conversationId, callId);
    expect(roster).toHaveLength(0);

    call = await prisma.call.findUniqueOrThrow({ where: { id: callId } });
    expect(call.endedAt).not.toBeNull();
  });

  it('a group call history entry carries groupName, not otherUser (the fixed listCallHistory branch)', async () => {
    const { admin, group } = await setupGroup(2);
    const callId = crypto.randomUUID();
    await startGroupCall(admin.userId, admin.deviceId, group.conversationId, callId);

    const history = await listCallHistory(admin.userId, 10);
    const entry = history.find((h) => h.id === callId);
    expect(entry).toBeDefined();
    expect(entry?.groupName).toBe('Group call test');
    expect(entry?.otherUser).toBeNull();
  });

  it('a peer-signal relay target must genuinely be a conversation member holding that exact device', async () => {
    const { admin, others, group } = await setupGroup(3);
    const [memberA, memberB] = others;
    const outsider = await makeMember('Outsider device');

    // Valid: memberA relaying to memberB, a real fellow member holding the device id claimed.
    await expect(
      assertValidGroupCallTarget(memberA!.userId, group.conversationId, memberB!.userId, memberB!.deviceId),
    ).resolves.toBeUndefined();

    // Invalid: targetDeviceId doesn't actually belong to targetUserId (a spoofed pairing).
    await expect(
      assertValidGroupCallTarget(memberA!.userId, group.conversationId, memberB!.userId, admin.deviceId),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });

    // Invalid: targetUserId isn't a member of this conversation at all.
    await expect(
      assertValidGroupCallTarget(memberA!.userId, group.conversationId, outsider.userId, outsider.deviceId),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });

    // Invalid: the CALLER isn't a member either.
    await expect(
      assertValidGroupCallTarget(outsider.userId, group.conversationId, memberB!.userId, memberB!.deviceId),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});
