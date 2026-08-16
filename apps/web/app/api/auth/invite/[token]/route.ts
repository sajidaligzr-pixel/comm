import type { NextRequest } from 'next/server';
import { RATE_LIMIT_RULES } from '@comm/security';
import { handleRoute, jsonOk } from '@/server/common/errors';
import { enforceRateLimitByIp } from '@/server/common/rate-limit';
import { getInviteInfo } from '@/server/modules/auth/service';

// Public — see docs/03-api-design.md's /auth table. Rate-limited hard: an invite
// token is a guessing target, and this route is the cheapest way to probe one.
export async function GET(req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  return handleRoute(async () => {
    await enforceRateLimitByIp(RATE_LIMIT_RULES.inviteLookup, req);
    const { token } = await params;
    const info = await getInviteInfo(token);
    return jsonOk(info);
  });
}
