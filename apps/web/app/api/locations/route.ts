import type { NextRequest } from 'next/server';
import { RATE_LIMIT_RULES } from '@comm/security';
import { LocationPing } from '@comm/types';
import { handleRoute, jsonOk } from '@/server/common/errors';
import { requireAuth, requireCsrf, requireLocationAccess } from '@/server/common/auth';
import { enforceRateLimit } from '@/server/common/rate-limit';
import { parseBody } from '@/server/common/validate';
import { upsertMyLocation, listLiveLocations } from '@/server/modules/locations/service';

// Read-only, so no requireCsrf — same convention every other GET route follows.
// Gated on requireLocationAccess (Admin OR a granted LocationViewer), not
// requireAdmin — see that function's own docstring.
export async function GET(req: NextRequest) {
  return handleRoute(async () => {
    const ctx = await requireAuth(req);
    await requireLocationAccess(ctx);
    const locations = await listLiveLocations();
    return jsonOk(locations);
  });
}

// Any signed-in device may report its OWN location — no requireLocationAccess here,
// sharing needs no special privilege, only viewing does (see service.ts's docstring).
export async function POST(req: NextRequest) {
  return handleRoute(async () => {
    const ctx = await requireAuth(req);
    requireCsrf(req);
    await enforceRateLimit(RATE_LIMIT_RULES.locationPing, ctx.deviceId);
    const ping = await parseBody(req, LocationPing);
    await upsertMyLocation(ctx.userId, ctx.deviceId, ping);
    return jsonOk({ received: true });
  });
}
