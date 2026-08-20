import type { NextRequest } from 'next/server';
import { DeleteAccountRequest } from '@comm/types';
import { handleRoute, jsonOk } from '@/server/common/errors';
import { requireAuth, requireCsrf } from '@/server/common/auth';
import { parseBody } from '@/server/common/validate';
import { clearAuthCookies } from '@/server/common/cookies';
import { deleteOwnAccount } from '@/server/modules/auth/service';

// The in-app account-deletion path Apple's App Store review requires (5.1.1(v)).
// Mirrors logout/route.ts's cookie-clearing + change-password/route.ts's re-auth
// shape combined: this is both a sign-out (nothing left to stay signed into) and a
// password-gated destructive action.
export async function POST(req: NextRequest) {
  return handleRoute(async () => {
    const ctx = await requireAuth(req);
    requireCsrf(req);

    const body = await parseBody(req, DeleteAccountRequest);
    await deleteOwnAccount(ctx.userId, body.password);

    const res = jsonOk({ deleted: true });
    clearAuthCookies(res);
    return res;
  });
}
