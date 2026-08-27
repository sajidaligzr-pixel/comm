import type { NextRequest } from 'next/server';
import { RATE_LIMIT_RULES } from '@comm/security';
import { UploadMessageHistoryEntryRequest } from '@comm/types';
import { handleRoute, jsonOk } from '@/server/common/errors';
import { requireAuth, requireCsrf } from '@/server/common/auth';
import { enforceRateLimit } from '@/server/common/rate-limit';
import { parseBody } from '@/server/common/validate';
import { writeMessageHistoryEntry } from '@/server/modules/history/service';

// Multi-device message history sync (docs/07-auth-architecture.md) — membership
// re-checked inside writeMessageHistoryEntry, the :id in the URL is never trusted
// on its own (docs/35-authorization.md).
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return handleRoute(async () => {
    const ctx = await requireAuth(req);
    requireCsrf(req);
    await enforceRateLimit(RATE_LIMIT_RULES.historyEntryWrite, ctx.userId);
    const body = await parseBody(req, UploadMessageHistoryEntryRequest);
    const { id } = await params;
    await writeMessageHistoryEntry(ctx.userId, id, Buffer.from(body.ciphertext, 'base64'));
    return jsonOk({ saved: true });
  });
}
