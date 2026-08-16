import type { NextRequest } from 'next/server';
import { RATE_LIMIT_RULES } from '@comm/security';
import { LinkDeviceCompleteRequest, type AuthSessionResponse } from '@comm/types';
import { handleRoute, jsonOk } from '@/server/common/errors';
import { parseBody } from '@/server/common/validate';
import { enforceRateLimitByIp } from '@/server/common/rate-limit';
import { getClientIp, hashIp } from '@/server/common/ip';
import { setAccessTokenCookie, setRefreshTokenCookie, setCsrfCookie } from '@/server/common/cookies';
import { completeDeviceLink } from '@/server/modules/devices/service';
import { createSession } from '@/server/modules/auth/session';

// Public — called by the NEW device, which has no session yet. Protected by the
// linking token's own secrecy/short TTL + rate limiting, not by auth
// (docs/06-device-architecture.md). On success the new device is immediately signed
// in, same as a completed login — that's the entire point of linking.
export async function POST(req: NextRequest) {
  return handleRoute(async () => {
    await enforceRateLimitByIp(RATE_LIMIT_RULES.deviceLinkComplete, req);

    const body = await parseBody(req, LinkDeviceCompleteRequest);
    const { userId, deviceId, username, displayName, mustChangePassword } = await completeDeviceLink(
      body.linkingToken,
      body.device,
    );

    const ipHash = hashIp(getClientIp(req));
    const userAgent = req.headers.get('user-agent');
    const session = await createSession(userId, deviceId, ipHash, userAgent);

    const payload: AuthSessionResponse = { userId, deviceId, username, displayName, mustChangePassword };
    const res = jsonOk(payload);
    setAccessTokenCookie(res, session.accessToken, session.accessTokenMaxAgeSeconds);
    setRefreshTokenCookie(res, session.refreshToken, session.refreshTokenMaxAgeSeconds);
    setCsrfCookie(res);
    return res;
  });
}
