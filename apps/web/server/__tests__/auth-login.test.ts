import { describe, it, expect, afterAll } from 'vitest';
import { prisma } from '@comm/database';
import { login } from '../modules/auth/service';
import { registerDevice } from '../modules/devices/service';
import { createActiveUser, fakeDeviceRegistration, deleteTestUser } from './helpers';

describe('login', () => {
  const createdUserIds: string[] = [];
  afterAll(async () => {
    await Promise.all(createdUserIds.map(deleteTestUser));
  });

  it('logs in with correct credentials and a new device, recording security events', async () => {
    const { userId, username, password } = await createActiveUser();
    createdUserIds.push(userId);

    const outcome = await login({ username, password, newDevice: fakeDeviceRegistration() }, null, 'vitest');

    // A brand-new account's very first device (created via createActiveUser
    // above, no prior devices) has nothing to approve against, so this still
    // completes immediately — see login()'s own docstring.
    if (outcome.status !== 'ok') throw new Error(`expected 'ok', got ${outcome.status}`);
    expect(outcome.result.userId).toBe(userId);
    expect(outcome.result.session.accessToken).toBeTruthy();

    const events = await prisma.securityEvent.findMany({ where: { userId }, orderBy: { createdAt: 'asc' } });
    const types = events.map((e) => e.eventType);
    expect(types).toContain('new_device_linked');
    expect(types).toContain('login_success');
  });

  it('logs in with an already-known device by id, without creating a second device row', async () => {
    const { userId, username, password } = await createActiveUser();
    createdUserIds.push(userId);

    const first = await login({ username, password, newDevice: fakeDeviceRegistration() }, null, 'vitest');
    if (first.status !== 'ok') throw new Error(`expected 'ok', got ${first.status}`);
    await login({ username, password, deviceId: first.result.deviceId }, null, 'vitest');

    const devices = await prisma.device.findMany({ where: { userId } });
    expect(devices).toHaveLength(1);
  });

  it('rejects an incorrect password and records login_failed', async () => {
    const { userId, username } = await createActiveUser();
    createdUserIds.push(userId);

    await expect(
      login({ username, password: 'definitely-the-wrong-password', newDevice: fakeDeviceRegistration() }, null, 'vitest'),
    ).rejects.toMatchObject({ code: 'AUTH_INVALID' });

    const events = await prisma.securityEvent.findMany({ where: { userId } });
    expect(events.map((e) => e.eventType)).toContain('login_failed');
  });

  it('rejects login for a nonexistent username with the same error as a wrong password (no user-existence oracle)', async () => {
    let wrongPasswordErr: unknown;
    let noSuchUserErr: unknown;
    const { userId, username } = await createActiveUser();
    createdUserIds.push(userId);

    try {
      await login({ username, password: 'nope-not-it', newDevice: fakeDeviceRegistration() }, null, 'vitest');
    } catch (err) {
      wrongPasswordErr = err;
    }
    try {
      await login(
        { username: `${username}-does-not-exist`, password: 'nope-not-it', newDevice: fakeDeviceRegistration() },
        null,
        'vitest',
      );
    } catch (err) {
      noSuchUserErr = err;
    }

    expect((wrongPasswordErr as { code: string }).code).toBe((noSuchUserErr as { code: string }).code);
    expect((wrongPasswordErr as { message: string }).message).toBe((noSuchUserErr as { message: string }).message);
  });

  it('rejects login for a suspended account even with the correct password', async () => {
    const { userId, username, password } = await createActiveUser();
    createdUserIds.push(userId);
    await prisma.user.update({ where: { id: userId }, data: { status: 'suspended' } });

    await expect(
      login({ username, password, newDevice: fakeDeviceRegistration() }, null, 'vitest'),
    ).rejects.toMatchObject({ code: 'AUTH_INVALID' });
  });

  it('rejects login for a pending_invite account (never redeemed) even if a password hash somehow existed', async () => {
    const { userId, username, password } = await createActiveUser();
    createdUserIds.push(userId);
    await prisma.user.update({ where: { id: userId }, data: { status: 'pending_invite' } });

    await expect(
      login({ username, password, newDevice: fakeDeviceRegistration() }, null, 'vitest'),
    ).rejects.toMatchObject({ code: 'AUTH_INVALID' });
  });

  it('rejects login with a deviceId that belongs to a different account (IDOR)', async () => {
    const userA = await createActiveUser();
    const userB = await createActiveUser();
    createdUserIds.push(userA.userId, userB.userId);

    const { deviceId } = await registerDevice(prisma, userA.userId, fakeDeviceRegistration());

    await expect(
      login({ username: userB.username, password: userB.password, deviceId }, null, 'vitest'),
    ).rejects.toMatchObject({ code: 'DEVICE_REVOKED' });
  });

  it('rejects login with a revoked deviceId', async () => {
    const { userId, username, password } = await createActiveUser();
    createdUserIds.push(userId);
    const { deviceId } = await registerDevice(prisma, userId, fakeDeviceRegistration());
    await prisma.device.update({ where: { id: deviceId }, data: { status: 'revoked', revokedAt: new Date() } });

    await expect(login({ username, password, deviceId }, null, 'vitest')).rejects.toMatchObject({
      code: 'DEVICE_REVOKED',
    });
  });
});
