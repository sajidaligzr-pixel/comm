import type { NextRequest } from 'next/server';
import { SuspendUserRequest } from '@comm/types';
import { handleRoute, jsonOk } from '@/server/common/errors';
import { requireAuth, requireAdmin, requireCsrf } from '@/server/common/auth';
import { parseBody } from '@/server/common/validate';
import { suspendUser } from '@/server/modules/admin/service';

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return handleRoute(async () => {
    const ctx = await requireAuth(req);
    await requireAdmin(ctx);
    requireCsrf(req);

    const body = await parseBody(req, SuspendUserRequest);
    const { id } = await params;
    await suspendUser(ctx.userId, id, body.reason);
    return jsonOk({ suspended: true });
  });
}
