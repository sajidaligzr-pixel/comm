import type { NextRequest } from 'next/server';
import { RATE_LIMIT_RULES } from '@comm/security';
import type { PendingLoginPollResponse } from '@comm/types';
import { handleRoute, jsonOk } from '@/server/common/errors';
import { enforceRateLimitByIp } from '@/server/common/rate-limit';
import { setAccessTokenCookie, setRefreshTokenCookie, setCsrfCookie } from '@/server/common/cookies';
import { completePendingDeviceLogin } from '@/server/modules/devices/service';

/**
 * Public — no auth possible yet, this device hasn't signed in. The `id` itself is
 * the bearer capability (a random UUID nobody could guess), same unauthenticated-
 * but-token-gated model `GET /api/devices/link/:token` already uses. Polled every
 * couple of seconds by the waiting new device (docs/07-auth-architecture.md) until
 * it stops returning `pending`; on `ok` this is the request that actually sets the
 * session cookies — see completePendingDeviceLogin's own docstring for why that has
 * to happen here, not on the approving device's response.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return handleRoute(async () => {
    await enforceRateLimitByIp(RATE_LIMIT_RULES.pendingLoginPoll, req);
    const { id } = await params;
    const outcome = await completePendingDeviceLogin(id);

    if (outcome.status !== 'ok') {
      const payload: PendingLoginPollResponse = { status: outcome.status };
      return jsonOk(payload);
    }

    const payload: PendingLoginPollResponse = {
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
