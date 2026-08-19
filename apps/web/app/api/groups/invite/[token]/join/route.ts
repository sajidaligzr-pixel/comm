import type { NextRequest } from 'next/server';
import { RATE_LIMIT_RULES } from '@comm/security';
import { handleRoute, jsonOk } from '@/server/common/errors';
import { requireAuth, requireCsrf } from '@/server/common/auth';
import { enforceRateLimit } from '@/server/common/rate-limit';
import { joinGroupViaInviteLink, getGroupMemberActiveDeviceIds } from '@/server/modules/groups/service';
import { publishGroupMembersChanged } from '@/server/realtime/bus';

// Self-service join — the counterpart to POST /api/groups/:id/members (any current
// member adding someone else); same post-mutation device nudge as that route, so
// every existing member's client reacts to the new arrival (shares its live
// outbound session) the same way it would for an admin-added member.
export async function POST(req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  return handleRoute(async () => {
    const ctx = await requireAuth(req);
    requireCsrf(req);
    await enforceRateLimit(RATE_LIMIT_RULES.groupMemberChange, ctx.userId);
    const { token } = await params;
    const group = await joinGroupViaInviteLink(token, ctx.userId);

    const deviceIds = await getGroupMemberActiveDeviceIds(group.id);
    for (const deviceId of deviceIds) {
      await publishGroupMembersChanged(deviceId, group.id, group.conversationId);
    }

    return jsonOk(group);
  });
}
