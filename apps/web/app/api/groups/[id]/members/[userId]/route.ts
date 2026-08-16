import type { NextRequest } from 'next/server';
import { RATE_LIMIT_RULES } from '@comm/security';
import { handleRoute, jsonOk } from '@/server/common/errors';
import { requireAuth, requireCsrf } from '@/server/common/auth';
import { enforceRateLimit } from '@/server/common/rate-limit';
import { removeGroupMember, getGroupMemberActiveDeviceIds } from '@/server/modules/groups/service';
import { publishGroupMembersChanged } from '@/server/realtime/bus';

// Admin-only (enforced inside removeGroupMember). Bumps the group's Megolm epoch —
// see removeGroupMember's docstring and docs/05-crypto-architecture.md#group-encryption
// for why: the remaining members' clients react to the group.members-changed event
// this publishes by rotating to a fresh outbound session, excluding the removed
// member from all future key distribution.
export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string; userId: string }> }) {
  return handleRoute(async () => {
    const ctx = await requireAuth(req);
    requireCsrf(req);
    await enforceRateLimit(RATE_LIMIT_RULES.groupMemberChange, ctx.userId);
    const { id: groupId, userId: targetUserId } = await params;
    const group = await removeGroupMember(groupId, ctx.userId, targetUserId);

    const deviceIds = await getGroupMemberActiveDeviceIds(groupId);
    for (const deviceId of deviceIds) {
      await publishGroupMembersChanged(deviceId, groupId, group.conversationId);
    }

    return jsonOk(group);
  });
}
