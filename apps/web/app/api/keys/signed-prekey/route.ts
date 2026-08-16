import type { NextRequest } from 'next/server';
import { RATE_LIMIT_RULES } from '@comm/security';
import { UploadSignedPreKeyRequest } from '@comm/types';
import { handleRoute, jsonOk } from '@/server/common/errors';
import { requireAuth, requireCsrf } from '@/server/common/auth';
import { parseBody } from '@/server/common/validate';
import { enforceRateLimit } from '@/server/common/rate-limit';
import { uploadSignedPreKey } from '@/server/modules/keys/service';

// Always rotates the CALLING device's own key — deviceId comes from the
// authenticated session (docs/35-authorization.md), never a request body field.
export async function POST(req: NextRequest) {
  return handleRoute(async () => {
    const ctx = await requireAuth(req);
    requireCsrf(req);
    await enforceRateLimit(RATE_LIMIT_RULES.keyUpload, ctx.userId);
    const body = await parseBody(req, UploadSignedPreKeyRequest);
    await uploadSignedPreKey(ctx.deviceId, body);
    return jsonOk({ uploaded: true });
  });
}
