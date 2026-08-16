import { createHmac } from 'node:crypto';
import type { NextRequest } from 'next/server';
import { type IceServersResponse } from '@comm/types';
import { handleRoute, jsonOk } from '@/server/common/errors';
import { requireAuth, requireCsrf } from '@/server/common/auth';
import { enforceRateLimit } from '@/server/common/rate-limit';
import { RATE_LIMIT_RULES } from '@comm/security';

/**
 * Mints short-lived coturn credentials via the `use-auth-secret` mechanism
 * (docs/08-threat-model.md#call-security, docs/11-deployment-architecture.md) —
 * never a static secret handed to the client. `TURN_SHARED_SECRET`/`TURN_URLS`
 * (.env.example) are unset until a coturn instance is actually deployed; until then
 * this returns an empty `iceServers` list rather than pointing at a third-party STUN
 * provider, since this project's architecture deliberately keeps every relay
 * self-hosted (docs/00-overview.md) — same self-hosted-only stance as the rest of the
 * deployment. An empty list still lets same-network/localhost calls connect via host
 * candidates; it just can't traverse a real-world NAT until coturn is live.
 */
export async function POST(req: NextRequest) {
  return handleRoute(async () => {
    const ctx = await requireAuth(req);
    requireCsrf(req);
    await enforceRateLimit(RATE_LIMIT_RULES.callTurnCredentials, ctx.userId);

    const secret = process.env.TURN_SHARED_SECRET;
    const urls = process.env.TURN_URLS;
    if (!secret || secret === 'CHANGE_ME' || !urls) {
      const response: IceServersResponse = { iceServers: [] };
      return jsonOk(response);
    }

    // Credential lifetime: 10 minutes — long enough to cover call setup plus a
    // realistic call duration's worth of ICE restarts, short enough that a leaked
    // credential is useless shortly after.
    const ttlSeconds = 600;
    const username = `${Math.floor(Date.now() / 1000) + ttlSeconds}:${ctx.userId}`;
    const credential = createHmac('sha1', secret).update(username).digest('base64');

    const response: IceServersResponse = {
      iceServers: urls
        .split(',')
        .map((u) => u.trim())
        .filter(Boolean)
        .map((url) => ({ urls: url, username, credential })),
    };
    return jsonOk(response);
  });
}
