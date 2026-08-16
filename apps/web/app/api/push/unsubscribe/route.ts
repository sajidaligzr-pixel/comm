import type { NextRequest } from 'next/server';
import { handleRoute, jsonOk } from '@/server/common/errors';
import { requireAuth, requireCsrf } from '@/server/common/auth';
import { deletePushSubscription } from '@/server/modules/push/service';

export async function POST(req: NextRequest) {
  return handleRoute(async () => {
    const ctx = await requireAuth(req);
    requireCsrf(req);
    await deletePushSubscription(ctx.deviceId);
    return jsonOk({ subscribed: false });
  });
}
