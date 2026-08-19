import { describe, it, expect, afterAll } from 'vitest';
import { prisma } from '@comm/database';
import {
  generateIdentityKeyPair,
  generateSignedPreKey,
  generateOneTimePreKeys,
  createOutboundSession,
  encryptMessage,
  bytesToBase64,
  type PublicKeyBundle,
} from '@comm/crypto';
import type { NewDeviceRegistration, SendMessageRequest } from '@comm/types';
import { registerDevice } from '../modules/devices/service';
import { createOrGetDirectConversation, requireConversationMembership, getConversation } from '../modules/conversations/service';
import {
  sendMessage,
  listMessages,
  deleteMessage,
  markConversationRead,
  starMessage,
  unstarMessage,
  listStarredMessages,
} from '../modules/messages/service';
import { getKeyBundle } from '../modules/keys/service';
import { createActiveUser, deleteTestUser } from './helpers';

/**
 * End-to-end through the REAL crypto stack (@comm/crypto), not the random-bytes
 * `fakeDeviceRegistration` helper other Phase 2 tests use — this is specifically
 * exercising "does a real X3DH+Double-Ratchet-encrypted message survive the actual
 * server ingest/storage/retrieval path and come back out as the same ciphertext,"
 * which none of the auth-focused tests cover.
 */
function realDeviceRegistration(name: string) {
  const identity = generateIdentityKeyPair();
  const signedPreKey = generateSignedPreKey(identity.signing.privateKey, 1);
  const oneTimePreKeys = generateOneTimePreKeys(3, 1);

  const registration: NewDeviceRegistration = {
    name,
    deviceType: 'web',
    keyBundle: {
      identityKey: {
        signingPublicKey: bytesToBase64(identity.signing.publicKey),
        agreementPublicKey: bytesToBase64(identity.agreement.publicKey),
      },
      signedPreKey: {
        keyId: signedPreKey.keyId,
        publicKey: bytesToBase64(signedPreKey.keyPair.publicKey),
        signature: bytesToBase64(signedPreKey.signature),
      },
      oneTimePreKeys: oneTimePreKeys.map((k) => ({ keyId: k.keyId, publicKey: bytesToBase64(k.keyPair.publicKey) })),
    },
  };

  return { identity, registration };
}

