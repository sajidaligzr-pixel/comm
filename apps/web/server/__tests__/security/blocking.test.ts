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
import type { NewDeviceRegistration } from '@comm/types';
import { registerDevice } from '../../modules/devices/service';
import { createOrGetDirectConversation } from '../../modules/conversations/service';
import { sendMessage } from '../../modules/messages/service';
import { getKeyBundle } from '../../modules/keys/service';
import { blockUser, unblockUser, listBlockedUsers } from '../../modules/blocking/service';
import { createActiveUser, deleteTestUser } from '../helpers';

/**
 * Blocked users (docs/13-roadmap.md) — enforced at createOrGetDirectConversation
 * (refuses to START a new conversation) and sendMessage (refuses a send in an
 * EXISTING one), both checked in either direction and both failing with the same
 * generic error a legitimate "not found"/"nobody reachable" case would already
 * produce — see blocking/service.ts's own docstring for why that's deliberate.
 */
describe('blocked users', () => {
  const createdUserIds: string[] = [];
  afterAll(async () => {
    await Promise.all(createdUserIds.map(deleteTestUser));
  });

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

  async function makeUser(name: string) {
    const user = await createActiveUser();
    createdUserIds.push(user.userId);
    const device = realDeviceRegistration(name);
    const { deviceId } = await registerDevice(prisma, user.userId, device.registration);
    return { ...user, device, deviceId };
  }

  it('blocking is idempotent, per-user, and reversible', async () => {
    const alice = await makeUser('Alice device');
    const bob = await makeUser('Bob device');

    await blockUser(alice.userId, bob.username);
    await blockUser(alice.userId, bob.username); // idempotent, not an error

    const aliceBlocked = await listBlockedUsers(alice.userId);
    expect(aliceBlocked).toHaveLength(1);
    expect(aliceBlocked[0]).toMatchObject({ userId: bob.userId, username: bob.username });
    expect(await listBlockedUsers(bob.userId)).toHaveLength(0); // one-directional, per-user

    await unblockUser(alice.userId, bob.userId);
    expect(await listBlockedUsers(alice.userId)).toHaveLength(0);
  });

  it('cannot block yourself', async () => {
    const alice = await makeUser('Alice solo device');
    await expect(blockUser(alice.userId, alice.username)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('refuses to START a new conversation with someone blocked in either direction, but an existing one still opens', async () => {
    const alice = await makeUser('Alice conv device');
    const bob = await makeUser('Bob conv device');

    // Alice blocks Bob — Bob can no longer start a conversation with Alice either
    // (checked both ways, not just from the blocker's side).
    await blockUser(alice.userId, bob.username);
    await expect(createOrGetDirectConversation(bob.userId, alice.username)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(createOrGetDirectConversation(alice.userId, bob.username)).rejects.toMatchObject({ code: 'FORBIDDEN' });

    await unblockUser(alice.userId, bob.userId);
    const conversation = await createOrGetDirectConversation(alice.userId, bob.username);
    expect(conversation.type).toBe('direct');

    // Blocking again after the conversation already exists must NOT hide it —
    // only new sends are refused (next test), not the conversation itself.
    await blockUser(alice.userId, bob.username);
    const stillOpens = await createOrGetDirectConversation(alice.userId, bob.username);
    expect(stillOpens.id).toBe(conversation.id);
    if (stillOpens.type === 'direct') {
      expect(stillOpens.callerHasBlockedOtherUser).toBe(true);
    }
  });

  it('refuses a send in an existing conversation once either side has blocked the other', async () => {
    const alice = await makeUser('Alice send device');
    const bob = await makeUser('Bob send device');
    const conversation = await createOrGetDirectConversation(alice.userId, bob.username);

    const bundle = await getKeyBundle(bob.userId, bob.deviceId);
    const publicBundle: PublicKeyBundle = {
      identityAgreementKey: Buffer.from(bundle.identityKey.agreementPublicKey, 'base64'),
      identitySigningKey: Buffer.from(bundle.identityKey.signingPublicKey, 'base64'),
      signedPreKeyId: bundle.signedPreKey.keyId,
      signedPreKeyPublic: Buffer.from(bundle.signedPreKey.publicKey, 'base64'),
      signedPreKeySignature: Buffer.from(bundle.signedPreKey.signature, 'base64'),
      oneTimePreKeyId: bundle.oneTimePreKey?.keyId ?? null,
      oneTimePreKeyPublic: bundle.oneTimePreKey ? Buffer.from(bundle.oneTimePreKey.publicKey, 'base64') : null,
    };
    const { session, x3dhInit } = createOutboundSession(alice.device.identity, publicBundle);
    const envelope = encryptMessage(session, new TextEncoder().encode('hi bob'));

    await blockUser(bob.userId, alice.username); // Bob blocks Alice this time — still refused from Alice's send.
    await expect(
      sendMessage(
        { userId: alice.userId, deviceId: alice.deviceId },
        conversation.id,
        {
          messageId: crypto.randomUUID(),
          envelopeType: 'x3dh_ratchet_1to1',
          recipients: [{ deviceId: bob.deviceId, envelope, x3dhInit }],
          contentTypeHint: 'text',
          replyToMessageId: null,
          sentAt: new Date().toISOString(),
        },
      ),
    ).rejects.toMatchObject({ code: 'MESSAGE_FAILED' });
  });
});
