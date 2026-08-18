import { getRedisClient } from '@comm/security';
import type { PendingCallResponse, CallSessionDescription } from '@comm/types';

/**
 * Durable counterpart to `publishCallRing` (server/realtime/bus.ts) — see
 * `PendingCallResponse`'s own docstring (packages/types/src/calls.ts) for why this
 * has to exist at all: a bare Redis pub/sub publish reaches nobody if the target
 * device's WS wasn't connected at that exact instant, which is exactly the case a
 * closed/backgrounded app needs a push notification to recover from. Stored in
 * Redis, not Postgres — same "ephemeral, never needs to survive a restart" reasoning
 * as devices/service.ts's device-link tokens, and for the same reason: this is only
 * ever useful for the few seconds a call is actually still ringing.
 *
 * TTL matches RING_TIMEOUT_MS (call-provider.tsx) / `_ringTimeout`
 * (call_controller.dart) exactly — once the caller's own client has given up
 * waiting for an answer, there is nothing left to catch up to, so this should
 * already be gone by then rather than dangling around promising a call that no
 * longer exists on the caller's end either.
 */
const RING_TIMEOUT_SECONDS = 45;

function key(targetDeviceId: string): string {
  return `call-pending:${targetDeviceId}`;
}

export async function setPendingCall(
  targetDeviceId: string,
  conversationId: string,
  callId: string,
  fromUserId: string,
  fromDisplayName: string,
  sdp: CallSessionDescription,
): Promise<void> {
  const payload: NonNullable<PendingCallResponse> = { conversationId, callId, fromUserId, fromDisplayName, sdp };
  await getRedisClient().set(key(targetDeviceId), JSON.stringify(payload), 'EX', RING_TIMEOUT_SECONDS);
}

/** Called on every resolution path (answer/reject/end, from either side) for a
 * given call — not just the happy path — so a client that reconnects a moment
 * after a call was already handled elsewhere never resurrects it as still-ringing.
 * Keyed by the ORIGINAL callee's device id, the only device this was ever stored
 * under; the caller-side handlers below pass that same id through, not their own. */
export async function clearPendingCall(targetDeviceId: string): Promise<void> {
  await getRedisClient().del(key(targetDeviceId));
}

/** `null` when there's nothing pending (the normal case — most reconnects have no
 * missed call waiting) or when the stored JSON is somehow malformed (fails closed
 * to "nothing pending" rather than surfacing a parse error for what is, at worst, a
 * missed-call notification). */
export async function getPendingCall(targetDeviceId: string): Promise<PendingCallResponse> {
  const raw = await getRedisClient().get(key(targetDeviceId));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as NonNullable<PendingCallResponse>;
  } catch {
    return null;
  }
}
