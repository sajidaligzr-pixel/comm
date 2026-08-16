import type { NextRequest } from 'next/server';
import { UpdateGroupRequest } from '@comm/types';
import { handleRoute, jsonOk } from '@/server/common/errors';
import { requireAuth, requireCsrf } from '@/server/common/auth';
import { parseBody } from '@/server/common/validate';
import { getGroup, updateGroup } from '@/server/modules/groups/service';

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return handleRoute(async () => {
    const ctx = await requireAuth(req);
    const { id: groupId } = await params;
    const group = await getGroup(groupId, ctx.userId);
    return jsonOk(group);
  });
}

// Admin-only (enforced inside updateGroup) — name/description/onlyAdminsCanMessage.
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return handleRoute(async () => {
    const ctx = await requireAuth(req);
    requireCsrf(req);
    const { id: groupId } = await params;
    const body = await parseBody(req, UpdateGroupRequest);
    const group = await updateGroup(groupId, ctx.userId, body);
    return jsonOk(group);
  });
}
