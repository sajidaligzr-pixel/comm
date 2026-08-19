import type { NextRequest } from 'next/server';
import { handleRoute, jsonOk } from '@/server/common/errors';
import { requireAuth } from '@/server/common/auth';
import { getMessageReceipts } from '@/server/modules/messages/service';

/**
 * "Seen by" — group messages only, see `getMessageReceipts`'s own docstring.
 * Read-only, so no requireCsrf — same convention every other GET route follows.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return handleRoute(async () => {
    const ctx = await requireAuth(req);
    const { id: messageId } = await params;
    const receipts = await getMessageReceipts(ctx.userId, messageId);
    return jsonOk(receipts);
  });
}
