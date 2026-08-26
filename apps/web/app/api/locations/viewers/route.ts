import type { NextRequest } from 'next/server';
import { RATE_LIMIT_RULES } from '@comm/security';
import { GrantLocationViewerRequest } from '@comm/types';
import { handleRoute, jsonOk } from '@/server/common/errors';
import { requireAuth, requireCsrf, requireAdmin } from '@/server/common/auth';
import { enforceRateLimit } from '@/server/common/rate-limit';
import { parseBody } from '@/server/common/validate';
import { listLocationViewers, grantLocationViewer } from '@/server/modules/locations/service';

// Admin-only — granting/revoking the viewer privilege is an admin action, distinct
// from viewing the map itself (requireLocationAccess, GET /api/locations).
export async function GET(req: NextRequest) {
  return handleRoute(async () => {
    const ctx = await requireAuth(req);
    await requireAdmin(ctx);
    const viewers = await listLocationViewers();
    return jsonOk(viewers);
  });
}

export async function POST(req: NextRequest) {
  return handleRoute(async () => {
    const ctx = await requireAuth(req);
    requireCsrf(req);
    await requireAdmin(ctx);
    await enforceRateLimit(RATE_LIMIT_RULES.locationViewerGrant, ctx.userId);
    const body = await parseBody(req, GrantLocationViewerRequest);
    const viewer = await grantLocationViewer(ctx.userId, body.username);
    return jsonOk(viewer);
  });
}
