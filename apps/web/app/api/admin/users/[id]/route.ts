import type { NextRequest } from 'next/server';
import { handleRoute, jsonOk } from '@/server/common/errors';
import { requireAuth, requireAdmin, requireCsrf } from '@/server/common/auth';
import { adminDeleteUser } from '@/server/modules/admin/service';

// See adminDeleteUser's own docstring (admin/service.ts) for exactly what this
// does beyond the account itself — every direct conversation this user was part
// of is deleted outright, and their own messages inside any group they belonged
// to are tombstoned.
export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return handleRoute(async () => {
    const ctx = await requireAuth(req);
    await requireAdmin(ctx);
    requireCsrf(req);

    const { id } = await params;
    await adminDeleteUser(ctx.userId, id);
    return jsonOk({ deleted: true });
  });
}