describe('messaging (real crypto end-to-end)', () => {
  const createdUserIds: string[] = [];
  afterAll(async () => {
    await Promise.all(createdUserIds.map(deleteTestUser));
  });

  async function setupConversation() {
    const alice = await createActiveUser();
    const bob = await createActiveUser();
    createdUserIds.push(alice.userId, bob.userId);

    const aliceDevice = realDeviceRegistration('Alice device');
    const bobDevice = realDeviceRegistration('Bob device');
    const { deviceId: aliceDeviceId } = await registerDevice(prisma, alice.userId, aliceDevice.registration);
    const { deviceId: bobDeviceId } = await registerDevice(prisma, bob.userId, bobDevice.registration);

    const conversation = await createOrGetDirectConversation(alice.userId, bob.username);

    return { alice, bob, aliceDevice, bobDevice, aliceDeviceId, bobDeviceId, conversation };
  }

  it('a real X3DH+Double-Ratchet-encrypted message round-trips through send → store → retrieve', async () => {
    const { alice, bob, aliceDevice, aliceDeviceId, bobDeviceId, conversation } = await setupConversation();

    // Alice fetches Bob's real key bundle via the same service the API route uses.
    const bundle = await getKeyBundle(bob.userId, bobDeviceId);
    const publicBundle: PublicKeyBundle = {
      identityAgreementKey: Buffer.from(bundle.identityKey.agreementPublicKey, 'base64'),
      identitySigningKey: Buffer.from(bundle.identityKey.signingPublicKey, 'base64'),
      signedPreKeyId: bundle.signedPreKey.keyId,
      signedPreKeyPublic: Buffer.from(bundle.signedPreKey.publicKey, 'base64'),
      signedPreKeySignature: Buffer.from(bundle.signedPreKey.signature, 'base64'),
      oneTimePreKeyId: bundle.oneTimePreKey?.keyId ?? null,
      oneTimePreKeyPublic: bundle.oneTimePreKey ? Buffer.from(bundle.oneTimePreKey.publicKey, 'base64') : null,
    };

    const { session, x3dhInit } = createOutboundSession(aliceDevice.identity, publicBundle);
    const plaintext = new TextEncoder().encode('hey bob, this is a real E2E encrypted message');
    const envelope = encryptMessage(session, plaintext);

    const messageId = crypto.randomUUID();
    const request: SendMessageRequest = {
      messageId,
      envelopeType: 'x3dh_ratchet_1to1',
      recipients: [{ deviceId: bobDeviceId, envelope, x3dhInit }],
      contentTypeHint: 'text',
      replyToMessageId: null,
      sentAt: new Date().toISOString(),
    };

    // One MessageDto per target device (multi-device fan-out) — Bob only has one
    // active device here, so exactly one.
    const sent = await sendMessage({ userId: alice.userId, deviceId: aliceDeviceId }, conversation.id, request);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.id).toBe(messageId);

    // The server-stored row is genuinely opaque ciphertext — assert directly against
    // the database, not just the service's own return value. `direct` messages now
    // carry their ciphertext on the per-recipient row, not `Message` itself (see
    // messages/service.ts's module docstring) — the `Message` row's own columns stay
    // null for a `direct` send.
    const row = await prisma.message.findUniqueOrThrow({ where: { id: messageId } });
    expect(row.ciphertext).toBeNull();
    const recipientRow = await prisma.messageRecipient.findUniqueOrThrow({
      where: { messageId_recipientDeviceId: { messageId, recipientDeviceId: bobDeviceId } },
    });
    expect(recipientRow.ciphertext).toBeTruthy();
    const storedAsString = recipientRow.ciphertext!.toString('utf8');
    expect(storedAsString).not.toContain('hey bob');
    expect(storedAsString).not.toContain('real E2E');

    const page = await listMessages(bob.userId, bobDeviceId, conversation.id, undefined, 10);
    expect(page.items).toHaveLength(1);
    expect(page.items[0]!.id).toBe(messageId);
    expect(page.items[0]!.envelope.ciphertext).toBe(envelope.ciphertext);
  });

  it('multi-device fan-out: a message reaches every OTHER-member device AND every OTHER device the sender owns', async () => {
    const { alice, bob, aliceDevice, aliceDeviceId, bobDeviceId, conversation } = await setupConversation();

    // A second device each for Alice (sender) and Bob (recipient) — real
    // multi-device sync means both need their own independently-encrypted copy.
    const aliceDevice2 = realDeviceRegistration('Alice second device');
    const bobDevice2 = realDeviceRegistration('Bob second device');
    const { deviceId: aliceDeviceId2 } = await registerDevice(prisma, alice.userId, aliceDevice2.registration);
    const { deviceId: bobDeviceId2 } = await registerDevice(prisma, bob.userId, bobDevice2.registration);

    async function encryptFor(targetUserId: string, targetDeviceId: string) {
      const bundle = await getKeyBundle(targetUserId, targetDeviceId);
      const publicBundle: PublicKeyBundle = {
        identityAgreementKey: Buffer.from(bundle.identityKey.agreementPublicKey, 'base64'),
        identitySigningKey: Buffer.from(bundle.identityKey.signingPublicKey, 'base64'),
        signedPreKeyId: bundle.signedPreKey.keyId,
        signedPreKeyPublic: Buffer.from(bundle.signedPreKey.publicKey, 'base64'),
        signedPreKeySignature: Buffer.from(bundle.signedPreKey.signature, 'base64'),
        oneTimePreKeyId: bundle.oneTimePreKey?.keyId ?? null,
        oneTimePreKeyPublic: bundle.oneTimePreKey ? Buffer.from(bundle.oneTimePreKey.publicKey, 'base64') : null,
      };
      const { session, x3dhInit } = createOutboundSession(aliceDevice.identity, publicBundle);
      const envelope = encryptMessage(session, new TextEncoder().encode(`for device ${targetDeviceId}`));
      return { envelope, x3dhInit };
    }

    const forBob1 = await encryptFor(bob.userId, bobDeviceId);
    const forBob2 = await encryptFor(bob.userId, bobDeviceId2);
    const forAlice2 = await encryptFor(alice.userId, aliceDeviceId2);

    const messageId = crypto.randomUUID();
    const sent = await sendMessage(
      { userId: alice.userId, deviceId: aliceDeviceId },
      conversation.id,
      {
        messageId,
        envelopeType: 'x3dh_ratchet_1to1',
        recipients: [
          { deviceId: bobDeviceId, envelope: forBob1.envelope, x3dhInit: forBob1.x3dhInit },
          { deviceId: bobDeviceId2, envelope: forBob2.envelope, x3dhInit: forBob2.x3dhInit },
          { deviceId: aliceDeviceId2, envelope: forAlice2.envelope, x3dhInit: forAlice2.x3dhInit },
        ],
        contentTypeHint: 'text',
        replyToMessageId: null,
        sentAt: new Date().toISOString(),
      },
    );

    // One MessageDto per target device — every other-member device AND the
    // sender's own other device, not just whichever one was "most recently active."
    expect(sent).toHaveLength(3);
    const byDevice = new Map(sent.map((m) => [m.recipientDeviceId, m]));
    expect(byDevice.get(bobDeviceId)!.envelope.ciphertext).toBe(forBob1.envelope.ciphertext);
    expect(byDevice.get(bobDeviceId2)!.envelope.ciphertext).toBe(forBob2.envelope.ciphertext);
    expect(byDevice.get(aliceDeviceId2)!.envelope.ciphertext).toBe(forAlice2.envelope.ciphertext);
    // Each device pairing got its OWN distinct ciphertext, not one shared blob —
    // the whole reason this needed its own per-recipient columns.
    expect(byDevice.get(bobDeviceId)!.envelope.ciphertext).not.toBe(byDevice.get(bobDeviceId2)!.envelope.ciphertext);

    // Bob's second device sees this message in its own catch-up fetch too —
    // listMessages isn't just reading the DTO the send call happened to return.
    const bob2Page = await listMessages(bob.userId, bobDeviceId2, conversation.id, undefined, 10);
    expect(bob2Page.items.map((m) => m.id)).toContain(messageId);
  });

  it('rejects sending to a device that is not part of the conversation (IDOR)', async () => {
    const { alice, aliceDeviceId, aliceDevice, conversation } = await setupConversation();
    const outsider = await createActiveUser();
    createdUserIds.push(outsider.userId);
    const outsiderDevice = realDeviceRegistration('Outsider device');
    const { deviceId: outsiderDeviceId } = await registerDevice(prisma, outsider.userId, outsiderDevice.registration);

    const bundle = await getKeyBundle(outsider.userId, outsiderDeviceId);
    const publicBundle: PublicKeyBundle = {
      identityAgreementKey: Buffer.from(bundle.identityKey.agreementPublicKey, 'base64'),
      identitySigningKey: Buffer.from(bundle.identityKey.signingPublicKey, 'base64'),
      signedPreKeyId: bundle.signedPreKey.keyId,
      signedPreKeyPublic: Buffer.from(bundle.signedPreKey.publicKey, 'base64'),
      signedPreKeySignature: Buffer.from(bundle.signedPreKey.signature, 'base64'),
      oneTimePreKeyId: bundle.oneTimePreKey?.keyId ?? null,
      oneTimePreKeyPublic: bundle.oneTimePreKey ? Buffer.from(bundle.oneTimePreKey.publicKey, 'base64') : null,
    };
    const { session, x3dhInit } = createOutboundSession(aliceDevice.identity, publicBundle);
    const envelope = encryptMessage(session, new TextEncoder().encode('leaking into the wrong conversation'));

    // The target device set is now resolved server-side, never trusted from the
    // client (see sendMessage's own docstring) — an outsider's device simply isn't
    // in that set, so it's silently dropped rather than individually rejected; with
    // zero valid targets left, this is indistinguishable from "nobody reachable,"
    // the same MESSAGE_FAILED a legitimate all-offline conversation would get. That
    // is the point: an attacker attempting this IDOR learns nothing about whether
    // outsiderDeviceId exists, belongs to someone, or is just offline.
    await expect(
      sendMessage(
        { userId: alice.userId, deviceId: aliceDeviceId },
        conversation.id,
        {
          messageId: crypto.randomUUID(),
          envelopeType: 'x3dh_ratchet_1to1',
          recipients: [{ deviceId: outsiderDeviceId, envelope, x3dhInit }],
          contentTypeHint: 'text',
          replyToMessageId: null,
          sentAt: new Date().toISOString(),
        },
      ),
    ).rejects.toMatchObject({ code: 'MESSAGE_FAILED' });
  });

  it('rejects a non-member from reading conversation history', async () => {
    const { conversation } = await setupConversation();
    const outsider = await createActiveUser();
    createdUserIds.push(outsider.userId);

    await expect(listMessages(outsider.userId, 'irrelevant', conversation.id, undefined, 10)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(requireConversationMembership(outsider.userId, conversation.id)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  /**
   * Reactions (docs/13-roadmap.md) are ordinary `Message` rows with
   * `contentTypeHint: 'reaction'` — sendMessage/listMessages never special-case
   * them at all (see lib/message-content.ts's module docstring). The one place
   * that DOES need to treat them differently is `toSummary` (server/modules/
   * conversations/service.ts): a reaction is a control message, not content, so
   * it must never bump a conversation's `unreadCount` or `lastMessageAt` the way
   * a real message does — this is the test for that exclusion.
   */
  it('reacting to a message does not bump the conversation unread count or lastMessageAt', async () => {
    const { alice, bob, aliceDevice, aliceDeviceId, bobDeviceId, conversation } = await setupConversation();

    async function encryptFor(text: string) {
      const bundle = await getKeyBundle(bob.userId, bobDeviceId);
      const publicBundle: PublicKeyBundle = {
        identityAgreementKey: Buffer.from(bundle.identityKey.agreementPublicKey, 'base64'),
        identitySigningKey: Buffer.from(bundle.identityKey.signingPublicKey, 'base64'),
        signedPreKeyId: bundle.signedPreKey.keyId,
        signedPreKeyPublic: Buffer.from(bundle.signedPreKey.publicKey, 'base64'),
        signedPreKeySignature: Buffer.from(bundle.signedPreKey.signature, 'base64'),
        oneTimePreKeyId: bundle.oneTimePreKey?.keyId ?? null,
        oneTimePreKeyPublic: bundle.oneTimePreKey ? Buffer.from(bundle.oneTimePreKey.publicKey, 'base64') : null,
      };
      const { session, x3dhInit } = createOutboundSession(aliceDevice.identity, publicBundle);
      return { envelope: encryptMessage(session, new TextEncoder().encode(text)), x3dhInit };
    }

    const real = await encryptFor('a real message worth a badge');
    const realMessageId = crypto.randomUUID();
    await sendMessage(
      { userId: alice.userId, deviceId: aliceDeviceId },
      conversation.id,
      {
        messageId: realMessageId,
        envelopeType: 'x3dh_ratchet_1to1',
        recipients: [{ deviceId: bobDeviceId, envelope: real.envelope, x3dhInit: real.x3dhInit }],
        contentTypeHint: 'text',
        replyToMessageId: null,
        sentAt: new Date().toISOString(),
      },
    );

    const before = await getConversation(bob.userId, conversation.id);
    expect(before.unreadCount).toBe(1);
    expect(before.lastMessageAt).not.toBeNull();

    const reaction = await encryptFor(JSON.stringify({ targetMessageId: realMessageId, emoji: '👍' }));
    await sendMessage(
      { userId: alice.userId, deviceId: aliceDeviceId },
      conversation.id,
      {
        messageId: crypto.randomUUID(),
        envelopeType: 'x3dh_ratchet_1to1',
        recipients: [{ deviceId: bobDeviceId, envelope: reaction.envelope, x3dhInit: reaction.x3dhInit }],
        contentTypeHint: 'reaction',
        replyToMessageId: null,
        sentAt: new Date().toISOString(),
      },
    );

    const after = await getConversation(bob.userId, conversation.id);
    expect(after.unreadCount).toBe(1); // still 1, not 2 — the reaction itself doesn't count
    expect(after.lastMessageAt).toBe(before.lastMessageAt); // still the real message, not the reaction

    // The reaction is still a genuine, retrievable Message row on the wire —
    // just excluded from summary metadata, not from delivery itself.
    const page = await listMessages(bob.userId, bobDeviceId, conversation.id, undefined, 10);
    const reactionDto = page.items.find((m) => m.contentTypeHint === 'reaction');
    expect(reactionDto).toBeDefined();
  });

  /**
   * Starring (docs/13-roadmap.md's pinned/starred pass) — a plain metadata
   * table, unlike reactions, since a star carries no content to protect (see
   * `StarredMessage`'s doc comment in schema.prisma). This covers the
   * authorization boundary `starMessage`/`unstarMessage` share with every other
   * message action: only an actual member of the message's conversation can
   * star it.
   */
  it('starring a message: only a member can star it, listStarredMessages returns it, unstarring removes it', async () => {
    const { alice, bob, aliceDevice, aliceDeviceId, bobDeviceId, conversation } = await setupConversation();

    const bundle = await getKeyBundle(bob.userId, bobDeviceId);
    const publicBundle: PublicKeyBundle = {
      identityAgreementKey: Buffer.from(bundle.identityKey.agreementPublicKey, 'base64'),
      identitySigningKey: Buffer.from(bundle.identityKey.signingPublicKey, 'base64'),
      signedPreKeyId: bundle.signedPreKey.keyId,
      signedPreKeyPublic: Buffer.from(bundle.signedPreKey.publicKey, 'base64'),
      signedPreKeySignature: Buffer.from(bundle.signedPreKey.signature, 'base64'),
      oneTimePreKeyId: bundle.oneTimePreKey?.keyId ?? null,
      oneTimePreKeyPublic: bundle.oneTimePreKey ? Buffer.from(bundle.oneTimePreKey.publicKey, 'base64') : null,
    };
    const { session, x3dhInit } = createOutboundSession(aliceDevice.identity, publicBundle);
    const envelope = encryptMessage(session, new TextEncoder().encode('worth remembering'));
    const messageId = crypto.randomUUID();
    await sendMessage(
      { userId: alice.userId, deviceId: aliceDeviceId },
      conversation.id,
      {
        messageId,
        envelopeType: 'x3dh_ratchet_1to1',
        recipients: [{ deviceId: bobDeviceId, envelope, x3dhInit }],
        contentTypeHint: 'text',
        replyToMessageId: null,
        sentAt: new Date().toISOString(),
      },
    );

    const outsider = await createActiveUser();
    createdUserIds.push(outsider.userId);
    await expect(starMessage(outsider.userId, messageId)).rejects.toMatchObject({ code: 'FORBIDDEN' });

    await starMessage(bob.userId, messageId);
    // Idempotent — starring an already-starred message is a no-op, not an error.
    await starMessage(bob.userId, messageId);

    const starred = await listStarredMessages(bob.userId);
    expect(starred).toHaveLength(1);
    expect(starred[0]).toMatchObject({ messageId, conversationId: conversation.id });

    // Alice's own star list is unaffected — starring is per-user.
    expect(await listStarredMessages(alice.userId)).toHaveLength(0);

    await unstarMessage(bob.userId, messageId);
    expect(await listStarredMessages(bob.userId)).toHaveLength(0);
  });

  it('deleting a message tombstones it: ciphertext is actually nulled, not just flagged', async () => {
    const { alice, bob, aliceDevice, aliceDeviceId, bobDeviceId, conversation } = await setupConversation();
    const bundle = await getKeyBundle(bob.userId, bobDeviceId);
    const publicBundle: PublicKeyBundle = {
      identityAgreementKey: Buffer.from(bundle.identityKey.agreementPublicKey, 'base64'),
      identitySigningKey: Buffer.from(bundle.identityKey.signingPublicKey, 'base64'),
      signedPreKeyId: bundle.signedPreKey.keyId,
      signedPreKeyPublic: Buffer.from(bundle.signedPreKey.publicKey, 'base64'),
      signedPreKeySignature: Buffer.from(bundle.signedPreKey.signature, 'base64'),
      oneTimePreKeyId: bundle.oneTimePreKey?.keyId ?? null,
      oneTimePreKeyPublic: bundle.oneTimePreKey ? Buffer.from(bundle.oneTimePreKey.publicKey, 'base64') : null,
    };
    const { session, x3dhInit } = createOutboundSession(aliceDevice.identity, publicBundle);
    const envelope = encryptMessage(session, new TextEncoder().encode('ephemeral-ish'));
    const messageId = crypto.randomUUID();

    await sendMessage(
      { userId: alice.userId, deviceId: aliceDeviceId },
      conversation.id,
      {
        messageId,
        envelopeType: 'x3dh_ratchet_1to1',
        recipients: [{ deviceId: bobDeviceId, envelope, x3dhInit }],
        contentTypeHint: 'text',
        replyToMessageId: null,
        sentAt: new Date().toISOString(),
      },
    );

    await deleteMessage(alice.userId, messageId);

    const row = await prisma.message.findUniqueOrThrow({ where: { id: messageId } });
    expect(row.deletedAt).not.toBeNull();
    expect(row.ciphertext).toBeNull();
    expect(row.envelopeHeader).toBeNull();

    // The per-recipient envelope (where this direct message's actual ciphertext
    // lives now) must be nulled too — leaving it live after "deleting" the message
    // would defeat the point of nulling Message's own columns above.
    const recipientRow = await prisma.messageRecipient.findUniqueOrThrow({
      where: { messageId_recipientDeviceId: { messageId, recipientDeviceId: bobDeviceId } },
    });
    expect(recipientRow.ciphertext).toBeNull();
    expect(recipientRow.envelopeHeader).toBeNull();
  });

  /**
   * View-once (docs/13-roadmap.md) — the one deleteMessage authorization
   * carve-out: a genuine RECIPIENT (never the sender-only path every other
   * content type uses) can self-tombstone a `view_once` message the instant
   * they open it, reason `viewed`. Must never generalize to "any member can
   * delete any message" — the second assertion below proves a recipient still
   * can't touch an ordinary `text` message.
   */
  it('view-once: a recipient can self-tombstone it (reason "viewed"), but not an ordinary text message', async () => {
    const { alice, bob, aliceDevice, aliceDeviceId, bobDeviceId, conversation } = await setupConversation();

    async function encryptFor(text: string) {
      const bundle = await getKeyBundle(bob.userId, bobDeviceId);
      const publicBundle: PublicKeyBundle = {
        identityAgreementKey: Buffer.from(bundle.identityKey.agreementPublicKey, 'base64'),
        identitySigningKey: Buffer.from(bundle.identityKey.signingPublicKey, 'base64'),
        signedPreKeyId: bundle.signedPreKey.keyId,
        signedPreKeyPublic: Buffer.from(bundle.signedPreKey.publicKey, 'base64'),
        signedPreKeySignature: Buffer.from(bundle.signedPreKey.signature, 'base64'),
        oneTimePreKeyId: bundle.oneTimePreKey?.keyId ?? null,
        oneTimePreKeyPublic: bundle.oneTimePreKey ? Buffer.from(bundle.oneTimePreKey.publicKey, 'base64') : null,
      };
      const { session, x3dhInit } = createOutboundSession(aliceDevice.identity, publicBundle);
      return { envelope: encryptMessage(session, new TextEncoder().encode(text)), x3dhInit };
    }

    const viewOnce = await encryptFor('pretend this is a photo');
    const viewOnceMessageId = crypto.randomUUID();
    await sendMessage(
      { userId: alice.userId, deviceId: aliceDeviceId },
      conversation.id,
      {
        messageId: viewOnceMessageId,
        envelopeType: 'x3dh_ratchet_1to1',
        recipients: [{ deviceId: bobDeviceId, envelope: viewOnce.envelope, x3dhInit: viewOnce.x3dhInit }],
        contentTypeHint: 'view_once',
        replyToMessageId: null,
        sentAt: new Date().toISOString(),
      },
    );

    // Bob (the recipient, not the sender) opens it — self-tombstones.
    const result = await deleteMessage(bob.userId, viewOnceMessageId);
    expect(result.deletionReason).toBe('viewed');
    const row = await prisma.message.findUniqueOrThrow({ where: { id: viewOnceMessageId } });
    expect(row.deletedAt).not.toBeNull();
    expect(row.deletionReason).toBe('viewed');
    expect(row.ciphertext).toBeNull();

    // Same recipient, an ORDINARY text message — still sender-only, the
    // carve-out is scoped to `view_once` specifically, not "any recipient can
    // delete anything."
    const text = await encryptFor('a normal message');
    const textMessageId = crypto.randomUUID();
    await sendMessage(
      { userId: alice.userId, deviceId: aliceDeviceId },
      conversation.id,
      {
        messageId: textMessageId,
        envelopeType: 'x3dh_ratchet_1to1',
        recipients: [{ deviceId: bobDeviceId, envelope: text.envelope, x3dhInit: text.x3dhInit }],
        contentTypeHint: 'text',
        replyToMessageId: null,
        sentAt: new Date().toISOString(),
      },
    );
    await expect(deleteMessage(bob.userId, textMessageId)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('respects the reader privacy setting: read receipts are not recorded when disabled', async () => {
    const { alice, bob, aliceDevice, aliceDeviceId, bobDeviceId, conversation } = await setupConversation();
    await prisma.userPrivacySetting.update({ where: { userId: bob.userId }, data: { readReceipts: false } });

    const bundle = await getKeyBundle(bob.userId, bobDeviceId);
    const publicBundle: PublicKeyBundle = {
      identityAgreementKey: Buffer.from(bundle.identityKey.agreementPublicKey, 'base64'),
      identitySigningKey: Buffer.from(bundle.identityKey.signingPublicKey, 'base64'),
      signedPreKeyId: bundle.signedPreKey.keyId,
      signedPreKeyPublic: Buffer.from(bundle.signedPreKey.publicKey, 'base64'),
      signedPreKeySignature: Buffer.from(bundle.signedPreKey.signature, 'base64'),
      oneTimePreKeyId: bundle.oneTimePreKey?.keyId ?? null,
      oneTimePreKeyPublic: bundle.oneTimePreKey ? Buffer.from(bundle.oneTimePreKey.publicKey, 'base64') : null,
    };
    const { session, x3dhInit } = createOutboundSession(aliceDevice.identity, publicBundle);
    const envelope = encryptMessage(session, new TextEncoder().encode('does bob read this'));
    const messageId = crypto.randomUUID();

    await sendMessage(
      { userId: alice.userId, deviceId: aliceDeviceId },
      conversation.id,
      {
        messageId,
        envelopeType: 'x3dh_ratchet_1to1',
        recipients: [{ deviceId: bobDeviceId, envelope, x3dhInit }],
        contentTypeHint: 'text',
        replyToMessageId: null,
        sentAt: new Date().toISOString(),
      },
    );

    const recorded = await markConversationRead(bob.userId, conversation.id, messageId);
    expect(recorded).toBe(false);

    const recipientRow = await prisma.messageRecipient.findUniqueOrThrow({
      where: { messageId_recipientDeviceId: { messageId, recipientDeviceId: bobDeviceId } },
    });
    expect(recipientRow.readAt).toBeNull();
  });
});
