import { randomBytes, randomUUID } from 'node:crypto';
import { prisma } from '@comm/database';
import { hashPassword } from '@comm/security';
import type { NewDeviceRegistration } from '@comm/types';

/**
 * Test-only helpers. These talk to the real local Postgres/Redis configured via
 * apps/web/.env (docs/12-testing-strategy.md's "test against the real thing, not
 * mocks" approach) — every helper that creates a row returns enough identifiers for
 * the calling test to clean up explicitly in its own `afterAll`, rather than this
 * file doing pattern-based bulk deletes that could race with other test files
 * running in parallel.
 */

function randomBase64(byteLength: number): string {
  return randomBytes(byteLength).toString('base64');
}

/** A structurally-valid key bundle for tests that exercise auth/device flows rather
 * than crypto correctness itself (that's packages/crypto's own test suite) — server-side
 * code validates shape/size and signature-verifies nothing at registration time (the
 * *receiving* side verifies a signed pre-key's signature, at session-establishment
 * time, which is Phase 3 client-side work covered separately), so random bytes here
 * are sufficient and deliberately don't need to satisfy real X3DH constraints. */
export function fakeDeviceRegistration(name = 'Test device'): NewDeviceRegistration {
  return {
    name,
    deviceType: 'web',
    keyBundle: {
      identityKey: { signingPublicKey: randomBase64(32), agreementPublicKey: randomBase64(32) },
      signedPreKey: { keyId: 1, publicKey: randomBase64(32), signature: randomBase64(64) },
      oneTimePreKeys: [],
    },
  };
}

export function uniqueUsername(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
}

/** Directly provisions an active user with a known password, bypassing the invite
 * flow — for tests whose subject is something *other* than invite redemption itself
 * (login, device management, admin authorization, ...). */
export async function createActiveUser(opts: { username?: string; password?: string } = {}) {
  const username = opts.username ?? uniqueUsername('t_user');
  const password = opts.password ?? `Test-password-${randomUUID()}`;
  const passwordHash = await hashPassword(password);

  const user = await prisma.user.create({
    data: { username, displayName: username, status: 'active', passwordHash },
  });
  await prisma.userPrivacySetting.create({ data: { userId: user.id } });
  await prisma.notificationPreference.create({ data: { userId: user.id } });

  return { userId: user.id, username, password };
}

export async function createAdminUser(opts: { username?: string; password?: string } = {}) {
  const base = await createActiveUser(opts);
  const admin = await prisma.admin.create({ data: { userId: base.userId, role: 'superadmin' } });
  return { ...base, adminId: admin.id };
}

export async function deleteTestUser(userId: string): Promise<void> {
  // `invites.issued_by_admin_id` is `onDelete: Restrict` (docs/02-database-schema.md
  // — invite history outlives the admin who issued it, by design). That's the right
  // production behavior, but it means test cleanup order matters: deleting an admin
  // user while a test-created invite still references it fails. Rather than make
  // every test file hand-order its cleanup (fragile, and these test files run in
  // parallel — vitest.config.ts), detach test-issued invites here first, up front,
  // regardless of which "side" of the relationship this particular user is.
  const admin = await prisma.admin.findUnique({ where: { userId } });
  if (admin) {
    await prisma.invite.deleteMany({ where: { issuedByAdminId: admin.id } });
  }

  // Same reasoning for `messages.sender_user_id` (also `onDelete: Restrict` —
  // message history outlives a departed sender in production,
  // docs/02-database-schema.md). Test rows have no such history worth preserving.
  await prisma.message.deleteMany({ where: { senderUserId: userId } });

  // Cascading FKs take devices/sessions/security_events/the admin row/conversation
  // memberships/this user's own invites (as invitee) with it.
  await prisma.user.delete({ where: { id: userId } }).catch(() => {
    // Already gone (e.g. a test that itself deletes the user) — not a cleanup failure.
  });
}
