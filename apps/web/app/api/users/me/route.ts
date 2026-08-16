import type { NextRequest } from 'next/server';
import { UpdateProfileRequest } from '@comm/types';
import { handleRoute, jsonOk } from '@/server/common/errors';
import { requireAuth, requireCsrf } from '@/server/common/auth';
import { parseBody } from '@/server/common/validate';
import { getOwnProfile, updateOwnProfile } from '@/server/modules/users/service';

export async function GET(req: NextRequest) {
  return handleRoute(async () => {
    const ctx = await requireAuth(req);
    const profile = await getOwnProfile(ctx.userId);
    return jsonOk(profile);
  });
}

export async function PATCH(req: NextRequest) {
  return handleRoute(async () => {
    const ctx = await requireAuth(req);
    requireCsrf(req);
    const body = await parseBody(req, UpdateProfileRequest);
    const profile = await updateOwnProfile(ctx.userId, body);
    return jsonOk(profile);
  });
}
