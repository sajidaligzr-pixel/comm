import type { NextRequest } from 'next/server';
import { handleRoute, jsonOk } from '@/server/common/errors';
import { requireAuth } from '@/server/common/auth';
import { listConversations } from '@/server/modules/conversations/service';

export async function GET(req: NextRequest) {
  return handleRoute(async () => {
    const ctx = await requireAuth(req);
    const conversations = await listConversations(ctx.userId);
    return jsonOk(conversations);
  });
}
