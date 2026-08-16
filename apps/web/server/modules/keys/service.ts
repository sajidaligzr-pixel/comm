import { prisma } from '@comm/database';
import { AppError, type KeyBundleResponse, type SignedPreKeyUpload, type OneTimePreKeyUpload } from '@comm/types';

/**
 * Everything here stores/returns PUBLIC key material only — see
 * docs/05-crypto-architecture.md and docs/09-trust-boundaries.md. No function in this
 * file ever receives, generates, or could reconstruct a private key.
 */

/**
 * `GET /api/keys/bundle/:userId/:deviceId` — what `packages/crypto`'s
 * `createOutboundSession` needs to start X3DH with a device for the first time.
 * Atomically claims one unclaimed one-time pre-key (docs/02-database-schema.md: once
 * claimed it's never issued again) — or returns `null` for that field if the pool is
 * exhausted, which X3DH's spec explicitly supports as a fallback (fewer forward-secrecy
 * guarantees for that first message only, not a hard failure).
 */
export async function getKeyBundle(targetUserId: string, targetDeviceId: string): Promise<KeyBundleResponse> {
  const device = await prisma.device.findUnique({
    where: { id: targetDeviceId },
    include: { identityKey: true, signedPreKeys: { where: { rotatedAt: null }, orderBy: { createdAt: 'desc' }, take: 1 } },
  });

  if (!device || device.userId !== targetUserId || device.status !== 'active' || !device.identityKey || device.signedPreKeys.length === 0) {
    // Same NOT_FOUND whether the device doesn't exist, belongs to someone else, is
    // revoked, or simply hasn't finished registering keys yet — a caller can't
    // distinguish "wrong id" from "device exists but is revoked" from this response
    // (docs/08-threat-model.md's IDOR/enumeration note).
    throw new AppError('NOT_FOUND', 'Device not found.');
  }

  const signedPreKey = device.signedPreKeys[0]!;

  // Atomic claim: UPDATE ... WHERE claimed_at IS NULL ... RETURNING, expressed via
  // Prisma's updateMany + a follow-up read of the row this call itself claimed. Two
  // concurrent requests racing for the same key can't both succeed — updateMany's
  // affected-row count tells us which (if either) request actually got it.
  const candidate = await prisma.oneTimePreKey.findFirst({
    where: { deviceId: targetDeviceId, claimedAt: null },
    orderBy: { keyId: 'asc' },
  });

  let claimedOneTimePreKey: { keyId: number; publicKey: Buffer } | null = null;
  if (candidate) {
    const claim = await prisma.oneTimePreKey.updateMany({
      where: { id: candidate.id, claimedAt: null },
      data: { claimedAt: new Date() },
    });
    if (claim.count === 1) {
      claimedOneTimePreKey = { keyId: candidate.keyId, publicKey: candidate.publicKey };
    }
    // If claim.count === 0, another concurrent request won the race — we simply
    // proceed without a one-time pre-key for this bundle rather than retrying, per
    // X3DH's documented no-one-time-key fallback.
  }

  return {
    identityKey: {
      signingPublicKey: device.identityKey.signingPublicKey.toString('base64'),
      agreementPublicKey: device.identityKey.agreementPublicKey.toString('base64'),
    },
    signedPreKey: {
      keyId: signedPreKey.keyId,
      publicKey: signedPreKey.publicKey.toString('base64'),
      signature: signedPreKey.signature.toString('base64'),
    },
    oneTimePreKey: claimedOneTimePreKey
      ? { keyId: claimedOneTimePreKey.keyId, publicKey: claimedOneTimePreKey.publicKey.toString('base64') }
      : null,
  };
}

/** Rotates the CALLER's own signed pre-key — never another device's (the deviceId
 * comes from the authenticated session, not a request body field). Old signed
 * pre-keys are marked rotated rather than deleted immediately, so a session
 * mid-establishment against the previous one isn't broken out from under it;
 * garbage collection of long-rotated keys is a worker job, not implemented in this
 * pass (tracked alongside the one-time-prekey top-up reminder). */
export async function uploadSignedPreKey(deviceId: string, upload: SignedPreKeyUpload): Promise<void> {
  await prisma.$transaction([
    prisma.signedPreKey.updateMany({ where: { deviceId, rotatedAt: null }, data: { rotatedAt: new Date() } }),
    prisma.signedPreKey.create({
      data: {
        deviceId,
        keyId: upload.keyId,
        publicKey: Buffer.from(upload.publicKey, 'base64'),
        signature: Buffer.from(upload.signature, 'base64'),
      },
    }),
  ]);
}

export async function uploadOneTimePreKeys(deviceId: string, uploads: OneTimePreKeyUpload[]): Promise<void> {
  await prisma.oneTimePreKey.createMany({
    data: uploads.map((k) => ({ deviceId, keyId: k.keyId, publicKey: Buffer.from(k.publicKey, 'base64') })),
    skipDuplicates: true,
  });
}

export async function countUnclaimedOneTimePreKeys(deviceId: string): Promise<number> {
  return prisma.oneTimePreKey.count({ where: { deviceId, claimedAt: null } });
}
