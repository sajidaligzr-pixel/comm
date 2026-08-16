import type { NextRequest } from 'next/server';
import { RATE_LIMIT_RULES } from '@comm/security';
import { InviteRedeemRequest, type AuthSessionResponse } from '@comm/types';
import { handleRoute, jsonOk } from '@/server/common/errors';
import { parseBody } from '@/server/common/validate';
import { enforceRateLimitByIp } from '@/server/common/rate-limit';
import { getClientIp, hashIp } from '@/server/common/ip';
import { setAccessTokenCookie, setRefreshTokenCookie, setCsrfCookie } from '@/server/common/cookies';
import { redeemInvite } from '@/server/modules/auth/service';

// Public — the only account-activation path in this system (docs/07-auth-architecture.md).
export async function POST(req: NextRequest) {
  return handleRoute(async () => {
    await enforceRateLimitByIp(RATE_LIMIT_RULES.inviteRedeem, req);

    const body = await parseBody(req, InviteRedeemRequest);
    const ipHash = hashIp(getClientIp(req));
    const userAgent = req.headers.get('user-agent');

    const result = await redeemInvite(
      { token: body.token, password: body.password, device: body.device },
      ipHash,
      userAgent,
    );

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
