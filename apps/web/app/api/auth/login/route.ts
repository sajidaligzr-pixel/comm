import type { NextRequest } from 'next/server';
import { RATE_LIMIT_RULES } from '@comm/security';
import { LoginRequest, type LoginResponse } from '@comm/types';
import { handleRoute, jsonOk } from '@/server/common/errors';
import { parseBody } from '@/server/common/validate';
import { enforceCombinedRateLimit } from '@/server/common/rate-limit';
import { getClientIp, hashIp } from '@/server/common/ip';
import { setAccessTokenCookie, setRefreshTokenCookie, setCsrfCookie } from '@/server/common/cookies';
import { login } from '@/server/modules/auth/service';

// Public — see docs/07-auth-architecture.md's brute-force protection: independent
// per-account AND per-IP buckets, both enforced, so spraying one password across many
// accounts from one IP doesn't hide inside each account's individually-fresh bucket.
export async function POST(req: NextRequest) {
  return handleRoute(async () => {
    const body = await parseBody(req, LoginRequest);

    await enforceCombinedRateLimit(req, [
      { rule: RATE_LIMIT_RULES.loginByAccount, accountIdentity: body.username },
      { rule: RATE_LIMIT_RULES.loginByIp },
    ]);

    const ipHash = hashIp(getClientIp(req));
    const userAgent = req.headers.get('user-agent');

    const outcome = await login(body, ipHash, userAgent);

    if (outcome.status === 'pending_approval') {
      // No cookies set — this device isn't signed in yet. The client polls
      // GET /api/auth/login/pending/:id (docs/07-auth-architecture.md) until an
      // existing device approves/denies it.
      const payload: LoginResponse = { status: 'pending_approval', pendingLoginId: outcome.pendingLoginId, expiresAt: outcome.expiresAt };
      return jsonOk(payload);
    }

    const payload: LoginResponse = {
      status: 'ok',
      userId: outcome.result.userId,
      deviceId: outcome.result.deviceId,
      username: outcome.result.username,
      displayName: outcome.result.displayName,
      mustChangePassword: outcome.result.mustChangePassword,
    };
    const res = jsonOk(payload);

    setAccessTokenCookie(res, outcome.result.session.accessToken, outcome.result.session.accessTokenMaxAgeSeconds);
    setRefreshTokenCookie(res, outcome.result.session.refreshToken, outcome.result.session.refreshTokenMaxAgeSeconds);
    setCsrfCookie(res);

    return res;
  });
}
