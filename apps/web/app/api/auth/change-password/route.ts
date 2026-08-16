import type { NextRequest } from 'next/server';
import { ChangePasswordRequest } from '@comm/types';
import { handleRoute, jsonOk } from '@/server/common/errors';
import { requireAuth, requireCsrf } from '@/server/common/auth';
import { parseBody } from '@/server/common/validate';
import { changePassword } from '@/server/modules/auth/service';

// docs/07-auth-architecture.md's "must change password" flow — reachable both from
// the forced first-login redirect and as a normal, voluntary password change later.
export async function POST(req: NextRequest) {
  return handleRoute(async () => {
    const ctx = await requireAuth(req);
    requireCsrf(req);

    const body = await parseBody(req, ChangePasswordRequest);
    await changePassword(ctx.userId, ctx.sessionId, body.currentPassword, body.newPassword);

    return jsonOk({ changed: true });
  });
}
