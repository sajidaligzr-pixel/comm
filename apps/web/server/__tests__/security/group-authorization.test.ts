import { describe, it, expect, afterAll } from 'vitest';
import { prisma } from '@comm/database';
import { createGroup, getGroupMemberDeviceTargets } from '../../modules/groups/service';
import { getAllOtherMembersActiveDeviceIds } from '../../modules/conversations/service';
import { registerDevice } from '../../modules/devices/service';
import { sendMessage, acknowledgeDelivered, markConversationRead, getMessageReceipts, listMessages } from '../../modules/messages/service';
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

  /**
   * "Seen by" (docs/13-roadmap.md) — a pure read path over `MessageRecipient`
   * rows the group-chat pass already writes on every send/ack; this is the
   * first test that actually exercises it end to end: one member acks
   * delivered+read, another does neither, and `getMessageReceipts` must report
   * each correctly, scoped to real group membership.
   */
  it('"seen by" resolves delivered/read per group member from real MessageRecipient rows', async () => {
    const { admin, others, group } = await setupGroup(3);
    const [reader, silent] = others;

    const messageId = crypto.randomUUID();
    await sendMessage(
      { userId: admin.userId, deviceId: admin.deviceId },
      group.conversationId,
      {
        messageId,
        envelopeType: 'megolm_group',
        envelope: { header: 'aGVhZGVy', ciphertext: 'Y2lwaGVydGV4dA==' },
        x3dhInit: null,
        contentTypeHint: 'text',
        replyToMessageId: null,
        sentAt: new Date().toISOString(),
      },
    );

    await acknowledgeDelivered(reader!.deviceId, messageId);
    await markConversationRead(reader!.userId, group.conversationId, messageId);

    const receipts = await getMessageReceipts(admin.userId, messageId);
    const byUser = new Map(receipts.map((r) => [r.userId, r]));
    expect(byUser.get(reader!.userId)?.readAt).toBeTruthy();
    expect(byUser.get(reader!.userId)?.deliveredAt).toBeTruthy();
    expect(byUser.get(silent!.userId)?.readAt).toBeFalsy();
    expect(byUser.get(silent!.userId)?.deliveredAt).toBeFalsy();

    const outsider = await makeMember('Outsider device');
    await expect(getMessageReceipts(outsider.userId, messageId)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  /**
   * The group counterpart of messaging.test.ts's direct-conversation multi-device
   * fan-out test — a group message now reaches every active device of every
   * member, including the SENDER's own other devices, not just one primary device
   * per other member and never the sender's own (see docs/06-device-architecture.md).
   * Unlike direct messages, group messages share one Message-level envelope
   * regardless of device count, so this only has to check who gets a
   * `MessageRecipient` row, not that each got its own distinct ciphertext.
   */
  it('a group message reaches every OTHER-member device AND every OTHER device the sender owns', async () => {
    const { admin, others, group } = await setupGroup(3); // admin + 2 others

    const adminDevice2 = await registerDevice(prisma, admin.userId, fakeDeviceRegistration('Admin second device'));
    const memberDevice2 = await registerDevice(prisma, others[0]!.userId, fakeDeviceRegistration('Member second device'));

    const messageId = crypto.randomUUID();
    const sent = await sendMessage(
      { userId: admin.userId, deviceId: admin.deviceId },
      group.conversationId,
      {
        messageId,
        envelopeType: 'megolm_group',
        envelope: { header: 'aGVhZGVy', ciphertext: 'Y2lwaGVydGV4dA==' },
        x3dhInit: null,
        contentTypeHint: 'text',
        replyToMessageId: null,
        sentAt: new Date().toISOString(),
      },
    );

    const targetDeviceIds = new Set(sent.map((m) => m.recipientDeviceId));
    // The other 2 members' primary devices + the admin's OWN second device +
    // the one other member's second device — every active device, every member.
    expect(targetDeviceIds.has(others[0]!.deviceId)).toBe(true);
    expect(targetDeviceIds.has(others[1]!.deviceId)).toBe(true);
    expect(targetDeviceIds.has(adminDevice2.deviceId)).toBe(true);
    expect(targetDeviceIds.has(memberDevice2.deviceId)).toBe(true);
    // Never addressed back to the sender's OWN sending device — same as direct.
    expect(targetDeviceIds.has(admin.deviceId)).toBe(false);

    // The admin's second device sees it via its own catch-up fetch too.
    const admin2Page = await listMessages(admin.userId, adminDevice2.deviceId, group.conversationId, undefined, 10);
    expect(admin2Page.items.map((m) => m.id)).toContain(messageId);
  });

  it('"seen by" refuses a 1:1 message — WhatsApp only ever shows this for groups', async () => {
    const admin = await makeMember('Solo device 1');
    const other = await makeMember('Solo device 2');
    const conversation = await prisma.conversation.create({
      data: { type: 'direct', members: { create: [{ userId: admin.userId }, { userId: other.userId }] } },
    });

    const messageId = crypto.randomUUID();
    await sendMessage(
      { userId: admin.userId, deviceId: admin.deviceId },
      conversation.id,
      {
        messageId,
        envelopeType: 'x3dh_ratchet_1to1',
        recipients: [{ deviceId: other.deviceId, envelope: { header: 'aGVhZGVy', ciphertext: 'Y2lwaGVydGV4dA==' }, x3dhInit: null }],
        contentTypeHint: 'text',
        replyToMessageId: null,
        sentAt: new Date().toISOString(),
      },
    );

    await expect(getMessageReceipts(admin.userId, messageId)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });
});
