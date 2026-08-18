import type { NextRequest } from 'next/server';
import { UpdateConversationRequest } from '@comm/types';
import { handleRoute, jsonOk } from '@/server/common/errors';
import { requireAuth, requireCsrf } from '@/server/common/auth';
import { parseBody } from '@/server/common/validate';
import { getConversation, updateConversationSettings } from '@/server/modules/conversations/service';

// Single-conversation fetch, membership-gated in the service. Read-only, so no
// requireCsrf — same convention GET /api/conversations already follows.
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return handleRoute(async () => {
    const ctx = await requireAuth(req);
    const { id: conversationId } = await params;
    const conversation = await getConversation(ctx.userId, conversationId);
    return jsonOk(conversation);
  });
}

// Two mutable conversation settings today: the disappearing-message timer (shared)
// and the archived flag (per-caller) — see UpdateConversationRequest's docstring.
// Membership-gated inside the service, not here — same pattern as every other
// conversation-scoped route.
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return handleRoute(async () => {
    const ctx = await requireAuth(req);
    requireCsrf(req);
    const { id: conversationId } = await params;
    const body = await parseBody(req, UpdateConversationRequest);
    const conversation = await updateConversationSettings(ctx.userId, conversationId, body);
    return jsonOk(conversation);
  });
}
