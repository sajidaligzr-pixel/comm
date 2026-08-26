import { describe, it, expect, afterAll } from 'vitest';
import type { AuthContext } from '../../common/auth';
import { requireAdmin, requireLocationAccess } from '../../common/auth';
import { registerDevice } from '../../modules/devices/service';
import {
  upsertMyLocation,
  listLiveLocations,
  grantLocationViewer,
  revokeLocationViewer,
  listLocationViewers,
  hasLocationAccess,
} from '../../modules/locations/service';
import { createActiveUser, createAdminUser, fakeDeviceRegistration, deleteTestUser } from '../helpers';
import { prisma } from '@comm/database';

/**
 * Live location sharing (docs/09-trust-boundaries.md's "Live location sharing"
 * exception) — the one feature in this app that deliberately stores/reads plaintext
 * user content server-side, so its authorization boundary matters more, not less,
 * than everywhere else. Mirrors authorization.test.ts's "admin-only operations"
 * shape for the FORBIDDEN/allowed split, plus service-level coverage for the parts
 * that are genuinely new here (the LocationViewer grant, and that sharing itself
 * needs no special privilege).
 */
describe('live location sharing', () => {
  const createdUserIds: string[] = [];
  afterAll(async () => {
    await Promise.all(createdUserIds.map(deleteTestUser));
  });

  async function makeUserWithDevice(prefix: string) {
    const user = await createActiveUser();
    createdUserIds.push(user.userId);
    const { deviceId } = await registerDevice(prisma, user.userId, fakeDeviceRegistration(`${prefix} device`));
    return { ...user, deviceId };
  }

  it('rejects a plain user from requireLocationAccess', async () => {
    const user = await makeUserWithDevice('plain');
    const ctx: AuthContext = { userId: user.userId, deviceId: user.deviceId, sessionId: 'n/a' };
    await expect(requireLocationAccess(ctx)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(await hasLocationAccess(user.userId)).toBe(false);
  });

  it('allows an admin through requireLocationAccess without any explicit grant', async () => {
    const admin = await createAdminUser();
    createdUserIds.push(admin.userId);
    const ctx: AuthContext = { userId: admin.userId, deviceId: 'n/a', sessionId: 'n/a' };
    await expect(requireLocationAccess(ctx)).resolves.toBeUndefined();
    expect(await hasLocationAccess(admin.userId)).toBe(true);
  });

  it('rejects a non-admin from granting/revoking/listing viewers', async () => {
    const user = await makeUserWithDevice('non-admin');
    const ctx: AuthContext = { userId: user.userId, deviceId: user.deviceId, sessionId: 'n/a' };
    await expect(requireAdmin(ctx)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('an admin can grant a plain user LocationViewer access, idempotently, and revoke it', async () => {
    const admin = await createAdminUser();
    createdUserIds.push(admin.userId);
    const target = await makeUserWithDevice('grantee');

    const granted = await grantLocationViewer(admin.userId, target.username);
    expect(granted).toMatchObject({ userId: target.userId, username: target.username });
    await grantLocationViewer(admin.userId, target.username); // idempotent, not an error

    expect(await hasLocationAccess(target.userId)).toBe(true);
    const targetCtx: AuthContext = { userId: target.userId, deviceId: target.deviceId, sessionId: 'n/a' };
    await expect(requireLocationAccess(targetCtx)).resolves.toBeUndefined();
    // A granted viewer gains ONLY location access, not the admin role itself.
    await expect(requireAdmin(targetCtx)).rejects.toMatchObject({ code: 'FORBIDDEN' });

    const viewers = await listLocationViewers();
    expect(viewers.map((v) => v.userId)).toContain(target.userId);

    await revokeLocationViewer(target.userId);
    expect(await hasLocationAccess(target.userId)).toBe(false);
    await expect(requireLocationAccess(targetCtx)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('any signed-in device can report its own location regardless of role, and a viewer sees the live update', async () => {
    const sharer = await makeUserWithDevice('sharer');
    const admin = await createAdminUser();
    createdUserIds.push(admin.userId);

    // Sharing needs no requireLocationAccess/requireAdmin check at all — enforced at
    // the route (POST /api/locations only calls requireAuth), matching the fact this
    // function itself takes no role parameter.
    await upsertMyLocation(sharer.userId, sharer.deviceId, {
      latitude: 37.7749,
      longitude: -122.4194,
      accuracyM: 5,
      headingDeg: null,
      speedMps: null,
      recordedAt: new Date().toISOString(),
    });

    const live = await listLiveLocations();
    const mine = live.find((l) => l.userId === sharer.userId);
    expect(mine).toMatchObject({ userId: sharer.userId, latitude: 37.7749, longitude: -122.4194 });

    // A second ping upserts (one row per user), it doesn't accumulate history.
    await upsertMyLocation(sharer.userId, sharer.deviceId, {
      latitude: 37.7,
      longitude: -122.4,
      accuracyM: null,
      headingDeg: 90,
      speedMps: 1.5,
      recordedAt: new Date().toISOString(),
    });
    const liveAfter = await listLiveLocations();
    expect(liveAfter.filter((l) => l.userId === sharer.userId)).toHaveLength(1);
  });
});
