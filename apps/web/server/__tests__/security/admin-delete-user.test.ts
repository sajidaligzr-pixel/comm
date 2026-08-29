import { describe, it, expect, afterAll } from 'vitest';
import { prisma } from '@comm/database';
import { adminDeleteUser } from '../../modules/admin/service';
import { createGroup } from '../../modules/groups/service';
import { registerDevice } from '../../modules/devices/service';
import { sendMessage } from '../../modules/messages/service';
import { createActiveUser, createAdminUser, fakeDeviceRegistration, deleteTestUser } from '../helpers';

/**
 * "Add option for the admin to delete a certain user. Make sure once that is
 * done delete all his chats from everywhere as well" — a direct request. See
 * adminDeleteUser's own docstring (admin/service.ts) for the exact disclosed
 * scope this exercises: every direct conversation the deleted account was part
 * of is gone entirely (both sides), while a group they belonged to keeps
 * existing for its other members — only the deleted account's own messages in
 * it are removed, not the whole group.
 */
describe('admin delete user', () => {
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

  const fakeEnvelope = { header: 'aGVhZGVy', ciphertext: 'Y2lwaGVydGV4dA==' };

  it('rejects a userId that is not actually an admin (defense in depth, not just the route)', async () => {
    const notAdmin = await makeMember('Not an admin');
    const target = await makeMember('Target');

    await expect(adminDeleteUser(notAdmin.userId, target.userId)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('refuses to delete yourself through this path', async () => {
    const admin = await createAdminUser();
    createdUserIds.push(admin.userId);

    await expect(adminDeleteUser(admin.userId, admin.userId)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('refuses to delete another admin account', async () => {
    const admin = await createAdminUser();
    const otherAdmin = await createAdminUser();
    createdUserIds.push(admin.userId, otherAdmin.userId);

    await expect(adminDeleteUser(admin.userId, otherAdmin.userId)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('deletes every direct conversation the account was part of, entirely, for both sides', async () => {
    const admin = await createAdminUser();
    const alice = await makeMember('Alice');
    const bob = await makeMember('Bob');
    createdUserIds.push(admin.userId, alice.userId, bob.userId);

    const conversation = await prisma.conversation.create({
      data: { type: 'direct', members: { create: [{ userId: alice.userId }, { userId: bob.userId }] } },
    });
    const messageId = crypto.randomUUID();
    await sendMessage({ userId: alice.userId, deviceId: alice.deviceId }, conversation.id, {
      messageId,
      envelopeType: 'x3dh_ratchet_1to1',
      recipients: [{ deviceId: bob.deviceId, envelope: fakeEnvelope, x3dhInit: null }],
      contentTypeHint: 'text',
      replyToMessageId: null,
      sentAt: new Date().toISOString(),
    });

    await adminDeleteUser(admin.userId, alice.userId);

    // The conversation itself, its message, and every relation cascading from
    // that message (MessageRecipient, MessageHistoryEntry) are gone — not
    // tombstoned, actually gone, since a direct conversation IS just the two of
    // them and there's no "other side" left with an independent reason to keep it.
    expect(await prisma.conversation.findUnique({ where: { id: conversation.id } })).toBeNull();
    expect(await prisma.message.findUnique({ where: { id: messageId } })).toBeNull();
  });

  it('removes the account from a group and tombstones only ITS OWN messages — the group and other members’ messages survive', async () => {
    const admin = await createAdminUser();
    const alice = await makeMember('Alice (leaving)');
    const bob = await makeMember('Bob (staying)');
    createdUserIds.push(admin.userId, alice.userId, bob.userId);

    const group = await createGroup(alice.userId, 'Group survives deletion', undefined, [bob.username]);
    createdGroupIds.push(group.id);

    const aliceMessageId = crypto.randomUUID();
    await sendMessage({ userId: alice.userId, deviceId: alice.deviceId }, group.conversationId, {
      messageId: aliceMessageId,
      envelopeType: 'megolm_group',
      envelope: fakeEnvelope,
      x3dhInit: null,
      contentTypeHint: 'text',
      replyToMessageId: null,
      sentAt: new Date().toISOString(),
    });
    const bobMessageId = crypto.randomUUID();
    await sendMessage({ userId: bob.userId, deviceId: bob.deviceId }, group.conversationId, {
      messageId: bobMessageId,
      envelopeType: 'megolm_group',
      envelope: fakeEnvelope,
      x3dhInit: null,
      contentTypeHint: 'text',
      replyToMessageId: null,
      sentAt: new Date().toISOString(),
    });
    // Alice's own personal history-sync cache of Bob's message — represents what
    // adminDeleteUser must ALSO clear even though Bob's own message stays intact.
    await prisma.messageHistoryEntry.create({
      data: { messageId: bobMessageId, userId: alice.userId, ciphertext: Buffer.from('fake') },
    });

    await adminDeleteUser(admin.userId, alice.userId);

    // The group itself is untouched.
    expect(await prisma.group.findUnique({ where: { id: group.id } })).not.toBeNull();

    // Alice's own message: tombstoned, not hard-deleted (consistent with every
    // other deletion path in this app), reason distinguishes it from a manual delete.
    const aliceMessage = await prisma.message.findUniqueOrThrow({ where: { id: aliceMessageId } });
    expect(aliceMessage.deletedAt).not.toBeNull();
    expect(aliceMessage.deletionReason).toBe('account_deleted');
    expect(aliceMessage.ciphertext).toBeNull();

    // Bob's own message: completely untouched — not "his chat" to delete.
    const bobMessage = await prisma.message.findUniqueOrThrow({ where: { id: bobMessageId } });
    expect(bobMessage.deletedAt).toBeNull();
    expect(bobMessage.ciphertext).not.toBeNull();

    // Alice's membership is gone; Bob's is untouched.
    const aliceMembership = await prisma.groupMember.findUnique({
      where: { groupId_userId: { groupId: group.id, userId: alice.userId } },
    });
    expect(aliceMembership?.removedAt).not.toBeNull();
    const bobMembership = await prisma.groupMember.findUnique({
      where: { groupId_userId: { groupId: group.id, userId: bob.userId } },
    });
    expect(bobMembership?.removedAt).toBeNull();

    // Alice's own history-sync cache is cleared, even for a message (Bob's) that
    // itself was left alone.
    expect(
      await prisma.messageHistoryEntry.findUnique({
        where: { messageId_userId: { messageId: bobMessageId, userId: alice.userId } },
      }),
    ).toBeNull();
  });

  it('soft-deletes the account itself the same way self-service deletion does', async () => {
    const admin = await createAdminUser();
    const target = await makeMember('To be deleted');
    createdUserIds.push(admin.userId, target.userId);

    await adminDeleteUser(admin.userId, target.userId);

    const user = await prisma.user.findUniqueOrThrow({ where: { id: target.userId } });
    expect(user.status).toBe('deleted');
    expect(user.passwordHash).toBeNull();

    const device = await prisma.device.findUniqueOrThrow({ where: { id: target.deviceId } });
    expect(device.status).toBe('revoked');
    expect(device.revokedReason).toBe('admin');
  });
});
