import type { NextRequest } from 'next/server';
import { PushSubscriptionRequest } from '@comm/types';
import { RATE_LIMIT_RULES } from '@comm/security';
import { handleRoute, jsonOk } from '@/server/common/errors';
import { requireAuth, requireCsrf } from '@/server/common/auth';
import { parseBody } from '@/server/common/validate';
import { enforceRateLimit } from '@/server/common/rate-limit';
import { savePushSubscription } from '@/server/modules/push/service';

// The subscription belongs to THIS device (`ctx.deviceId` from the authenticated
// session), never a client-claimed device id — same authorization pattern as every
// other device-scoped route in this app.
export async function POST(req: NextRequest) {
  return handleRoute(async () => {
    const ctx = await requireAuth(req);
    requireCsrf(req);
    await enforceRateLimit(RATE_LIMIT_RULES.pushSubscribe, ctx.userId);
    const body = await parseBody(req, PushSubscriptionRequest);
    await savePushSubscription(ctx.deviceId, body);
    return jsonOk({ subscribed: true });
  });
}
