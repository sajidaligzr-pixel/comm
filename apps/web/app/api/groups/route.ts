import type { NextRequest } from 'next/server';
import { RATE_LIMIT_RULES } from '@comm/security';
import { CreateGroupRequest } from '@comm/types';
import { handleRoute, jsonOk } from '@/server/common/errors';
import { requireAuth, requireCsrf } from '@/server/common/auth';
import { parseBody } from '@/server/common/validate';
import { enforceRateLimit } from '@/server/common/rate-limit';
import { createGroup } from '@/server/modules/groups/service';

export async function POST(req: NextRequest) {
  return handleRoute(async () => {
    const ctx = await requireAuth(req);
    requireCsrf(req);
    await enforceRateLimit(RATE_LIMIT_RULES.groupCreate, ctx.userId);
    const body = await parseBody(req, CreateGroupRequest);
    const group = await createGroup(ctx.userId, body.name, body.description, body.memberUsernames);
    return jsonOk(group, { status: 201 });
  });
}
