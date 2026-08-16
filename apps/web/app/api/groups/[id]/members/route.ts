import type { NextRequest } from 'next/server';
import { RATE_LIMIT_RULES } from '@comm/security';
import { AddGroupMemberRequest } from '@comm/types';
import { handleRoute, jsonOk } from '@/server/common/errors';
import { requireAuth, requireCsrf } from '@/server/common/auth';
import { parseBody } from '@/server/common/validate';
import { enforceRateLimit } from '@/server/common/rate-limit';
import { addGroupMember, getGroupMemberActiveDeviceIds } from '@/server/modules/groups/service';
import { publishGroupMembersChanged } from '@/server/realtime/bus';

// Any current member may add another (matches docs/02-database-schema.md's
// group_members design intent) — removal (below) is admin-only.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return handleRoute(async () => {
    const ctx = await requireAuth(req);
    requireCsrf(req);
    await enforceRateLimit(RATE_LIMIT_RULES.groupMemberChange, ctx.userId);
    const { id: groupId } = await params;
    const body = await parseBody(req, AddGroupMemberRequest);
    const group = await addGroupMember(groupId, ctx.userId, body.username);

    // Nudge every current member's client (including the new member's) to react —
    // existing members share their live outbound session with the new member's
    // device; the new member's own client starts listening for it.
    const deviceIds = await getGroupMemberActiveDeviceIds(groupId);
    for (const deviceId of deviceIds) {
      await publishGroupMembersChanged(deviceId, groupId, group.conversationId);
    }

    return jsonOk(group);
  });
}
