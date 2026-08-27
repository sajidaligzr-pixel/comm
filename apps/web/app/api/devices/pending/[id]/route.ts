import type { NextRequest } from 'next/server';
import { RATE_LIMIT_RULES } from '@comm/security';
import { RespondPendingDeviceLoginRequest } from '@comm/types';
import { handleRoute, jsonOk } from '@/server/common/errors';
import { requireAuth, requireCsrf } from '@/server/common/auth';
import { enforceRateLimit } from '@/server/common/rate-limit';
import { parseBody } from '@/server/common/validate';
import { respondToPendingDeviceLogin } from '@/server/modules/devices/service';

// Ownership is re-checked inside respondToPendingDeviceLogin — the :id in the URL
// is never trusted on its own (docs/35-authorization.md), same as devices/[id]'s
// own DELETE (revoke).
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return handleRoute(async () => {
    const ctx = await requireAuth(req);
    requireCsrf(req);
    await enforceRateLimit(RATE_LIMIT_RULES.pendingLoginRespond, ctx.userId);
    const body = await parseBody(req, RespondPendingDeviceLoginRequest);
    const { id } = await params;
    await respondToPendingDeviceLogin(ctx.userId, id, body.approve);
    return jsonOk({ resolved: true });
  });
}
