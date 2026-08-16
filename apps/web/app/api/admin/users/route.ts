import type { NextRequest } from 'next/server';
import { RATE_LIMIT_RULES } from '@comm/security';
import { ProvisionUserRequest } from '@comm/types';
import { handleRoute, jsonOk } from '@/server/common/errors';
import { requireAuth, requireAdmin, requireCsrf } from '@/server/common/auth';
import { parseBody } from '@/server/common/validate';
import { enforceRateLimit } from '@/server/common/rate-limit';
import { provisionUser, listProvisionedUsers } from '@/server/modules/admin/service';

// Every /admin/* route re-derives the admin role from the database via requireAdmin —
// never from a client-supplied role claim (docs/35-authorization.md).
export async function POST(req: NextRequest) {
  return handleRoute(async () => {
    const ctx = await requireAuth(req);
    await requireAdmin(ctx);
    requireCsrf(req);
    await enforceRateLimit(RATE_LIMIT_RULES.adminProvision, ctx.userId);

    const body = await parseBody(req, ProvisionUserRequest);
    const result = await provisionUser(ctx.userId, body);
    return jsonOk(result, { status: 201 });
  });
}

export async function GET(req: NextRequest) {
  return handleRoute(async () => {
    const ctx = await requireAuth(req);
    await requireAdmin(ctx);
    const users = await listProvisionedUsers();
    return jsonOk(users);
  });
}
