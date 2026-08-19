import type { NextRequest } from 'next/server';
import { BlockUserRequest } from '@comm/types';
import { handleRoute, jsonOk } from '@/server/common/errors';
import { requireAuth, requireCsrf } from '@/server/common/auth';
import { parseBody } from '@/server/common/validate';
import { blockUser, listBlockedUsers } from '@/server/modules/blocking/service';

// Read-only, so no requireCsrf — same convention every other GET route follows.
export async function GET(req: NextRequest) {
  return handleRoute(async () => {
    const ctx = await requireAuth(req);
    const blocked = await listBlockedUsers(ctx.userId);
    return jsonOk(blocked);
  });
}

export async function POST(req: NextRequest) {
  return handleRoute(async () => {
    const ctx = await requireAuth(req);
    requireCsrf(req);
    const body = await parseBody(req, BlockUserRequest);
    await blockUser(ctx.userId, body.username);
    return jsonOk({ blocked: true });
  });
}
