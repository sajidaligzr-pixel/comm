import { prisma } from '@comm/database';
import type { CallRejectReason } from '@comm/types';
import { clearPendingCall } from './pending';
import { recordCallDeclined } from './history';
import { getAllOtherMembersActiveDeviceIds } from '../conversations/service';
import { publishCallRejected, publishCallRinging } from '../../realtime/bus';

/**
 * Shared between the WS `call.reject` handler (message-handlers.ts) and
 * `POST /api/calls/decline` — the one call-signaling action that has to work with NO
 * socket at all: Android's "Decline" notification action button
 * (apps/mobile's local_notifications.dart) fires from a background isolate that
 * never opens the app at all, so there is no live WS connection to send a `call.
 * reject` frame over. Same "REST fallback where a WS send genuinely can't reach"
 * reasoning already established for delivery acks (push_notifications.dart's
 * `_ackDelivered`, built off the same background-isolate `ApiClient.initialize()`
 * pattern). Kept in exactly one place so the two paths can never drift, the same
 * convention `markConversationRead`/`acknowledgeDelivered` already follow for their
 * own REST/WS pairs.
 *
 * `deviceId` is always the CALLEE's own device — the one declining — same
 * "pending-call entries are keyed by the callee" reasoning documented on
 * `clearPendingCall` itself.
 */
export async function declineCall(
  userId: string,
  deviceId: string,
  conversationId: string,
  callId: string,
  reason: CallRejectReason,
): Promise<void> {
  await clearPendingCall(deviceId);
  await recordCallDeclined(callId);

  // Told to the caller immediately, and to every one of THIS user's other active
  // devices too — see message-handlers.ts's `call.reject` case for the full
  // reasoning (a decline is decisive, and stale device rows from old reinstalls
  // should never be able to make the caller wait).
  const callerTargets = await getAllOtherMembersActiveDeviceIds(conversationId, userId);
  for (const target of callerTargets) {
    await publishCallRejected(target.deviceId, conversationId, callId, reason);
  }

  const myOtherDevices = await prisma.device.findMany({
    where: { userId, status: 'active', id: { not: deviceId } },
    select: { id: true },
  });
  for (const device of myOtherDevices) {
    await clearPendingCall(device.id);
    await publishCallRejected(device.id, conversationId, callId, reason);
  }
}

/**
 * Shared between the WS `call.ringing` handler (message-handlers.ts) and
 * `POST /api/calls/ringing` — same "the one action that has to work with no
 * live socket" reasoning as `declineCall` above, for the exact case
 * `CallRingingRequest`'s own docstring (packages/types/src/calls.ts) flags:
 * an incoming-call push that reaches a fully-terminated Android app is
 * handled entirely inside a background isolate (push_notifications.dart's
 * `firebaseMessagingBackgroundHandler` → `showIncomingCall`, never touching
 * `CallController`/its live WS at all), so nothing ever told the caller the
 * callee's phone was actually ringing — it sat on "Calling…" for the whole
 * timeout even though the call visibly rang. `userId`/`deviceId` are always
 * the CALLEE's — the one whose phone is ringing — same convention as
 * `declineCall`'s.
 */
export async function ackCallRinging(userId: string, conversationId: string, callId: string): Promise<void> {
  const targets = await getAllOtherMembersActiveDeviceIds(conversationId, userId);
  for (const target of targets) {
    await publishCallRinging(target.deviceId, conversationId, callId);
  }
}
