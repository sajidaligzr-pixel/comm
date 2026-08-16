import type { NextRequest } from 'next/server';
import { handleRoute, jsonOk } from '@/server/common/errors';
import { requireAuth } from '@/server/common/auth';
import { listDevices } from '@/server/modules/devices/service';

export async function GET(req: NextRequest) {
  return handleRoute(async () => {
    const ctx = await requireAuth(req);
    const devices = await listDevices(ctx.userId, ctx.deviceId);
    return jsonOk(devices);
  });
}
