import type { NextRequest } from 'next/server';
import { CursorQuery } from '@comm/types';
import { handleRoute, jsonOk } from '@/server/common/errors';
import { requireAuth } from '@/server/common/auth';
import { parseQuery } from '@/server/common/validate';
import { listOwnSecurityEvents } from '@/server/modules/audit/service';

export async function GET(req: NextRequest) {
  return handleRoute(async () => {
    const ctx = await requireAuth(req);
    const { limit } = parseQuery(req, CursorQuery);
    const events = await listOwnSecurityEvents(ctx.userId, limit);
    return jsonOk(events);
  });
}
