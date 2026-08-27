import type { NextRequest } from 'next/server';
import { handleRoute, jsonOk } from '@/server/common/errors';
import { requireAuth } from '@/server/common/auth';
import { listPendingDeviceLogins } from '@/server/modules/devices/service';

// The devices screen's durable "did I miss the live nudge" catch-up
// (docs/07-auth-architecture.md's device-approval section) — the same
// REST-is-durable/WS-is-just-the-fast-path relationship group.key-share already has.
export async function GET(req: NextRequest) {
  return handleRoute(async () => {
    const ctx = await requireAuth(req);
    const pending = await listPendingDeviceLogins(ctx.userId);
    return jsonOk(pending);
  });
}
