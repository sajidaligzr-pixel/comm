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
import { createOrGetDirectConversation, requireConversationMembership } from '../modules/conversations/service';
import { sendMessage, listMessages, deleteMessage, markConversationRead } from '../modules/messages/service';
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
      recipientDeviceId: bobDeviceId,
      envelopeType: 'x3dh_ratchet_1to1',
      envelope,
      x3dhInit,
      contentTypeHint: 'text',
      replyToMessageId: null,
      sentAt: new Date().toISOString(),
    };

    // One MessageDto per target device (docs/13-roadmap.md's group chat pass) —
    // a direct conversation always yields exactly one.
    const sent = await sendMessage({ userId: alice.userId, deviceId: aliceDeviceId }, conversation.id, request);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.id).toBe(messageId);

    // The server-stored row is genuinely opaque ciphertext — assert directly against
    // the database, not just the service's own return value.
    const row = await prisma.message.findUniqueOrThrow({ where: { id: messageId } });
    expect(row.ciphertext).toBeTruthy();
    const storedAsString = row.ciphertext!.toString('utf8');
    expect(storedAsString).not.toContain('hey bob');
    expect(storedAsString).not.toContain('real E2E');

    const page = await listMessages(bob.userId, conversation.id, undefined, 10);
    expect(page.items).toHaveLength(1);
    expect(page.items[0]!.id).toBe(messageId);
    expect(page.items[0]!.envelope.ciphertext).toBe(envelope.ciphertext);
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

    await expect(
      sendMessage(
        { userId: alice.userId, deviceId: aliceDeviceId },
        conversation.id,
        {
          messageId: crypto.randomUUID(),
          recipientDeviceId: outsiderDeviceId,
          envelopeType: 'x3dh_ratchet_1to1',
          envelope,
          x3dhInit,
          contentTypeHint: 'text',
          replyToMessageId: null,
          sentAt: new Date().toISOString(),
        },
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('rejects a non-member from reading conversation history', async () => {
    const { conversation } = await setupConversation();
    const outsider = await createActiveUser();
    createdUserIds.push(outsider.userId);

    await expect(listMessages(outsider.userId, conversation.id, undefined, 10)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(requireConversationMembership(outsider.userId, conversation.id)).rejects.toMatchObject({ code: 'FORBIDDEN' });
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
        recipientDeviceId: bobDeviceId,
        envelopeType: 'x3dh_ratchet_1to1',
        envelope,
        x3dhInit,
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
        recipientDeviceId: bobDeviceId,
        envelopeType: 'x3dh_ratchet_1to1',
        envelope,
        x3dhInit,
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
