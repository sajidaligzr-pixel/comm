import type { NextRequest } from 'next/server';
import { handleRoute, jsonOk } from '@/server/common/errors';
import { requireAuth } from '@/server/common/auth';
import { getGroupMemberDeviceTargets } from '@/server/modules/groups/service';

/** Resolves each OTHER current member's primary device id — what the client needs to
 * target a `group.key-share` at (docs/13-roadmap.md's group chat pass), the same way
 * `/conversations/:id/recipient-device` resolves the one recipient a 1:1 send needs. */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return handleRoute(async () => {
    const ctx = await requireAuth(req);
    const { id: groupId } = await params;
    const targets = await getGroupMemberDeviceTargets(groupId, ctx.userId);
    return jsonOk(targets);
  });
}
