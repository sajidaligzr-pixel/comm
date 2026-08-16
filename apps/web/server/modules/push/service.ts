import { prisma } from '@comm/database';
import { encryptAtRest } from '@comm/security';
import type { PushSubscriptionRequest } from '@comm/types';

/**
 * Push subscription storage (docs/13-roadmap.md's push notification pass) — the
 * subscribe/unsubscribe half; actually sending a push happens in `apps/worker`
 * (docs/02-database-schema.md's `push_subscriptions` note on why: it's the one place
 * that decrypts `subscriptionCiphertext`, kept out of the hot request path). Worker
 * has its own small decrypt wrapper around the same `@comm/security` primitive
 * rather than importing anything from here — apps/worker never imports from
 * apps/web, same module-isolation rule as everywhere else (docs/01-folder-structure.md).
 */

function encKey(): string {
  const key = process.env.PUSH_SUBSCRIPTION_ENC_KEY;
  if (!key) throw new Error('PUSH_SUBSCRIPTION_ENC_KEY is not set. See .env.example.');
  return key;
}

/** Upserts by `deviceId` — a device only ever has one live subscription
 * (docs/02-database-schema.md's `push_subscriptions` note); re-subscribing (browser
 * rotation, re-enabling) replaces the old row rather than accumulating stale ones. */
export async function savePushSubscription(deviceId: string, subscription: PushSubscriptionRequest): Promise<void> {
  const plaintext = Buffer.from(JSON.stringify(subscription), 'utf8');
  const ciphertext = encryptAtRest(encKey(), plaintext);
  await prisma.pushSubscription.upsert({
    where: { deviceId },
    create: { deviceId, subscriptionCiphertext: ciphertext },
    update: { subscriptionCiphertext: ciphertext },
  });
}

export async function deletePushSubscription(deviceId: string): Promise<void> {
  await prisma.pushSubscription.deleteMany({ where: { deviceId } });
}

/** Used by apps/web only to answer "does this device already have one?" for the
 * client-side prompt's own state (never returns the decrypted subscription itself —
 * that only ever happens in apps/worker, at actual dispatch time). */
export async function hasPushSubscription(deviceId: string): Promise<boolean> {
  const row = await prisma.pushSubscription.findUnique({ where: { deviceId }, select: { deviceId: true } });
  return !!row;
}
