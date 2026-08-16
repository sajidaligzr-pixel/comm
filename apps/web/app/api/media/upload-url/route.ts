import type { NextRequest } from 'next/server';
import { RATE_LIMIT_RULES } from '@comm/security';
import { CreateUploadUrlRequest } from '@comm/types';
import { handleRoute, jsonOk } from '@/server/common/errors';
import { requireAuth, requireCsrf } from '@/server/common/auth';
import { parseBody } from '@/server/common/validate';
import { enforceRateLimit } from '@/server/common/rate-limit';
import { createUploadUrl } from '@/server/modules/media/service';

/**
 * Mints a random object key + an upload target (docs/13-roadmap.md's media pass).
 * Declares only an encrypted byte count — never a filename or mime type, both of
 * which travel end-to-end inside the message envelope instead
 * (apps/web/lib/crypto/attachment-crypto.ts).
 */
export async function POST(req: NextRequest) {
  return handleRoute(async () => {
    const ctx = await requireAuth(req);
    requireCsrf(req);
    await enforceRateLimit(RATE_LIMIT_RULES.mediaUploadUrl, ctx.userId);
    const body = await parseBody(req, CreateUploadUrlRequest);
    const result = await createUploadUrl(ctx, body.encryptedSizeBytes);
    return jsonOk(result);
  });
}
