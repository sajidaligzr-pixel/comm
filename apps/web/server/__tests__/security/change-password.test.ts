import { describe, it, expect, afterAll } from 'vitest';
import { prisma } from '@comm/database';
import { changePassword, login } from '../../modules/auth/service';
import { createSession } from '../../modules/auth/session';
import { registerDevice } from '../../modules/devices/service';
import { createActiveUser, fakeDeviceRegistration, deleteTestUser } from '../helpers';

/**
 * docs/07-auth-architecture.md's forced-password-change flow. Covers the two things
 * that actually matter for security here: the current password is genuinely
 * required (not just "you have a valid session"), and a successful change revokes
 * every OTHER session on the account (a stolen session elsewhere shouldn't survive
 * the real owner rotating their credential).
 */
describe('change password', () => {
  const createdUserIds: string[] = [];
  afterAll(async () => {
    await Promise.all(createdUserIds.map(deleteTestUser));
  });

  it('rejects an incorrect current password', async () => {
    const { userId } = await createActiveUser();
    createdUserIds.push(userId);

    await expect(
      changePassword(userId, '00000000-0000-0000-0000-000000000000', 'totally-wrong-password', 'a-brand-new-password-12'),
    ).rejects.toMatchObject({ code: 'AUTH_INVALID' });
  });

  it('changes the password, clears mustChangePassword, and the new password works at login', async () => {
    const { userId, username, password } = await createActiveUser();
    createdUserIds.push(userId);
    await prisma.user.update({ where: { id: userId }, data: { mustChangePassword: true } });

    const { deviceId } = await registerDevice(prisma, userId, fakeDeviceRegistration());

    const newPassword = 'a-brand-new-password-12';
    await changePassword(userId, '00000000-0000-0000-0000-000000000000', password, newPassword);

    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    expect(user.mustChangePassword).toBe(false);

    const loginOutcome = await login({ username, password: newPassword, deviceId }, null, 'vitest');
    if (loginOutcome.status !== 'ok') throw new Error(`expected 'ok', got ${loginOutcome.status}`);
    expect(loginOutcome.result.mustChangePassword).toBe(false);

    // Old password must no longer work.
    await expect(login({ username, password, deviceId }, null, 'vitest')).rejects.toMatchObject({
      code: 'AUTH_INVALID',
    });
  });

  it('revokes every other session on the account but leaves the current one alone', async () => {
    const { userId, password } = await createActiveUser();
    createdUserIds.push(userId);

    const { deviceId: deviceA } = await registerDevice(prisma, userId, fakeDeviceRegistration('A'));
    const { deviceId: deviceB } = await registerDevice(prisma, userId, fakeDeviceRegistration('B'));
    await createSession(userId, deviceA, null, 'vitest');
    await createSession(userId, deviceB, null, 'vitest');

    const sessionARow = await prisma.session.findFirstOrThrow({ where: { deviceId: deviceA } });
    const sessionBRowBefore = await prisma.session.findFirstOrThrow({ where: { deviceId: deviceB } });
    expect(sessionBRowBefore.revokedAt).toBeNull();

    // Simulate the request coming from session A — that one must survive.
    await changePassword(userId, sessionARow.id, password, 'a-different-new-password-12');

    const sessionARowAfter = await prisma.session.findUniqueOrThrow({ where: { id: sessionARow.id } });
    const sessionBRowAfter = await prisma.session.findUniqueOrThrow({ where: { id: sessionBRowBefore.id } });
    expect(sessionARowAfter.revokedAt).toBeNull();
    expect(sessionBRowAfter.revokedAt).not.toBeNull();
  });

  it('records a password_changed security event', async () => {
    const { userId, password } = await createActiveUser();
    createdUserIds.push(userId);
    const { deviceId } = await registerDevice(prisma, userId, fakeDeviceRegistration());
    await createSession(userId, deviceId, null, 'vitest');
    const sessionRow = await prisma.session.findFirstOrThrow({ where: { deviceId } });

    await changePassword(userId, sessionRow.id, password, 'yet-another-new-password-12');

    const events = await prisma.securityEvent.findMany({ where: { userId, eventType: 'password_changed' } });
    expect(events).toHaveLength(1);
  });
});
