import type { NextRequest } from 'next/server';
import { MarkReadRequest } from '@comm/types';
import { handleRoute, jsonOk } from '@/server/common/errors';
import { requireAuth, requireCsrf } from '@/server/common/auth';
import { parseBody } from '@/server/common/validate';
import { markConversationRead } from '@/server/modules/messages/service';
import { getAllOtherMembersActiveDeviceIds } from '@/server/modules/conversations/service';
import { publishRead } from '@/server/realtime/bus';

// REST fallback alongside WS `message.read` (docs/04-websocket-realtime.md) — the
// same underlying service call either way, so behavior can never drift between the
// two paths.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return handleRoute(async () => {
    const ctx = await requireAuth(req);
    requireCsrf(req);
    const { id: conversationId } = await params;
    const body = await parseBody(req, MarkReadRequest);

    const recorded = await markConversationRead(ctx.userId, conversationId, body.upToMessageId);
    if (recorded) {
      const others = await getAllOtherMembersActiveDeviceIds(conversationId, ctx.userId);
      const readAt = new Date().toISOString();
      for (const { deviceId } of others) {
        await publishRead(deviceId, conversationId, body.upToMessageId, readAt);
      }
    }

    return jsonOk({ recorded });
  });
}
