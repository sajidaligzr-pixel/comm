import type { NextRequest } from 'next/server';
import { RATE_LIMIT_RULES } from '@comm/security';
import { CursorQuery, SendMessageRequest } from '@comm/types';
import { handleRoute, jsonOk } from '@/server/common/errors';
import { requireAuth, requireCsrf } from '@/server/common/auth';
import { parseBody, parseQuery } from '@/server/common/validate';
import { enforceRateLimit } from '@/server/common/rate-limit';
import { listMessages, sendMessage } from '@/server/modules/messages/service';
import { publishNewMessage } from '@/server/realtime/bus';

// Cursor-paginated ciphertext history, used for initial sync/backfill — live
// delivery is WS (docs/03-api-design.md).
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return handleRoute(async () => {
    const ctx = await requireAuth(req);
    const { id: conversationId } = await params;
    const { cursor, limit } = parseQuery(req, CursorQuery);
    const page = await listMessages(ctx.userId, conversationId, cursor, limit);
    return jsonOk(page);
  });
}

// The shipped web client actually calls this unconditionally for every send (found
// while regression-testing message ticks) rather than trying WS `message.send`
// first — the same "don't build a retry/outbox on top of a fire-and-forget socket
// send" reasoning as the group key-share fix (lib/realtime-client.ts's
// sendRealtimeEvent docstring). The WS `message.send` case
// (server/realtime/message-handlers.ts) is still fully implemented and used by any
// client that does choose to send that way — this route isn't the only path in,
// just the one this codebase's own client relies on for guaranteed delivery
// regardless of socket state.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return handleRoute(async () => {
    const ctx = await requireAuth(req);
    requireCsrf(req);
    await enforceRateLimit(RATE_LIMIT_RULES.messageSend, ctx.userId);
    const { id: conversationId } = await params;
    const body = await parseBody(req, SendMessageRequest);
    // A second, tighter budget specifically for heavy inline-ciphertext content —
    // see RATE_LIMIT_RULES.mediaMessageSend's docstring (packages/security). `media`
    // (file attachments) isn't included here: its actual bytes go through the
    // separately-throttled upload-url route, not this one.
    if (body.contentTypeHint === 'image' || body.contentTypeHint === 'voice') {
      await enforceRateLimit(RATE_LIMIT_RULES.mediaMessageSend, ctx.userId);
    }
    // One MessageDto per target device (docs/13-roadmap.md's group chat pass — a
    // direct conversation always yields exactly one) — each gets its own WS `new`
    // event; the REST response echoes the first as a representative confirmation
    // (the client's own send path never actually reads this response's body).
    const messages = await sendMessage(ctx, conversationId, body);
    for (const message of messages) {
      await publishNewMessage(message);
    }
    return jsonOk(messages[0], { status: 201 });
  });
}
