import type { NextRequest } from 'next/server';
import type { CallHistoryEntry } from '@comm/types';
import { RATE_LIMIT_RULES } from '@comm/security';
import { handleRoute, jsonOk } from '@/server/common/errors';
import { requireAuth } from '@/server/common/auth';
import { enforceRateLimit } from '@/server/common/rate-limit';
import { listCallHistory } from '@/server/modules/calls/history';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

/** The "Calls" tab (apps/mobile) — see server/modules/calls/history.ts's own
 * docstring. Read-only, no CSRF check needed, same reasoning as `GET /calls/pending`. */
export async function GET(req: NextRequest) {
  return handleRoute(async () => {
    const ctx = await requireAuth(req);
    await enforceRateLimit(RATE_LIMIT_RULES.callHistory, ctx.userId);

    const requested = Number(req.nextUrl.searchParams.get('limit'));
    const limit = Number.isFinite(requested) && requested > 0 ? Math.min(requested, MAX_LIMIT) : DEFAULT_LIMIT;

    const entries: CallHistoryEntry[] = await listCallHistory(ctx.userId, limit);
    return jsonOk({ calls: entries });
  });
}
