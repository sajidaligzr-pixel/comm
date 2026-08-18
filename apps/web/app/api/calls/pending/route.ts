import type { NextRequest } from 'next/server';
import type { PendingCallResponse } from '@comm/types';
import { RATE_LIMIT_RULES } from '@comm/security';
import { handleRoute, jsonOk } from '@/server/common/errors';
import { requireAuth } from '@/server/common/auth';
import { enforceRateLimit } from '@/server/common/rate-limit';
import { getPendingCall } from '@/server/modules/calls/pending';

/**
 * The REST catch-up half of call push notifications (apps/mobile's push notification
 * pass — see server/modules/calls/pending.ts's own docstring for the durability gap
 * this closes). GET, not POST: this only reads state, same reasoning as every other
 * read-only route in this app; no CSRF check needed for the same reason those don't
 * carry one either. Checked once right after a WS reconnect/app-resume — see
 * ws_client.dart's `reconnect` and call_controller.dart's `checkPendingCall`.
 */
export async function GET(req: NextRequest) {
  return handleRoute(async () => {
    const ctx = await requireAuth(req);
    await enforceRateLimit(RATE_LIMIT_RULES.callPendingCheck, ctx.userId);
    const pending: PendingCallResponse = await getPendingCall(ctx.deviceId);
    return jsonOk(pending);
  });
}
