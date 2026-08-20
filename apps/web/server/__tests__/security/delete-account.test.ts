import { describe, it, expect, afterAll } from 'vitest';
import { prisma } from '@comm/database';
import { deleteOwnAccount, login } from '../../modules/auth/service';
import { createSession } from '../../modules/auth/session';
import { registerDevice } from '../../modules/devices/service';
import { createActiveUser, fakeDeviceRegistration, deleteTestUser } from '../helpers';

/**
 * Apple App Store Review Guideline 5.1.1(v)'s in-app account-deletion path. Covers
 * the things that actually matter for security/data-safety here: the current
 * password is genuinely required (not just "you have a valid session"), the account
 * is genuinely unable to log in again afterward, every session/device is revoked
 * (not just the caller's), and PII is scrubbed while the row itself survives (see
 * `deleteOwnAccount`'s own docstring on why this is a soft delete, not a row-level
 * DELETE).
 */
describe('delete account', () => {
  const createdUserIds: string[] = [];
  afterAll(async () => {
    await Promise.all(createdUserIds.map(deleteTestUser));
  });

  it('rejects an incorrect password and leaves the account untouched', async () => {
    const { userId } = await createActiveUser();
    createdUserIds.push(userId);

    await expect(deleteOwnAccount(userId, 'totally-wrong-password')).rejects.toMatchObject({
      code: 'AUTH_INVALID',
    });

    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    expect(user.status).toBe('active');
  });

  it('deletes the account: status flips, password no longer works, login is refused', async () => {
    const { userId, username, password } = await createActiveUser();
    createdUserIds.push(userId);
    const { deviceId } = await registerDevice(prisma, userId, fakeDeviceRegistration());

    await deleteOwnAccount(userId, password);

    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    expect(user.status).toBe('deleted');
    expect(user.passwordHash).toBeNull();
    expect(user.displayName).toBe('Deleted account');
    expect(user.about).toBeNull();
    expect(user.avatarObjectKey).toBeNull();

    await expect(login({ username, password, deviceId }, null, 'vitest')).rejects.toMatchObject({
      code: 'AUTH_INVALID',
    });
  });

  it('revokes every session and every device, not just the caller\'s', async () => {
    const { userId, password } = await createActiveUser();
    createdUserIds.push(userId);
    const { deviceId: deviceA } = await registerDevice(prisma, userId, fakeDeviceRegistration('A'));
    const { deviceId: deviceB } = await registerDevice(prisma, userId, fakeDeviceRegistration('B'));
    await createSession(userId, deviceA, null, 'vitest');
    await createSession(userId, deviceB, null, 'vitest');

    await deleteOwnAccount(userId, password);

    const sessions = await prisma.session.findMany({ where: { userId } });
    expect(sessions.length).toBeGreaterThan(0);
    expect(sessions.every((s) => s.revokedAt !== null)).toBe(true);

    const devices = await prisma.device.findMany({ where: { userId } });
    expect(devices).toHaveLength(2);
    expect(devices.every((d) => d.status === 'revoked' && d.revokedReason === 'user')).toBe(true);
  });

  it('records an account_deleted security event', async () => {
    const { userId, password } = await createActiveUser();
    createdUserIds.push(userId);

    await deleteOwnAccount(userId, password);

    const events = await prisma.securityEvent.findMany({ where: { userId, eventType: 'account_deleted' } });
    expect(events).toHaveLength(1);
  });
});
