import { describe, it, expect, afterAll } from 'vitest';
import { prisma } from '@comm/database';
import { startDeviceLink, completeDeviceLink, registerDevice } from '../modules/devices/service';
import { createActiveUser, fakeDeviceRegistration, deleteTestUser } from './helpers';

describe('device linking', () => {
  const createdUserIds: string[] = [];
  afterAll(async () => {
    await Promise.all(createdUserIds.map(deleteTestUser));
  });

  it('links a new device end-to-end: start issues a token, complete registers the device on the same account', async () => {
    const { userId } = await createActiveUser();
    createdUserIds.push(userId);
    const { deviceId: primaryDeviceId } = await registerDevice(prisma, userId, fakeDeviceRegistration('Primary'));

    const start = await startDeviceLink(userId, primaryDeviceId);
    expect(start.linkingToken).toBeTruthy();
    expect(start.primaryDeviceIdentityPublicKey).toBeTruthy();

    const result = await completeDeviceLink(start.linkingToken, fakeDeviceRegistration('New device'));
    expect(result.userId).toBe(userId);
    expect(result.deviceId).not.toBe(primaryDeviceId);

    const devices = await prisma.device.findMany({ where: { userId } });
    expect(devices).toHaveLength(2);
  });

  it('rejects reusing a linking token a second time (single-use)', async () => {
    const { userId } = await createActiveUser();
    createdUserIds.push(userId);
    const { deviceId: primaryDeviceId } = await registerDevice(prisma, userId, fakeDeviceRegistration('Primary'));

    const start = await startDeviceLink(userId, primaryDeviceId);
    await completeDeviceLink(start.linkingToken, fakeDeviceRegistration('First'));

    await expect(completeDeviceLink(start.linkingToken, fakeDeviceRegistration('Second'))).rejects.toMatchObject({
      code: 'INVITE_INVALID_OR_EXPIRED',
    });
  });

  it('rejects a linking token that was never issued', async () => {
    await expect(completeDeviceLink('not-a-real-token', fakeDeviceRegistration())).rejects.toMatchObject({
      code: 'INVITE_INVALID_OR_EXPIRED',
    });
  });

  it('resolves two concurrent completions of the same token to exactly one winner', async () => {
    const { userId } = await createActiveUser();
    createdUserIds.push(userId);
    const { deviceId: primaryDeviceId } = await registerDevice(prisma, userId, fakeDeviceRegistration('Primary'));
    const start = await startDeviceLink(userId, primaryDeviceId);

    const attempts = await Promise.allSettled([
      completeDeviceLink(start.linkingToken, fakeDeviceRegistration('Race A')),
      completeDeviceLink(start.linkingToken, fakeDeviceRegistration('Race B')),
    ]);

    expect(attempts.filter((a) => a.status === 'fulfilled')).toHaveLength(1);
    expect(attempts.filter((a) => a.status === 'rejected')).toHaveLength(1);
  });
});
