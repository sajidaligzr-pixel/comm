import type { NextRequest } from 'next/server';
import { RATE_LIMIT_RULES } from '@comm/security';
import { SetGroupMemberRoleRequest } from '@comm/types';
import { handleRoute, jsonOk } from '@/server/common/errors';
import { requireAuth, requireCsrf } from '@/server/common/auth';
import { parseBody } from '@/server/common/validate';
import { enforceRateLimit } from '@/server/common/rate-limit';
import { removeGroupMember, setGroupMemberRole, getGroupMemberActiveDeviceIds } from '@/server/modules/groups/service';
import { publishGroupMembersChanged } from '@/server/realtime/bus';

// Promote/demote (admin-only, enforced inside setGroupMemberRole) — no
// group.members-changed nudge needed, unlike DELETE below: a role change has no
// crypto/epoch implications (see that function's own docstring), so there's
// nothing for another client to react to beyond re-fetching the group next time
// its info screen is open.
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string; userId: string }> }) {
  return handleRoute(async () => {
    const ctx = await requireAuth(req);
    requireCsrf(req);
    await enforceRateLimit(RATE_LIMIT_RULES.groupMemberChange, ctx.userId);
    const { id: groupId, userId: targetUserId } = await params;
    const body = await parseBody(req, SetGroupMemberRoleRequest);
    const group = await setGroupMemberRole(groupId, ctx.userId, targetUserId, body.role);
    return jsonOk(group);
  });
}

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
