import type { NextRequest } from 'next/server';
import { RATE_LIMIT_RULES } from '@comm/security';
import { handleRoute, jsonOk } from '@/server/common/errors';
import { requireAuth, requireCsrf } from '@/server/common/auth';
import { enforceRateLimit } from '@/server/common/rate-limit';
import { getOrCreateGroupInviteLink, regenerateGroupInviteLink, revokeGroupInviteLink } from '@/server/modules/groups/service';

// Get-or-create (admin-only, enforced inside the service function) — idempotent,
// see getOrCreateGroupInviteLink's own docstring for why opening this panel doesn't
// invalidate a link someone's already shared.
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return handleRoute(async () => {
    const ctx = await requireAuth(req);
    const { id: groupId } = await params;
    const link = await getOrCreateGroupInviteLink(groupId, ctx.userId);
    return jsonOk(link);
  });
}

// "Reset link" — revokes whatever's currently active and mints a fresh one.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return handleRoute(async () => {
    const ctx = await requireAuth(req);
    requireCsrf(req);
    await enforceRateLimit(RATE_LIMIT_RULES.groupMemberChange, ctx.userId);
    const { id: groupId } = await params;
    const link = await regenerateGroupInviteLink(groupId, ctx.userId);
    return jsonOk(link);
  });
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return handleRoute(async () => {
    const ctx = await requireAuth(req);
    requireCsrf(req);
    await enforceRateLimit(RATE_LIMIT_RULES.groupMemberChange, ctx.userId);
    const { id: groupId } = await params;
    await revokeGroupInviteLink(groupId, ctx.userId);
    return jsonOk({ revoked: true });
  });
}
