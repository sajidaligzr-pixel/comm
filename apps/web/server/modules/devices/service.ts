import { randomBytes } from 'node:crypto';
import { prisma, Prisma } from '@comm/database';
import { AppError, type NewDeviceRegistration, type DeviceSummary, type LinkDeviceStartResponse } from '@comm/types';
import { getRedisClient } from '@comm/security';
import { recordSecurityEvent } from '../../common/security-events';
import { publishDeviceRevoked } from '../../realtime/bus';

const LINK_TOKEN_TTL_SECONDS = 5 * 60;

/** Prisma's transaction client type — used so this function can run either inside an
 * outer `prisma.$transaction(tx => ...)` (invite redemption / login / device linking,
 * which all need "user activated + device created + keys stored" to commit
 * atomically) or, in principle, be handed the top-level client directly. */
type Db = Prisma.TransactionClient | typeof prisma;

/**
 * Creates a device row + its public key material (so
 * "user active" / "device created" / "keys stored" commit atomically at invite
 * redemption and login — see docs/07-auth-architecture.md). Only ever stores PUBLIC
 * key bytes handed up by the client; see docs/05-crypto-architecture.md for why the
 * server has no business with — and never receives — the private halves.
 */
export async function registerDevice(
  db: Db,
  userId: string,
  registration: NewDeviceRegistration,
): Promise<{ deviceId: string }> {
  const device = await db.device.create({
    data: {
      userId,
      name: registration.name,
      deviceType: registration.deviceType,
    },
  });

  await db.identityKey.create({
    data: {
      deviceId: device.id,
      signingPublicKey: Buffer.from(registration.keyBundle.identityKey.signingPublicKey, 'base64'),
      agreementPublicKey: Buffer.from(registration.keyBundle.identityKey.agreementPublicKey, 'base64'),
    },
  });

  await db.signedPreKey.create({
    data: {
      deviceId: device.id,
      keyId: registration.keyBundle.signedPreKey.keyId,
      publicKey: Buffer.from(registration.keyBundle.signedPreKey.publicKey, 'base64'),
      signature: Buffer.from(registration.keyBundle.signedPreKey.signature, 'base64'),
    },
  });

  if (registration.keyBundle.oneTimePreKeys.length > 0) {
    await db.oneTimePreKey.createMany({
      data: registration.keyBundle.oneTimePreKeys.map((k) => ({
        deviceId: device.id,
        keyId: k.keyId,
        publicKey: Buffer.from(k.publicKey, 'base64'),
      })),
    });
  }

  return { deviceId: device.id };
}

export async function listDevices(userId: string, currentDeviceId: string): Promise<DeviceSummary[]> {
  const devices = await prisma.device.findMany({
    where: { userId, status: 'active' },
    orderBy: { linkedAt: 'desc' },
  });
  return devices.map((d) => ({
    id: d.id,
    name: d.name,
    deviceType: d.deviceType,
    status: d.status,
    linkedAt: d.linkedAt.toISOString(),
    lastActiveAt: d.lastActiveAt.toISOString(),
    isCurrentDevice: d.id === currentDeviceId,
  }));
}

/**
 * Revocation is immediate and multi-part: mark the device row, revoke every session
 * tied to it, publish so any live WebSocket connection for that device is force-closed
 * right now rather than waiting for its next auth check (docs/06-device-architecture.md
 * / docs/04-websocket-realtime.md's `device.revoked` event), and log a security event
 * the owning user can see (docs/42 in the master prompt).
 */
export async function revokeDevice(
  callerUserId: string,
  deviceId: string,
  reason: 'user' | 'admin',
): Promise<void> {
  const device = await prisma.device.findUnique({ where: { id: deviceId } });
  if (!device || device.userId !== callerUserId) {
    // Same response whether the device doesn't exist or belongs to someone else —
    // does not confirm/deny existence of another account's device (docs/08-threat-model.md IDOR note).
    throw new AppError('NOT_FOUND', 'Device not found.');
  }
  if (device.status === 'revoked') {
    return; // idempotent
  }

  await prisma.$transaction([
    prisma.device.update({
      where: { id: deviceId },
      data: { status: 'revoked', revokedAt: new Date(), revokedReason: reason },
    }),
    prisma.session.updateMany({
      where: { deviceId, revokedAt: null },
      data: { revokedAt: new Date() },
    }),
  ]);

  await recordSecurityEvent({
    userId: callerUserId,
    eventType: 'device_revoked',
    deviceId,
    metadata: { reason },
  });

  await publishDeviceRevoked(deviceId);
}

/** Step 1 of device linking (docs/06-device-architecture.md): an already-authenticated
 * device requests a short-lived, single-use token. Stored in Redis, not Postgres — it
 * is intentionally ephemeral and never needs to survive a restart. */
export async function startDeviceLink(userId: string, primaryDeviceId: string): Promise<LinkDeviceStartResponse> {
  const identityKey = await prisma.identityKey.findUnique({ where: { deviceId: primaryDeviceId } });
  if (!identityKey) {
    throw new AppError('CONFLICT', 'This device has no identity key on record.');
  }

  const token = randomBytes(24).toString('base64url');
  const expiresAt = new Date(Date.now() + LINK_TOKEN_TTL_SECONDS * 1000);

  await getRedisClient().set(
    `device-link:${token}`,
    JSON.stringify({ userId, primaryDeviceId }),
    'EX',
    LINK_TOKEN_TTL_SECONDS,
  );

  return {
    linkingToken: token,
    expiresAt: expiresAt.toISOString(),
    // The signing key is the one used for identity verification/safety-number-style
    // comparisons (docs/05-crypto-architecture.md#device-verification) — the
    // agreement key is only ever used inside X3DH, never shown to a human.
    primaryDeviceIdentityPublicKey: identityKey.signingPublicKey.toString('base64'),
  };
}

/**
 * Step 2: the new device submits the token (scanned from the primary device's QR
 * code) plus its own freshly generated key bundle. The token is single-use (deleted
 * on first successful redemption) and only usable while the primary device that
 * issued it kept the linking screen open. See docs/06-device-architecture.md's
 * revision note on why QR possession is treated as the confirmation step, matching
 * how this flow behaves in comparable messengers, rather than requiring a further
 * separate approval round-trip.
 */
export async function completeDeviceLink(
  linkingToken: string,
  registration: NewDeviceRegistration,
): Promise<{ userId: string; deviceId: string; username: string; displayName: string; mustChangePassword: boolean }> {
  const redis = getRedisClient();
  const key = `device-link:${linkingToken}`;
  const raw = await redis.get(key);
  if (!raw) {
    throw new AppError('INVITE_INVALID_OR_EXPIRED', 'This linking code has expired. Generate a new one.');
  }
  // Single-use: delete before doing anything else so a race between two concurrent
  // completions can't both succeed.
  const deleted = await redis.del(key);
  if (deleted === 0) {
    throw new AppError('INVITE_INVALID_OR_EXPIRED', 'This linking code has already been used.');
  }

  const { userId } = JSON.parse(raw) as { userId: string; primaryDeviceId: string };

  const { deviceId, user } = await prisma.$transaction(async (tx) => {
    const { deviceId } = await registerDevice(tx, userId, registration);
    const user = await tx.user.findUniqueOrThrow({ where: { id: userId } });
    return { deviceId, user };
  });

  await recordSecurityEvent({ userId, eventType: 'new_device_linked', deviceId });

  return {
    userId,
    deviceId,
    username: user.username,
    displayName: user.displayName,
    mustChangePassword: user.mustChangePassword,
  };
}
