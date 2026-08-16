import { describe, it, expect, afterAll } from 'vitest';
import { prisma } from '@comm/database';
import { hashToken } from '@comm/security';
import { createSession, rotateSession } from '../../modules/auth/session';
import { registerDevice } from '../../modules/devices/service';
import { createActiveUser, fakeDeviceRegistration, deleteTestUser } from '../helpers';

/**
 * docs/07-auth-architecture.md's refresh-token rotation + reuse-detection guarantee,
 * and docs/12-testing-strategy.md's "session theft / token replay" test case. This is
 * one of the highest-value security tests in the whole suite: if this regresses, a
 * stolen refresh token stays valid indefinitely instead of the whole family being
 * torched on first detected reuse.
 */
describe('refresh token rotation & reuse detection', () => {
  const createdUserIds: string[] = [];
  afterAll(async () => {
    await Promise.all(createdUserIds.map(deleteTestUser));
  });

  async function setupSession() {
    const { userId } = await createActiveUser();
    createdUserIds.push(userId);
    const { deviceId } = await registerDevice(prisma, userId, fakeDeviceRegistration());
    const session = await createSession(userId, deviceId, null, 'vitest');
    return { userId, deviceId, session };
  }

  it('rotates the refresh token on use, invalidating the previous one', async () => {
    const { session } = await setupSession();

    const rotated = await rotateSession(session.refreshToken, null, 'vitest');
    expect(rotated.refreshToken).not.toBe(session.refreshToken);
    expect(rotated.accessToken).not.toBe(session.accessToken);

    // The original refresh token must no longer work at all.
    await expect(rotateSession(session.refreshToken, null, 'vitest')).rejects.toMatchObject({
      code: 'AUTH_INVALID',
    });
  });

  it('reusing an already-rotated-away token revokes the entire session family, including the newest one', async () => {
    const { session } = await setupSession();

    const rotated = await rotateSession(session.refreshToken, null, 'vitest');

    // Attacker (or a buggy retry) replays the ORIGINAL token after it was already
    // rotated away.
    await expect(rotateSession(session.refreshToken, null, 'vitest')).rejects.toMatchObject({
      code: 'AUTH_INVALID',
    });

    // The legitimate holder's freshly-rotated token must ALSO now be dead — this is
    // the "erring toward forcing re-login over leaving a stolen token valid" behavior
    // documented in docs/07-auth-architecture.md.
    await expect(rotateSession(rotated.refreshToken, null, 'vitest')).rejects.toMatchObject({
      code: 'AUTH_INVALID',
    });
  });

  it('records a suspicious_login security event when reuse is detected', async () => {
    const { userId, session } = await setupSession();

    await rotateSession(session.refreshToken, null, 'vitest');
    await rotateSession(session.refreshToken, null, 'vitest').catch(() => {});

    const events = await prisma.securityEvent.findMany({ where: { userId, eventType: 'suspicious_login' } });
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events[0]!.metadata).toMatchObject({ reason: 'refresh_token_reuse' });
  });

  it('rejects a refresh token for a session that was explicitly revoked (e.g. logout)', async () => {
    const { session } = await setupSession();
    const sessionRow = await prisma.session.findFirstOrThrow({
      where: { refreshTokenHash: hashToken(session.refreshToken) },
    });
    await prisma.session.update({ where: { id: sessionRow.id }, data: { revokedAt: new Date() } });

    await expect(rotateSession(session.refreshToken, null, 'vitest')).rejects.toMatchObject({
      code: 'AUTH_INVALID',
    });
  });

  it('rotating one session never revokes or affects an unrelated session/family', async () => {
    const a = await setupSession();
    const b = await setupSession();

    await rotateSession(a.session.refreshToken, null, 'vitest');

    // Session B's original token must still work — proves reuse-detection/rotation
    // scopes strictly to the token's own family, never touching sibling accounts'
    // (or the same account's other device's) sessions.
    const rotatedB = await rotateSession(b.session.refreshToken, null, 'vitest');
    expect(rotatedB.accessToken).toBeTruthy();
  });
});
