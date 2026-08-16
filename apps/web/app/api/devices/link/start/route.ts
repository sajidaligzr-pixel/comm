import type { NextRequest } from 'next/server';
import { handleRoute, jsonOk } from '@/server/common/errors';
import { requireAuth, requireCsrf } from '@/server/common/auth';
import { startDeviceLink } from '@/server/modules/devices/service';

// Called by an already-authenticated ("primary") device — see docs/06-device-architecture.md's
// linking flow. The response is rendered as a QR code for the new device to scan.
export async function POST(req: NextRequest) {
  return handleRoute(async () => {
    const ctx = await requireAuth(req);
    requireCsrf(req);
    const result = await startDeviceLink(ctx.userId, ctx.deviceId);
    return jsonOk(result);
  });
}
