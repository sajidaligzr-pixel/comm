import type { NextRequest } from 'next/server';
import { RATE_LIMIT_RULES } from '@comm/security';
import { SendGroupKeyShareRequest } from '@comm/types';
import { AppError, handleRoute, jsonOk } from '@/server/common/errors';
import { requireAuth, requireCsrf } from '@/server/common/auth';
import { parseBody } from '@/server/common/validate';
import { enforceRateLimit } from '@/server/common/rate-limit';
import { createGroupKeyShare, listAndConsumePendingKeyShares } from '@/server/modules/groups/key-share-service';
import { publishGroupKeyShare } from '@/server/realtime/bus';

// REST catch-up for group session key material (docs/13-roadmap.md's design note on
// GroupKeyShare) — fetched on group-conversation open and on WS reconnect, same
// "REST fallback for what a live push might have missed" shape
// GET /conversations/:id/messages already provides for regular messages.
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return handleRoute(async () => {
    const ctx = await requireAuth(req);
    const { id: groupId } = await params;
    const shares = await listAndConsumePendingKeyShares(groupId, ctx.userId, ctx.deviceId);
    return jsonOk(shares);
  });
}

/**
 * REST is the PRIMARY path for sending a key-share, not just a fallback — unlike
 * `message.send` (where WS is primary and REST only covers an offline queue), a
 * key-share has no equivalent "the user is looking at a spinner until this lands"
 * urgency, but it DOES need a durability guarantee the WS-only `group.key-share`
 * inbound event alone can't provide: `sendRealtimeEvent` (lib/realtime-client.ts)
 * silently drops a send if the socket isn't open yet — a real, live-tested gap
 * (e.g. sending a group's very first message immediately after creating it,
 * before the just-mounted thread's WS connection has finished establishing). This
 * route guarantees the durable `GroupKeyShare` row gets created regardless of
 * socket timing; the WS `group.key-share` case in message-handlers.ts remains for
 * when a socket send happens to already be open (a harmless, redundant fast path —
 * this route and that WS case share the exact same service function).
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return handleRoute(async () => {
    const ctx = await requireAuth(req);
    requireCsrf(req);
    await enforceRateLimit(RATE_LIMIT_RULES.groupKeyShare, ctx.userId);
    const { id: groupId } = await params;
    const body = await parseBody(req, SendGroupKeyShareRequest);
    if (body.groupId !== groupId) {
      throw new AppError('VALIDATION_FAILED', 'Group id mismatch.');
    }
    const { dto, targetDeviceId } = await createGroupKeyShare(ctx.userId, ctx.deviceId, body);
    await publishGroupKeyShare(targetDeviceId, dto.groupId, dto.id);
    return jsonOk(dto, { status: 201 });
  });
}
