import type { NextRequest } from 'next/server';
import { RATE_LIMIT_RULES } from '@comm/security';
import { handleRoute, jsonOk } from '@/server/common/errors';
import { requireAuth, requireCsrf } from '@/server/common/auth';
import { enforceRateLimit } from '@/server/common/rate-limit';
import { revokeDevice } from '@/server/modules/devices/service';

// Ownership is re-checked inside revokeDevice — the :id in the URL is never trusted
// on its own (docs/35-authorization.md).
export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return handleRoute(async () => {
    const ctx = await requireAuth(req);
    requireCsrf(req);
    await enforceRateLimit(RATE_LIMIT_RULES.deviceRevoke, ctx.userId);
    const { id } = await params;
    await revokeDevice(ctx.userId, id, 'user');
    return jsonOk({ revoked: true });
  });
}
