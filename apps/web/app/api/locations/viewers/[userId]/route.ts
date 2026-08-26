import type { NextRequest } from 'next/server';
import { handleRoute, jsonOk } from '@/server/common/errors';
import { requireAuth, requireCsrf, requireAdmin } from '@/server/common/auth';
import { revokeLocationViewer } from '@/server/modules/locations/service';

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ userId: string }> }) {
  return handleRoute(async () => {
    const ctx = await requireAuth(req);
    requireCsrf(req);
    await requireAdmin(ctx);
    const { userId } = await params;
    await revokeLocationViewer(userId);
    return jsonOk({ revoked: true });
  });
}
