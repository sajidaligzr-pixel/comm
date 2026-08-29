import type { NextRequest } from 'next/server';
import { CallRingingRequest } from '@comm/types';
import { RATE_LIMIT_RULES } from '@comm/security';
import { handleRoute, jsonOk } from '@/server/common/errors';
import { requireAuth, requireCsrf } from '@/server/common/auth';
import { parseBody } from '@/server/common/validate';
import { enforceRateLimit } from '@/server/common/rate-limit';
import { ackCallRinging } from '@/server/modules/calls/service';

/**
 * REST counterpart to WS `call.ringing` — same "the one call-signaling action
 * that has to work with no socket at all" reasoning as
 * `POST /api/calls/decline` (see that route's own docstring), for the case
 * `CallRingingRequest`'s own docstring (packages/types/src/calls.ts) flags: an
 * incoming-call push reaching a fully-terminated Android app is handled
 * entirely inside a background isolate (push_notifications.dart's
 * `firebaseMessagingBackgroundHandler` → `showIncomingCall`) that never spins
 * up `CallController`/its live WS at all — so without this, the caller's
 * "Calling…" never became "Ringing…" even though the callee's phone was
 * visibly ringing right in front of them. The in-app path (call_controller.
 * dart's `_onRing`) still sends over WS unchanged — this exists specifically
 * for the case that can't reach it.
 */
export async function POST(req: NextRequest) {
  return handleRoute(async () => {
    const ctx = await requireAuth(req);
    requireCsrf(req);
    await enforceRateLimit(RATE_LIMIT_RULES.callSignal, ctx.userId);
    const body = await parseBody(req, CallRingingRequest);

    await ackCallRinging(ctx.userId, body.conversationId, body.callId);
    return jsonOk({ ok: true });
  });
}
