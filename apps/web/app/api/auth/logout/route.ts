import type { NextRequest } from 'next/server';
import { handleRoute, jsonOk } from '@/server/common/errors';
import { requireAuth, requireCsrf } from '@/server/common/auth';
import { clearAuthCookies } from '@/server/common/cookies';
import { revokeSession } from '@/server/modules/auth/session';

export async function POST(req: NextRequest) {
  return handleRoute(async () => {
    const ctx = await requireAuth(req);
    requireCsrf(req);

    await revokeSession(ctx.sessionId);

    const res = jsonOk({ loggedOut: true });
    clearAuthCookies(res);
    return res;
  });
}
