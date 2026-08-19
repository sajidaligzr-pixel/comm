import type { NextRequest } from 'next/server';
import { handleRoute, jsonOk } from '@/server/common/errors';
import { requireAuth, requireCsrf } from '@/server/common/auth';
import { unblockUser } from '@/server/modules/blocking/service';

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ userId: string }> }) {
  return handleRoute(async () => {
    const ctx = await requireAuth(req);
    requireCsrf(req);
    const { userId } = await params;
    await unblockUser(ctx.userId, userId);
    return jsonOk({ blocked: false });
  });
}
