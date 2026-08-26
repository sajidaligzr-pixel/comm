import { prisma } from '@comm/database';
import { AppError, type LocationPing, type LiveLocation, type LocationViewerDto } from '@comm/types';
import { publishLocationUpdate } from '../../realtime/bus';

/**
 * Live location sharing (docs/09-trust-boundaries.md's "Live location sharing"
 * exception) — the one place in this app that deliberately stores and reads plaintext
 * user content server-side. Every function here either accepts a ping from the
 * sharing user's own device (no special privilege needed) or requires
 * `requireLocationAccess`/`requireAdmin` at the call site (routes), never trusting a
 * client-asserted role.
 */

function toLiveLocation(row: {
  userId: string;
  latitude: number;
  longitude: number;
  accuracyM: number | null;
  headingDeg: number | null;
  speedMps: number | null;
  recordedAt: Date;
  updatedAt: Date;
  user: { username: string; displayName: string };
}): LiveLocation {
  return {
    userId: row.userId,
    username: row.user.username,
    displayName: row.user.displayName,
    latitude: row.latitude,
    longitude: row.longitude,
    accuracyM: row.accuracyM,
    headingDeg: row.headingDeg,
    speedMps: row.speedMps,
    recordedAt: row.recordedAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Every OTHER active device belonging to every current viewer (every `Admin` plus
 * every granted `LocationViewer`) — the fan-out target set for a `location.updated`
 * push, in the shape of `getAllOtherMembersActiveDeviceIds`
 * (conversations/service.ts). Not excluding the sharer's own devices: an admin who is
 * themselves being tracked should still see their own pin update live on their other
 * signed-in devices.
 */
async function getLocationViewerDeviceIds(): Promise<string[]> {
  const [admins, viewers] = await Promise.all([
    prisma.admin.findMany({ select: { userId: true } }),
    prisma.locationViewer.findMany({ select: { userId: true } }),
  ]);
  const viewerUserIds = [...new Set([...admins.map((a) => a.userId), ...viewers.map((v) => v.userId)])];
  if (viewerUserIds.length === 0) return [];

  const devices = await prisma.device.findMany({
    where: { userId: { in: viewerUserIds }, status: 'active' },
    select: { id: true },
  });
  return devices.map((d) => d.id);
}

/** Any signed-in device may report its own location — sharing itself needs no
 * special privilege, only viewing does. Upserts the single latest-fix row, then
 * fans the update out live to every current viewer's active devices. */
export async function upsertMyLocation(userId: string, deviceId: string, ping: LocationPing): Promise<void> {
  const recordedAt = new Date(ping.recordedAt);

  const row = await prisma.userLocation.upsert({
    where: { userId },
    create: {
      userId,
      deviceId,
      latitude: ping.latitude,
      longitude: ping.longitude,
      accuracyM: ping.accuracyM,
      headingDeg: ping.headingDeg,
      speedMps: ping.speedMps,
      recordedAt,
    },
    update: {
      deviceId,
      latitude: ping.latitude,
      longitude: ping.longitude,
      accuracyM: ping.accuracyM,
      headingDeg: ping.headingDeg,
      speedMps: ping.speedMps,
      recordedAt,
    },
    include: { user: { select: { username: true, displayName: true } } },
  });

  const location = toLiveLocation(row);
  const targetDeviceIds = await getLocationViewerDeviceIds();
  await Promise.all(targetDeviceIds.map((targetDeviceId) => publishLocationUpdate(targetDeviceId, location)));
}

/** Caller must already be authorized via `requireLocationAccess` at the route. */
export async function listLiveLocations(): Promise<LiveLocation[]> {
  const rows = await prisma.userLocation.findMany({
    include: { user: { select: { username: true, displayName: true } } },
    orderBy: { updatedAt: 'desc' },
  });
  return rows.map(toLiveLocation);
}

/** Caller must already be authorized via `requireAdmin` at the route. */
export async function grantLocationViewer(adminUserId: string, targetUsername: string): Promise<LocationViewerDto> {
  const admin = await prisma.admin.findUniqueOrThrow({ where: { userId: adminUserId } });
  const target = await prisma.user.findUnique({ where: { username: targetUsername } });
  if (!target || target.status !== 'active') {
    throw new AppError('NOT_FOUND', 'User not found.');
  }

  const row = await prisma.locationViewer.upsert({
    where: { userId: target.id },
    create: { userId: target.id, grantedByAdminId: admin.id },
    update: {}, // idempotent — re-granting an existing viewer is a no-op, not an error
    include: { user: { select: { username: true, displayName: true } } },
  });

  return {
    userId: row.userId,
    username: row.user.username,
    displayName: row.user.displayName,
    grantedAt: row.createdAt.toISOString(),
  };
}

/** Caller must already be authorized via `requireAdmin` at the route. */
export async function revokeLocationViewer(targetUserId: string): Promise<void> {
  await prisma.locationViewer.deleteMany({ where: { userId: targetUserId } });
}

/** Non-throwing check used for UI decisions (e.g. whether to show the "Location Map"
 * nav link) — never used for the actual authorization decision, which always goes
 * through `requireLocationAccess` instead (same convention as `admin/service.ts`'s
 * own `isAdmin`). */
export async function hasLocationAccess(userId: string): Promise<boolean> {
  const [admin, viewer] = await Promise.all([
    prisma.admin.findUnique({ where: { userId } }),
    prisma.locationViewer.findUnique({ where: { userId } }),
  ]);
  return admin !== null || viewer !== null;
}

/** Caller must already be authorized via `requireAdmin` at the route. */
export async function listLocationViewers(): Promise<LocationViewerDto[]> {
  const rows = await prisma.locationViewer.findMany({
    orderBy: { createdAt: 'desc' },
    include: { user: { select: { username: true, displayName: true } } },
  });
  return rows.map((row) => ({
    userId: row.userId,
    username: row.user.username,
    displayName: row.user.displayName,
    grantedAt: row.createdAt.toISOString(),
  }));
}
