import type { NextRequest } from 'next/server';
import { handleRoute, jsonOk } from '@/server/common/errors';
import { requireAuth, requireCsrf } from '@/server/common/auth';
import { starMessage, unstarMessage } from '@/server/modules/messages/service';

/**
 * Starring a message — see `StarredMessage`'s doc comment in schema.prisma for
 * why this needs no realtime fan-out the way delete/react do: it's a private,
 * per-user view preference (mirrors `archived`/`pinned` on conversations), never
 * something the other participant(s) see or are affected by.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return handleRoute(async () => {
    const ctx = await requireAuth(req);
    requireCsrf(req);
    const { id: messageId } = await params;
    await starMessage(ctx.userId, messageId);
    return jsonOk({ starred: true });
  });
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return handleRoute(async () => {
    const ctx = await requireAuth(req);
    requireCsrf(req);
    const { id: messageId } = await params;
    await unstarMessage(ctx.userId, messageId);
    return jsonOk({ starred: false });
  });
}
