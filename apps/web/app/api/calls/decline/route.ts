import type { NextRequest } from 'next/server';
import { CallRejectRequest } from '@comm/types';
import { RATE_LIMIT_RULES } from '@comm/security';
import { handleRoute, jsonOk } from '@/server/common/errors';
import { requireAuth, requireCsrf } from '@/server/common/auth';
import { parseBody } from '@/server/common/validate';
import { enforceRateLimit } from '@/server/common/rate-limit';
import { declineCall } from '@/server/modules/calls/service';

/**
 * REST counterpart to WS `call.reject` — the one call-signaling action that has to
 * work with no socket at all. Android's "Decline" notification action button
 * (apps/mobile's local_notifications.dart, `AndroidNotificationAction(showsUserInterface:
 * false)`) fires from a background isolate that never opens the app — there is no
 * live WS connection in that isolate to send a `call.reject` frame over, the same
 * reasoning `POST /api/messages/:id/delivered` already established for delivery
 * acks (push_notifications.dart's `_ackDelivered`). The in-app Decline button still
 * uses the WS path (call_controller.dart) unchanged — this exists specifically for
 * the case that can't reach it.
 */
export async function POST(req: NextRequest) {
  return handleRoute(async () => {
    const ctx = await requireAuth(req);
    requireCsrf(req);
    await enforceRateLimit(RATE_LIMIT_RULES.callSignal, ctx.userId);
    const body = await parseBody(req, CallRejectRequest);

    await declineCall(ctx.userId, ctx.deviceId, body.conversationId, body.callId, body.reason);
    return jsonOk({ ok: true });
  });
}
