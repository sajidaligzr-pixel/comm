import { describe, it, expect, afterAll } from 'vitest';
import { prisma } from '@comm/database';
import { AppError } from '@comm/types';
import { requireAdmin, type AuthContext } from '../../common/auth';
import { revokeDevice, listDevices } from '../../modules/devices/service';
import { registerDevice } from '../../modules/devices/service';
import { provisionUser } from '../../modules/admin/service';
import { createActiveUser, createAdminUser, fakeDeviceRegistration, uniqueUsername, deleteTestUser } from '../helpers';

/**
 * docs/35-authorization.md's core rule: every protected operation re-derives
 * authorization from the database, never trusting a client-supplied id/role. These
 * tests attack exactly that boundary — see docs/12-testing-strategy.md's IDOR and
 * privilege-escalation cases.
 */
describe('authorization', () => {
  const createdUserIds: string[] = [];
  afterAll(async () => {
    await Promise.all(createdUserIds.map(deleteTestUser));
  });

  describe('device revocation (IDOR)', () => {
    it('lets an owner revoke their own device', async () => {
      const { userId } = await createActiveUser();
      createdUserIds.push(userId);
      const { deviceId } = await registerDevice(prisma, userId, fakeDeviceRegistration());

      await revokeDevice(userId, deviceId, 'user');

      const device = await prisma.device.findUniqueOrThrow({ where: { id: deviceId } });
      expect(device.status).toBe('revoked');
    });

    it("rejects revoking another user's device", async () => {
      const owner = await createActiveUser();
      const attacker = await createActiveUser();
      createdUserIds.push(owner.userId, attacker.userId);
      const { deviceId } = await registerDevice(prisma, owner.userId, fakeDeviceRegistration());

      await expect(revokeDevice(attacker.userId, deviceId, 'user')).rejects.toMatchObject({ code: 'NOT_FOUND' });

      // And the device must be untouched.
      const device = await prisma.device.findUniqueOrThrow({ where: { id: deviceId } });
      expect(device.status).toBe('active');
    });

    it('does not leak whether a device id exists at all to a non-owner (NOT_FOUND either way)', async () => {
      const attacker = await createActiveUser();
      createdUserIds.push(attacker.userId);

      const owner = await createActiveUser();
      createdUserIds.push(owner.userId);
      const { deviceId: realButNotOwnedDeviceId } = await registerDevice(prisma, owner.userId, fakeDeviceRegistration());

      let errorForRealDevice: unknown;
      let errorForFakeDevice: unknown;
      try {
        await revokeDevice(attacker.userId, realButNotOwnedDeviceId, 'user');
      } catch (err) {
        errorForRealDevice = err;
      }
      try {
        await revokeDevice(attacker.userId, '00000000-0000-0000-0000-000000000000', 'user');
      } catch (err) {
        errorForFakeDevice = err;
      }

      expect((errorForRealDevice as AppError).code).toBe((errorForFakeDevice as AppError).code);
    });

    it("excludes another user's devices from listDevices — only the caller's own are returned", async () => {
      const userA = await createActiveUser();
      const userB = await createActiveUser();
      createdUserIds.push(userA.userId, userB.userId);
      await registerDevice(prisma, userA.userId, fakeDeviceRegistration());
      const { deviceId: bDeviceId } = await registerDevice(prisma, userB.userId, fakeDeviceRegistration());

      const listForA = await listDevices(userA.userId, 'irrelevant-current-device-id');
      expect(listForA.some((d) => d.id === bDeviceId)).toBe(false);
    });
  });

  describe('admin-only operations', () => {
    it('rejects a non-admin user from requireAdmin', async () => {
      const { userId } = await createActiveUser();
      createdUserIds.push(userId);

      const ctx: AuthContext = { userId, deviceId: 'n/a', sessionId: 'n/a' };
      await expect(requireAdmin(ctx)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    });

    it('allows an admin user through requireAdmin', async () => {
      const { userId } = await createAdminUser();
      createdUserIds.push(userId);

      const ctx: AuthContext = { userId, deviceId: 'n/a', sessionId: 'n/a' };
      await expect(requireAdmin(ctx)).resolves.toMatchObject({ role: 'superadmin' });
    });

    it('rejects account provisioning attempted by a userId that is not actually an admin', async () => {
      // Exercises the service function directly with a spoofed adminUserId — this is
      // exactly the "never trust a client-claimed role" scenario: even if a bug
      // upstream let a non-admin's id reach this function, it must re-verify.
      const { userId } = await createActiveUser();
      createdUserIds.push(userId);

      await expect(
        provisionUser(userId, { username: uniqueUsername('t_should_not_exist'), displayName: 'x', inviteTtlHours: 24 }),
      ).rejects.toThrow();
    });

    it('lets a real admin provision a user and generates a valid invite', async () => {
      const { userId: adminUserId } = await createAdminUser();
      createdUserIds.push(adminUserId);

      const username = uniqueUsername('t_provisioned');
      const result = await provisionUser(adminUserId, { username, displayName: 'New Person', inviteTtlHours: 24 });
      createdUserIds.push(result.userId);

      expect(result.username).toBe(username);
      expect(result.inviteUrl).toContain('/invite/');

      const created = await prisma.user.findUniqueOrThrow({ where: { id: result.userId } });
      expect(created.status).toBe('pending_invite');
      expect(created.passwordHash).toBeNull(); // admin never sets a password — docs/07
    });
  });
});
