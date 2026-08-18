import type { NextRequest } from 'next/server';
import { handleRoute, jsonOk } from '@/server/common/errors';
import { requireAuth } from '@/server/common/auth';
import { getAllOtherMembersActiveDeviceIds } from '@/server/modules/conversations/service';

/**
 * Every OTHER member's active device — what a `direct`-conversation client needs to
 * encrypt a fresh outgoing message for real multi-device sync (see
 * server/modules/messages/service.ts's module docstring): one call to
 * `encryptForDevice` per entry here, PLUS the caller's own other active devices
 * (`GET /api/devices`, filtered to `!isCurrentDevice`) for self-fan-out. Was a
 * singular `GET .../recipient-device` returning at most one "primary" device (a
 * `lastActiveAt`-ordered guess) — replaced outright rather than kept alongside,
 * since the whole point of this change is that there is no longer a single correct
 * device to guess. `sendMessage` re-derives this same set server-side and never
 * trusts whatever the client actually sent to (docs/35-authorization.md), so this
 * route is purely a convenience for the client to know what to encrypt for, not a
 * capability grant.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return handleRoute(async () => {
    const ctx = await requireAuth(req);
    const { id: conversationId } = await params;
    const targets = await getAllOtherMembersActiveDeviceIds(conversationId, ctx.userId);
    return jsonOk(targets);
  });
}
