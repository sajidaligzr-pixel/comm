import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { RATE_LIMIT_RULES } from '@comm/security';
import { APP_ERROR_STATUS, errorEnvelope } from '@comm/types';
import { handleRoute, jsonOk, AppError } from '@/server/common/errors';
import { enforceRateLimitByIp } from '@/server/common/rate-limit';
import { getClientIp, hashIp } from '@/server/common/ip';
import {
  REFRESH_TOKEN_COOKIE,
  setAccessTokenCookie,
  setRefreshTokenCookie,
  clearAuthCookies,
} from '@/server/common/cookies';
import { rotateSession } from '@/server/modules/auth/session';

export async function POST(req: NextRequest) {
  return handleRoute(async () => {
    await enforceRateLimitByIp(RATE_LIMIT_RULES.refresh, req);

    const rawRefreshToken = req.cookies.get(REFRESH_TOKEN_COOKIE)?.value;
    if (!rawRefreshToken) {
      throw new AppError('AUTH_INVALID', 'Not signed in.');
    }

    const ipHash = hashIp(getClientIp(req));
    const userAgent = req.headers.get('user-agent');

    try {
      const session = await rotateSession(rawRefreshToken, ipHash, userAgent);
      const res = jsonOk({ rotated: true });
      setAccessTokenCookie(res, session.accessToken, session.accessTokenMaxAgeSeconds);
      setRefreshTokenCookie(res, session.refreshToken, session.refreshTokenMaxAgeSeconds);
      return res;
    } catch (err) {
      if (err instanceof AppError) {
        // On any refresh failure (expired, revoked, or reused-token-detected — see
        // docs/07-auth-architecture.md), clear cookies here directly rather than
        // letting handleRoute's generic error mapping run, so the browser stops
        // presenting a dead refresh token in a retry loop.
        const res = NextResponse.json(errorEnvelope(err), { status: APP_ERROR_STATUS[err.code] });
        clearAuthCookies(res);
        return res;
      }
      throw err;
    }
  });
}
