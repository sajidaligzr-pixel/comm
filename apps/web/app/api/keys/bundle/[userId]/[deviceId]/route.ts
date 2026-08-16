import type { NextRequest } from 'next/server';
import { RATE_LIMIT_RULES } from '@comm/security';
import { handleRoute, jsonOk } from '@/server/common/errors';
import { requireAuth } from '@/server/common/auth';
import { enforceRateLimit } from '@/server/common/rate-limit';
import { getKeyBundle } from '@/server/modules/keys/service';

export async function GET(req: NextRequest, { params }: { params: Promise<{ userId: string; deviceId: string }> }) {
  return handleRoute(async () => {
    const ctx = await requireAuth(req);
    await enforceRateLimit(RATE_LIMIT_RULES.keyBundleClaim, ctx.userId);
    const { userId, deviceId } = await params;
    const bundle = await getKeyBundle(userId, deviceId);
    return jsonOk(bundle);
  });
}
