import { describe, it, expect, afterAll } from 'vitest';
import { prisma } from '@comm/database';
import { generateSecureToken, hashToken } from '@comm/security';
import { AppError } from '@comm/types';
import { getInviteInfo, redeemInvite } from '../modules/auth/service';
import { fakeDeviceRegistration, uniqueUsername, deleteTestUser } from './helpers';

/**
 * Covers docs/07-auth-architecture.md's provisioning flow — the one account-creation
 * path in this system — and the abuse cases docs/12-testing-strategy.md calls out
 * explicitly (double redemption, expired/invalid tokens).
 */
describe('invite redemption', () => {
  const invitedUserIds: string[] = [];
  // Tracked separately and deleted LAST: invite rows reference their issuing admin
  // with `onDelete: Restrict` (docs/02-database-schema.md — invites are kept for
  // audit history even if the admin account is later removed), so the admin row
  // must outlive every invite that references it during this file's own cleanup.
  // Deliberately never reused via a global `prisma.admin.findFirst()` lookup either
  // — with test files running in parallel (vitest.config.ts), that could pick up
  // another file's admin and race its cleanup.
  let bootstrapAdminId: string | undefined;
  let bootstrapAdminUserId: string | undefined;

  afterAll(async () => {
    for (const id of invitedUserIds) {
      await deleteTestUser(id);
    }
    if (bootstrapAdminUserId) {
      await deleteTestUser(bootstrapAdminUserId);
    }
  });

  async function ensureBootstrapAdmin(): Promise<string> {
    if (bootstrapAdminId) return bootstrapAdminId;
    const adminUser = await prisma.user.create({
      data: { username: uniqueUsername('t_bootstrap_admin'), displayName: 'Bootstrap Admin', status: 'active' },
    });
    bootstrapAdminUserId = adminUser.id;
    const createdAdmin = await prisma.admin.create({ data: { userId: adminUser.id, role: 'superadmin' } });
    bootstrapAdminId = createdAdmin.id;
    return bootstrapAdminId;
  }

  async function makeInvite(expiresInMs = 60 * 60 * 1000) {
    const username = uniqueUsername('t_invite');
    const rawToken = generateSecureToken(32);
    const user = await prisma.user.create({
      data: { username, displayName: 'Invitee', status: 'pending_invite' },
    });
    invitedUserIds.push(user.id);

    const issuerAdminId = await ensureBootstrapAdmin();

    await prisma.invite.create({
      data: {
        userId: user.id,
        tokenHash: hashToken(rawToken),
        issuedByAdminId: issuerAdminId,
        expiresAt: new Date(Date.now() + expiresInMs),
      },
    });

    return { userId: user.id, username, rawToken };
  }

  it('redeems a valid invite: activates the user, creates the device, issues a session', async () => {
    const { userId, username, rawToken } = await makeInvite();

    const info = await getInviteInfo(rawToken);
    expect(info.username).toBe(username);

    const result = await redeemInvite(
      { token: rawToken, password: 'a-perfectly-fine-password-12', device: fakeDeviceRegistration() },
      null,
      'vitest',
    );

    expect(result.userId).toBe(userId);
    expect(result.session.accessToken).toBeTruthy();
    expect(result.session.refreshToken).toBeTruthy();

    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    expect(user.status).toBe('active');
    expect(user.passwordHash).toBeTruthy();

    const devices = await prisma.device.findMany({ where: { userId } });
    expect(devices).toHaveLength(1);
    expect(devices[0]!.status).toBe('active');
  });

  it('rejects redeeming the same invite twice', async () => {
    const { rawToken } = await makeInvite();

    await redeemInvite(
      { token: rawToken, password: 'first-time-through-12', device: fakeDeviceRegistration() },
      null,
      'vitest',
    );

    await expect(
      redeemInvite(
        { token: rawToken, password: 'second-attempt-should-fail-12', device: fakeDeviceRegistration() },
        null,
        'vitest',
      ),
    ).rejects.toMatchObject({ code: 'INVITE_INVALID_OR_EXPIRED' } satisfies Partial<AppError>);
  });

  it('rejects an expired invite', async () => {
    const { rawToken } = await makeInvite(-1000); // already expired

    await expect(getInviteInfo(rawToken)).rejects.toMatchObject({ code: 'INVITE_INVALID_OR_EXPIRED' });
    await expect(
      redeemInvite({ token: rawToken, password: 'irrelevant-password-12', device: fakeDeviceRegistration() }, null, 'vitest'),
    ).rejects.toMatchObject({ code: 'INVITE_INVALID_OR_EXPIRED' });
  });

  it('rejects a token that was never issued, identically to an expired one (no existence oracle)', async () => {
    const guessedToken = generateSecureToken(32);
    let expiredError: unknown;
    let neverIssuedError: unknown;

    const { rawToken: expiredToken } = await makeInvite(-1000);
    try {
      await getInviteInfo(expiredToken);
    } catch (err) {
      expiredError = err;
    }
    try {
      await getInviteInfo(guessedToken);
    } catch (err) {
      neverIssuedError = err;
    }

    expect((expiredError as AppError).code).toBe((neverIssuedError as AppError).code);
    expect((expiredError as AppError).message).toBe((neverIssuedError as AppError).message);
  });

  it('rejects a concurrent double-redemption race as only one winner', async () => {
    const { rawToken } = await makeInvite();

    const attempts = await Promise.allSettled([
      redeemInvite({ token: rawToken, password: 'race-attempt-one-12', device: fakeDeviceRegistration() }, null, 'vitest'),
      redeemInvite({ token: rawToken, password: 'race-attempt-two-12', device: fakeDeviceRegistration() }, null, 'vitest'),
    ]);

    const fulfilled = attempts.filter((a) => a.status === 'fulfilled');
    const rejected = attempts.filter((a) => a.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
  });

  it('generates a random UUIDv7-style id unrelated to id predictability of concurrent invites', async () => {
    // Not a strong crypto test (that lives in packages/security) — just a sanity
    // check that two invites for two different users never collide in this flow.
    const a = await makeInvite();
    const b = await makeInvite();
    expect(a.userId).not.toBe(b.userId);
    expect(a.rawToken).not.toBe(b.rawToken);
  });
});
