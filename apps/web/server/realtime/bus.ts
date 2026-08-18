import { getRedisClient } from '@comm/security';
import {
  DEVICE_EVENTS_CHANNEL,
  MESSAGE_EVENTS_CHANNEL,
  CALL_EVENTS_CHANNEL,
  GROUP_EVENTS_CHANNEL,
  type DeviceEvent,
  type MessageEvent,
  type MessageDto,
  type MessageDeletionReason,
  type CallEvent,
  type CallSessionDescription,
  type CallIceCandidateInit,
  type CallRejectReason,
  type GroupEvent,
} from '@comm/types';

/**
 * Cross-process event bus for realtime push (docs/04-websocket-realtime.md's "Scaling
 * across processes" — Redis pub/sub so any `apps/web` process holding the relevant
 * socket can react, not just the process that handled the originating HTTP request).
 * Channel names and the event shapes themselves live in `@comm/types` (re-exported
 * here for every existing import site) since `apps/worker` also publishes onto
 * `MESSAGE_EVENTS_CHANNEL` directly — disappearing-message expiry (apps/worker/src/jobs/cleanup.ts)
 * isn't triggered by an HTTP request, so it can't go through this module's functions,
 * but it must still produce byte-for-byte the same JSON shape ws-server.ts expects.
 */
export {
  DEVICE_EVENTS_CHANNEL,
  MESSAGE_EVENTS_CHANNEL,
  CALL_EVENTS_CHANNEL,
  GROUP_EVENTS_CHANNEL,
  type DeviceEvent,
  type MessageEvent,
  type CallEvent,
  type GroupEvent,
};

export async function publishDeviceRevoked(deviceId: string): Promise<void> {
  const event: DeviceEvent = { type: 'revoked', deviceId };
  await getRedisClient().publish(DEVICE_EVENTS_CHANNEL, JSON.stringify(event));
}

async function publishMessageEvent(event: MessageEvent): Promise<void> {
  await getRedisClient().publish(MESSAGE_EVENTS_CHANNEL, JSON.stringify(event));
}

export async function publishNewMessage(message: MessageDto): Promise<void> {
  await publishMessageEvent({ type: 'new', targetDeviceId: message.recipientDeviceId, message });
}

export async function publishDelivered(targetDeviceId: string, messageId: string, deliveredAt: string): Promise<void> {
  await publishMessageEvent({ type: 'delivered', targetDeviceId, messageId, deliveredAt });
}

export async function publishRead(
  targetDeviceId: string,
  conversationId: string,
  upToMessageId: string,
  readAt: string,
): Promise<void> {
  await publishMessageEvent({ type: 'read', targetDeviceId, conversationId, upToMessageId, readAt });
}

export async function publishTyping(
  targetDeviceId: string,
  conversationId: string,
  fromUserId: string,
  state: 'start' | 'stop',
): Promise<void> {
  await publishMessageEvent({ type: 'typing', targetDeviceId, conversationId, fromUserId, state });
}

export async function publishDeleted(
  targetDeviceId: string,
  conversationId: string,
  messageId: string,
  reason: MessageDeletionReason,
): Promise<void> {
  await publishMessageEvent({ type: 'deleted', targetDeviceId, conversationId, messageId, reason });
}

async function publishCallEvent(event: CallEvent): Promise<void> {
  await getRedisClient().publish(CALL_EVENTS_CHANNEL, JSON.stringify(event));
}

export async function publishCallRing(
  targetDeviceId: string,
  conversationId: string,
  callId: string,
  fromUserId: string,
  fromDisplayName: string,
  sdp: CallSessionDescription,
): Promise<void> {
  await publishCallEvent({ type: 'call.ring', targetDeviceId, conversationId, callId, fromUserId, fromDisplayName, sdp });
}

export async function publishCallRinging(targetDeviceId: string, conversationId: string, callId: string): Promise<void> {
  await publishCallEvent({ type: 'call.ringing', targetDeviceId, conversationId, callId });
}

export async function publishCallAnswered(
  targetDeviceId: string,
  conversationId: string,
  callId: string,
  sdp: CallSessionDescription,
): Promise<void> {
  await publishCallEvent({ type: 'call.answered', targetDeviceId, conversationId, callId, sdp });
}

export async function publishCallIceCandidate(
  targetDeviceId: string,
  conversationId: string,
  callId: string,
  candidate: CallIceCandidateInit,
): Promise<void> {
  await publishCallEvent({ type: 'call.ice-candidate', targetDeviceId, conversationId, callId, candidate });
}

export async function publishCallRejected(
  targetDeviceId: string,
  conversationId: string,
  callId: string,
  reason: CallRejectReason,
): Promise<void> {
  await publishCallEvent({ type: 'call.rejected', targetDeviceId, conversationId, callId, reason });
}

export async function publishCallEnded(targetDeviceId: string, conversationId: string, callId: string): Promise<void> {
  await publishCallEvent({ type: 'call.ended', targetDeviceId, conversationId, callId });
}

async function publishGroupEvent(event: GroupEvent): Promise<void> {
  await getRedisClient().publish(GROUP_EVENTS_CHANNEL, JSON.stringify(event));
}

/** A live nudge that a durable `GroupKeyShare` row is waiting — the client reacts by
 * calling `GET /groups/:id/key-shares` (the REST catch-up is what actually delivers
 * the payload; this event only saves it from waiting for its next poll/reconnect).
 * `keyShareId` is included for symmetry/debuggability, not required by the client. */
export async function publishGroupKeyShare(targetDeviceId: string, groupId: string, keyShareId: string): Promise<void> {
  await publishGroupEvent({ type: 'group.key-share', targetDeviceId, groupId, keyShareId });
}

export async function publishGroupMembersChanged(targetDeviceId: string, groupId: string, conversationId: string): Promise<void> {
  await publishGroupEvent({ type: 'group.members-changed', targetDeviceId, groupId, conversationId });
}
