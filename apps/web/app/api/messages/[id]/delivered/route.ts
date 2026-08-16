import type { NextRequest } from 'next/server';
import { handleRoute, jsonOk } from '@/server/common/errors';
import { requireAuth, requireCsrf } from '@/server/common/auth';
import { acknowledgeDelivered, getMessageSenderDeviceId } from '@/server/modules/messages/service';
import { publishDelivered } from '@/server/realtime/bus';

/**
 * REST fallback alongside WS `message.ack` (docs/04-websocket-realtime.md) — the
 * same underlying service calls either way, so behavior can never drift between the
 * two paths (matches this route's sibling, `/api/conversations/:id/read`).
 *
 * A real bug found auditing this: `message.ack` (and `message.read`, until this same
 * pass) had *only* the WS path, which `lib/realtime-client.ts#sendRealtimeEvent`
 * documents as silently dropping if the socket isn't open yet at that exact moment —
 * a real, previously-found bug class (the group key-share pass's "fire-and-forget WS
 * send silently drops," reliably hit right after a group's first message, before its
 * just-mounted thread's socket had finished connecting). The `/read` route already
 * existed for exactly this reason but was never actually called by the client — dead
 * code. This route closes the equivalent gap for delivery acks, and both client call
 * sites now use their REST route as the durable primary path, not a fallback that's
 * never reached.
 *
 * `acknowledgeDelivered`'s own `where: { recipientDeviceId: ctx.deviceId, ... }`
 * scoping (never a client-claimed device id) is the same authorization the WS
 * handler already relies on — nothing extra needed here: a caller acking a message
 * their own device was never actually sent to just matches zero rows and does
 * nothing, not an error.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return handleRoute(async () => {
    const ctx = await requireAuth(req);
    requireCsrf(req);
    const { id: messageId } = await params;

    await acknowledgeDelivered(ctx.deviceId, messageId);
    const senderDeviceId = await getMessageSenderDeviceId(messageId);
    if (senderDeviceId) {
      await publishDelivered(senderDeviceId, messageId, new Date().toISOString());
    }

    return jsonOk({ ok: true });
  });
}
