import type { NextRequest } from 'next/server';
import { handleRoute, jsonOk } from '@/server/common/errors';
import { requireAuth } from '@/server/common/auth';
import { listStarredMessages } from '@/server/modules/messages/service';

/**
 * A literal `starred` segment, not `/api/messages/:id` with `id="starred"` —
 * Next.js resolves a static path segment ahead of a sibling dynamic one at the
 * same depth, so this and `/api/messages/[id]` coexist safely (same pattern as
 * `/api/devices/link/[token]` living under the literal `link` folder).
 *
 * Read-only, so no requireCsrf — same convention every other GET route follows.
 * Returns ids/timestamps only, never plaintext (StarredMessageDto's own
 * docstring) — the client cross-references each entry against its own local
 * decrypted cache per conversation.
 */
export async function GET(req: NextRequest) {
  return handleRoute(async () => {
    const ctx = await requireAuth(req);
    const starred = await listStarredMessages(ctx.userId);
    return jsonOk(starred);
  });
}
