import type { NextRequest } from 'next/server';
import { RATE_LIMIT_RULES } from '@comm/security';
import { GroupAvatarConfirmRequest } from '@comm/types';
import { handleRoute, jsonOk } from '@/server/common/errors';
import { requireAuth, requireCsrf } from '@/server/common/auth';
import { parseBody } from '@/server/common/validate';
import { enforceRateLimit } from '@/server/common/rate-limit';
import { createGroupAvatarUploadUrl, confirmGroupAvatar, removeGroupAvatar } from '@/server/modules/groups/service';

// Mint an upload target (admin-only, enforced inside the service function) — the
// client PUTs the image bytes directly to `target`, then calls PATCH below to
// actually attach it. See groups/service.ts's own "Group avatar" section docstring
// for why this bypasses the message-attachment upload pipeline entirely.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return handleRoute(async () => {
    const ctx = await requireAuth(req);
    requireCsrf(req);
    await enforceRateLimit(RATE_LIMIT_RULES.mediaUploadUrl, ctx.userId);
    const { id: groupId } = await params;
    const result = await createGroupAvatarUploadUrl(groupId, ctx.userId);
    return jsonOk(result);
  });
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return handleRoute(async () => {
    const ctx = await requireAuth(req);
    requireCsrf(req);
    await enforceRateLimit(RATE_LIMIT_RULES.groupMemberChange, ctx.userId);
    const { id: groupId } = await params;
    const body = await parseBody(req, GroupAvatarConfirmRequest);
    const group = await confirmGroupAvatar(groupId, ctx.userId, body.objectKey);
    return jsonOk(group);
  });
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return handleRoute(async () => {
    const ctx = await requireAuth(req);
    requireCsrf(req);
    await enforceRateLimit(RATE_LIMIT_RULES.groupMemberChange, ctx.userId);
    const { id: groupId } = await params;
    const group = await removeGroupAvatar(groupId, ctx.userId);
    return jsonOk(group);
  });
}
