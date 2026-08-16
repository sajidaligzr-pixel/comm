import type { NextRequest } from 'next/server';
import { RATE_LIMIT_RULES } from '@comm/security';
import { handleRoute, jsonOk } from '@/server/common/errors';
import { requireAuth } from '@/server/common/auth';
import { enforceRateLimit } from '@/server/common/rate-limit';
import { getPublicProfile } from '@/server/modules/users/service';

// Rate-limited per caller — username lookup is an enumeration target
// (docs/03-api-design.md's Discovery route class, docs/17-username-system.md).
export async function GET(req: NextRequest, { params }: { params: Promise<{ username: string }> }) {
  return handleRoute(async () => {
    const ctx = await requireAuth(req);
    await enforceRateLimit(RATE_LIMIT_RULES.usernameLookup, ctx.userId);
    const { username } = await params;
    const profile = await getPublicProfile(ctx.userId, username.toLowerCase());
    return jsonOk(profile);
  });
}
