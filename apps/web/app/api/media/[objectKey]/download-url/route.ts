import type { NextRequest } from 'next/server';
import { RATE_LIMIT_RULES } from '@comm/security';
import { handleRoute, jsonOk } from '@/server/common/errors';
import { requireAuth } from '@/server/common/auth';
import { enforceRateLimit } from '@/server/common/rate-limit';
import { createDownloadUrl } from '@/server/modules/media/service';

/** Membership-gated (docs/03-api-design.md#authorization) — issued only if the
 * caller is a member of the conversation the attachment's parent message belongs
 * to, re-derived from the DB every call. */
export async function GET(req: NextRequest, { params }: { params: Promise<{ objectKey: string }> }) {
  return handleRoute(async () => {
    const ctx = await requireAuth(req);
    await enforceRateLimit(RATE_LIMIT_RULES.mediaDownloadUrl, ctx.userId);
    const { objectKey } = await params;
    const url = await createDownloadUrl(ctx.userId, objectKey);
    return jsonOk({ url });
  });
}
