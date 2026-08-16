import type { NextRequest } from 'next/server';
import { RATE_LIMIT_RULES } from '@comm/security';
import { UploadOneTimePreKeysRequest } from '@comm/types';
import { handleRoute, jsonOk } from '@/server/common/errors';
import { requireAuth, requireCsrf } from '@/server/common/auth';
import { parseBody } from '@/server/common/validate';
import { enforceRateLimit } from '@/server/common/rate-limit';
import { uploadOneTimePreKeys } from '@/server/modules/keys/service';

export async function POST(req: NextRequest) {
  return handleRoute(async () => {
    const ctx = await requireAuth(req);
    requireCsrf(req);
    await enforceRateLimit(RATE_LIMIT_RULES.keyUpload, ctx.userId);
    const body = await parseBody(req, UploadOneTimePreKeysRequest);
    await uploadOneTimePreKeys(ctx.deviceId, body.oneTimePreKeys);
    return jsonOk({ uploaded: body.oneTimePreKeys.length });
  });
}
