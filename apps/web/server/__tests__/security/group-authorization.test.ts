import { describe, it, expect, afterAll } from 'vitest';
import { prisma } from '@comm/database';
import { createGroup, getGroupMemberDeviceTargets } from '../../modules/groups/service';
import { getAllOtherMembersActiveDeviceIds } from '../../modules/conversations/service';
import { registerDevice } from '../../modules/devices/service';
import { createActiveUser, deleteTestUser, fakeDeviceRegistration } from '../helpers';

/**
 * Regression coverage for two real bugs found via live testing during the
 * post-group-chat security review (docs/13-roadmap.md):
 *
 * 1. `GET /groups/:id/member-devices` never checked that the caller was actually a
 *    current member before returning every other member's userId + deviceId — any
 *    authenticated user (or a just-removed former member) could enumerate a private
 *    group's membership and device ids. Fixed in `getGroupMemberDeviceTargets`.
 * 2. Read receipts, typing indicators, and delete-for-everyone only ever reached ONE
 *    other conversation member (`getOtherMemberActiveDeviceIds`'s `findFirst`) — a
 *    direct-conversation-only assumption from before groups existed, never
 *    generalized when groups shipped. In a 3+-person group, only one of the other
 *    members would ever get these live events. Fixed by
 *    `getAllOtherMembersActiveDeviceIds`, which this suite checks fans out to every
 *    other member, not just the first one found.
 */
describe('group authorization', () => {
  const createdUserIds: string[] = [];
  const createdGroupIds: string[] = [];

  afterAll(async () => {
    // Groups aren't cascade-deleted just by deleting their members (a `Group` isn't
    // itself FK-owned by any one user) — delete explicitly first, which cascades to
    // its Conversation/ConversationMembers/GroupMembers/GroupSessions/GroupKeyShares.
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

    const group = await createGroup(
      admin.userId,
      'Security review test group',
      undefined,
      others.map((m) => m.username),
    );
    createdGroupIds.push(group.id);

    return { admin, others, group };
  }

  it('rejects a non-member from listing a group\'s member devices (the fixed IDOR)', async () => {
    const { group } = await setupGroup(2);
    const outsider = await makeMember('Outsider device');

    await expect(getGroupMemberDeviceTargets(group.id, outsider.userId)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('still lets a genuine member list the OTHER members\' devices', async () => {
    const { admin, others, group } = await setupGroup(3);

    const targets = await getGroupMemberDeviceTargets(group.id, admin.userId);
    expect(targets).toHaveLength(others.length);
    expect(new Set(targets.map((t) => t.deviceId))).toEqual(new Set(others.map((o) => o.deviceId)));
  });

  it('a removed former member can no longer list the group\'s member devices either', async () => {
    const { admin, group } = await setupGroup(2);
    const secondMember = await makeMember('Removed member device'); // added then removed below
    await prisma.groupMember.create({ data: { groupId: group.id, userId: secondMember.userId, role: 'member' } });
    await prisma.conversationMember.create({
      data: { conversationId: group.conversationId, userId: secondMember.userId },
    });
    // Remove them the same way removeGroupMember does: drop ConversationMember,
    // mark GroupMember.removedAt — requireConversationMembership is what this test
    // is really exercising, via getGroupMemberDeviceTargets's own gate.
    await prisma.conversationMember.delete({
      where: { conversationId_userId: { conversationId: group.conversationId, userId: secondMember.userId } },
    });
    await prisma.groupMember.update({
      where: { groupId_userId: { groupId: group.id, userId: secondMember.userId } },
      data: { removedAt: new Date() },
    });

    await expect(getGroupMemberDeviceTargets(group.id, secondMember.userId)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    void admin; // setup member unused directly beyond group creation above
  });

  it('fans read/typing/delete events out to EVERY other group member, not just one (the fixed fan-out gap)', async () => {
    const { admin, others, group } = await setupGroup(4); // admin + 3 others

    const fannedOut = await getAllOtherMembersActiveDeviceIds(group.conversationId, admin.userId);
    expect(fannedOut).toHaveLength(others.length);
    expect(new Set(fannedOut.map((d) => d.userId))).toEqual(new Set(others.map((o) => o.userId)));

    // And from a non-admin member's perspective, it correctly excludes only
    // themselves, not everyone else.
    const fromOneMember = await getAllOtherMembersActiveDeviceIds(group.conversationId, others[0]!.userId);
    expect(fromOneMember).toHaveLength(others.length); // admin + the other 2 members
    expect(fromOneMember.some((d) => d.userId === others[0]!.userId)).toBe(false);
  });

  it('rejects a non-member calling the fan-out helper directly too', async () => {
    const { group } = await setupGroup(2);
    const outsider = await makeMember('Outsider device');

    await expect(getAllOtherMembersActiveDeviceIds(group.conversationId, outsider.userId)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});
