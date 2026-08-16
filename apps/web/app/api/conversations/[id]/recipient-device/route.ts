import type { NextRequest } from 'next/server';
import { handleRoute, jsonOk } from '@/server/common/errors';
import { requireAuth } from '@/server/common/auth';
import { getPrimaryRecipientDevice } from '@/server/modules/conversations/service';

// Which device the client should encrypt to for its next send — see the Phase 3
// scope note in server/modules/messages/service.ts.
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return handleRoute(async () => {
    const ctx = await requireAuth(req);
    const { id: conversationId } = await params;
    const target = await getPrimaryRecipientDevice(conversationId, ctx.userId);
    return jsonOk(target);
  });
}
