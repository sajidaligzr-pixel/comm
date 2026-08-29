import type { NextRequest } from 'next/server';
import { VoipPushTokenRequest } from '@comm/types';
import { RATE_LIMIT_RULES } from '@comm/security';
import { handleRoute, jsonOk } from '@/server/common/errors';
import { requireAuth, requireCsrf } from '@/server/common/auth';
import { parseBody } from '@/server/common/validate';
import { enforceRateLimit } from '@/server/common/rate-limit';
import { saveVoipPushToken, deleteVoipPushToken } from '@/server/modules/push/service';

// The token belongs to THIS device (`ctx.deviceId` from the authenticated session),
// never a client-claimed device id — same authorization pattern as
// /api/push/subscribe. iOS only (apps/mobile's call_kit.dart) — see VoipPushToken's
// own schema doc comment for why this is a separate route/table from the regular
// push-subscribe one, not a third provider value on it.
export async function POST(req: NextRequest) {
  return handleRoute(async () => {
    const ctx = await requireAuth(req);
    requireCsrf(req);
    await enforceRateLimit(RATE_LIMIT_RULES.voipPushTokenSubscribe, ctx.userId);
    const body = await parseBody(req, VoipPushTokenRequest);
    await saveVoipPushToken(ctx.deviceId, body);
    return jsonOk({ subscribed: true });
  });
}

export async function DELETE(req: NextRequest) {
  return handleRoute(async () => {
    const ctx = await requireAuth(req);
    requireCsrf(req);
    await deleteVoipPushToken(ctx.deviceId);
    return jsonOk({ subscribed: false });
  });
}
