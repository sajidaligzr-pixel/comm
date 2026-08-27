import { describe, it, expect, afterAll } from 'vitest';
import { prisma } from '@comm/database';
import { getUserHistoryKey, createUserHistoryKeyIfAbsent, writeMessageHistoryEntry } from '../../modules/history/service';
import { sendMessage, listMessages } from '../../modules/messages/service';
import { createOrGetDirectConversation } from '../../modules/conversations/service';
import { registerDevice } from '../../modules/devices/service';
import { createActiveUser, fakeDeviceRegistration, deleteTestUser } from '../helpers';

/**
 * Multi-device message HISTORY sync (docs/07-auth-architecture.md's history-key
 * section) — "log in anywhere, see your full message history, like WhatsApp."
 * Covers the three real properties this needs: the account-level key is
 * create-once (a race between two devices never produces two different keys),
 * writing a history entry is gated to real conversation membership (not a
 * message-id-guessing IDOR), and `listMessages`/`sendMessage`'s DTOs actually
 * surface the caller's own entry once one exists.
 */
describe('multi-device message history sync', () => {
  const createdUserIds: string[] = [];
  afterAll(async () => {
    await Promise.all(createdUserIds.map(deleteTestUser));
  });

  it('has no history key until one is created, then fetches exactly what was created', async () => {
    const { userId } = await createActiveUser();
    createdUserIds.push(userId);

    expect(await getUserHistoryKey(userId)).toBeNull();

    const wrappedKey = Buffer.from('fake-wrapped-key');
    const salt = Buffer.from('fake-salt');
    const created = await createUserHistoryKeyIfAbsent(userId, wrappedKey, salt);
    expect(created.wrappedKey).toBe(wrappedKey.toString('base64'));

    const fetched = await getUserHistoryKey(userId);
    expect(fetched).toEqual(created);
  });

  it('a concurrent create race never produces two different keys — the loser adopts the winner\'s', async () => {
    const { userId } = await createActiveUser();
    createdUserIds.push(userId);

    const [a, b] = await Promise.all([
      createUserHistoryKeyIfAbsent(userId, Buffer.from('device-a-key'), Buffer.from('device-a-salt')),
      createUserHistoryKeyIfAbsent(userId, Buffer.from('device-b-key'), Buffer.from('device-b-salt')),
    ]);
    // Both calls must resolve to the SAME canonical row, whichever one actually won.
    expect(a).toEqual(b);

    const rows = await prisma.userHistoryKey.findMany({ where: { userId } });
    expect(rows).toHaveLength(1); // never two rows for one account
  });

  it('refuses to write a history entry for a message outside the caller\'s own conversations', async () => {
    const alice = await createActiveUser();
    const bob = await createActiveUser();
    const outsider = await createActiveUser();
    createdUserIds.push(alice.userId, bob.userId, outsider.userId);

    const conversation = await createOrGetDirectConversation(alice.userId, bob.username);
    const { deviceId: aliceDeviceId } = await registerDevice(prisma, alice.userId, fakeDeviceRegistration('Alice device'));
    await registerDevice(prisma, bob.userId, fakeDeviceRegistration('Bob device'));
    const messageId = crypto.randomUUID();
    await prisma.message.create({
      data: {
        id: messageId,
        conversationId: conversation.id,
        senderUserId: alice.userId,
        senderDeviceId: aliceDeviceId,
        envelopeType: 'x3dh_ratchet_1to1',
        contentTypeHint: 'text',
        sentAt: new Date(),
      },
    });

    await expect(
      writeMessageHistoryEntry(outsider.userId, messageId, Buffer.from('irrelevant')),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    // A genuine participant can, though — sanity check the happy path in the same test.
    await writeMessageHistoryEntry(bob.userId, messageId, Buffer.from('bobs-history-copy'));
    const row = await prisma.messageHistoryEntry.findUnique({ where: { messageId_userId: { messageId, userId: bob.userId } } });
    expect(row?.ciphertext.toString()).toBe('bobs-history-copy');
  });

  it('listMessages surfaces the caller\'s own history entry once written, null before that', async () => {
    const alice = await createActiveUser();
    const bob = await createActiveUser();
    createdUserIds.push(alice.userId, bob.userId);

    const conversation = await createOrGetDirectConversation(alice.userId, bob.username);
    const { deviceId: aliceDeviceId } = await registerDevice(prisma, alice.userId, fakeDeviceRegistration('Alice device'));
    const { deviceId: bobDeviceId } = await registerDevice(prisma, bob.userId, fakeDeviceRegistration('Bob device'));

    const messageId = crypto.randomUUID();
    await sendMessage(
      { userId: alice.userId, deviceId: aliceDeviceId },
      conversation.id,
      {
        messageId,
        envelopeType: 'x3dh_ratchet_1to1',
        recipients: [{ deviceId: bobDeviceId, envelope: { header: 'aGVhZGVy', ciphertext: 'Y2lwaGVydGV4dA==' }, x3dhInit: null }],
        contentTypeHint: 'text',
        replyToMessageId: null,
        sentAt: new Date().toISOString(),
      },
    );

    const before = await listMessages(bob.userId, bobDeviceId, conversation.id, undefined, 10);
    expect(before.items.find((m) => m.id === messageId)?.history).toBeNull();

    await writeMessageHistoryEntry(bob.userId, messageId, Buffer.from('bobs-history-copy'));

    const after = await listMessages(bob.userId, bobDeviceId, conversation.id, undefined, 10);
    const dto = after.items.find((m) => m.id === messageId);
    expect(dto?.history?.ciphertext).toBe(Buffer.from('bobs-history-copy').toString('base64'));

    // Alice's own history entry is still null — one account's entry never leaks
    // into another's DTO.
    const aliceView = await listMessages(alice.userId, aliceDeviceId, conversation.id, undefined, 10);
    expect(aliceView.items.find((m) => m.id === messageId)?.history).toBeNull();
  });
});
