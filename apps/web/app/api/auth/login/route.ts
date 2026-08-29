import type { NextRequest } from 'next/server';
import { RATE_LIMIT_RULES } from '@comm/security';
import { LoginRequest, type AuthSessionResponse } from '@comm/types';
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

    const result = await login(body, ipHash, userAgent);

    const payload: AuthSessionResponse = {
      userId: result.userId,
      deviceId: result.deviceId,
      username: result.username,
      displayName: result.displayName,
      mustChangePassword: result.mustChangePassword,
    };
    const res = jsonOk(payload);

    setAccessTokenCookie(res, result.session.accessToken, result.session.accessTokenMaxAgeSeconds);
    setRefreshTokenCookie(res, result.session.refreshToken, result.session.refreshTokenMaxAgeSeconds);
    setCsrfCookie(res);

    return res;
  });
}
