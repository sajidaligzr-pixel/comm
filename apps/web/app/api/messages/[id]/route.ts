import type { NextRequest } from 'next/server';
import { handleRoute, jsonOk } from '@/server/common/errors';
import { requireAuth, requireCsrf } from '@/server/common/auth';
import { deleteMessage } from '@/server/modules/messages/service';
import { getAllOtherMembersActiveDeviceIds } from '@/server/modules/conversations/service';
import { publishDeleted } from '@/server/realtime/bus';

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return handleRoute(async () => {
    const ctx = await requireAuth(req);
    requireCsrf(req);
    const { id } = await params;
    const { conversationId } = await deleteMessage(ctx.userId, id);

    // Push the deletion live to every other member's device(s) — direct and group
    // alike — so their local decrypted cache is scrubbed too, not just the server's
    // row — without this, a "delete for everyone" would only be true on the server;
    // a recipient's already-decrypted local copy (lib/crypto/message-cache.ts) would
    // silently survive forever, since it's never re-read from server ciphertext once
    // cached.
    const others = await getAllOtherMembersActiveDeviceIds(conversationId, ctx.userId);
    for (const { deviceId } of others) {
      await publishDeleted(deviceId, conversationId, id, 'manual');
    }

    return jsonOk({ deleted: true });
  });
}
