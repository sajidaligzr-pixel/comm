import type { NextRequest } from 'next/server';
import type { OneTimePreKeyCountResponse } from '@comm/types';
import { handleRoute, jsonOk } from '@/server/common/errors';
import { requireAuth } from '@/server/common/auth';
import { countUnclaimedOneTimePreKeys } from '@/server/modules/keys/service';

export async function GET(req: NextRequest) {
  return handleRoute(async () => {
    const ctx = await requireAuth(req);
    const remaining = await countUnclaimedOneTimePreKeys(ctx.deviceId);
    return jsonOk<OneTimePreKeyCountResponse>({ remaining });
  });
}
