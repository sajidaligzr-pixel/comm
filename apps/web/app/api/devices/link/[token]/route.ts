import type { NextRequest } from 'next/server';
import { RATE_LIMIT_RULES } from '@comm/security';
import { handleRoute, jsonOk } from '@/server/common/errors';
import { enforceRateLimitByIp } from '@/server/common/rate-limit';
import { getDeviceLinkInfo } from '@/server/modules/devices/service';

// Public — mirrors apps/web/app/api/auth/invite/[token]/route.ts exactly, including
// the rate limiting reasoning: a linking token is a guessing target just like an
// invite token, and this is the cheapest way to probe one. Non-destructive (see
// getDeviceLinkInfo's docstring) — never consumes the token, only completeDeviceLink
// does that.
export async function GET(req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  return handleRoute(async () => {
    await enforceRateLimitByIp(RATE_LIMIT_RULES.deviceLinkLookup, req);
    const { token } = await params;
    const info = await getDeviceLinkInfo(token);
    return jsonOk(info);
  });
}
