import type { MessageDto, MessageDeletionReason } from './messages';
import type { CallSessionDescription, CallIceCandidateInit, CallRejectReason } from './calls';

/**
 * Shared between `apps/web` (publishes most of these from Route Handlers/WS
 * handlers, subscribes in server/realtime/ws-server.ts) and `apps/worker` (publishes
 * `deleted` when disappearing-message expiry sweeps a message) — living in
 * `packages/types` rather than `apps/web` so a background job in a different app can
 * emit the exact same wire shape without one app importing from the other
 * (docs/01-folder-structure.md's module-isolation rule).
 */
export const DEVICE_EVENTS_CHANNEL = 'comm:device-events';
export const MESSAGE_EVENTS_CHANNEL = 'comm:message-events';
export const CALL_EVENTS_CHANNEL = 'comm:call-events';
export const GROUP_EVENTS_CHANNEL = 'comm:group-events';

export type DeviceEvent = { type: 'revoked'; deviceId: string };

/**
 * Every variant carries `targetDeviceId` — the one device this specific event is
 * for (docs/04-websocket-realtime.md).
 */
export type MessageEvent =
  | { type: 'new'; targetDeviceId: string; message: MessageDto }
  | { type: 'delivered'; targetDeviceId: string; messageId: string; deliveredAt: string }
  | { type: 'read'; targetDeviceId: string; conversationId: string; upToMessageId: string; readAt: string }
  | { type: 'typing'; targetDeviceId: string; conversationId: string; fromUserId: string; state: 'start' | 'stop' }
  | { type: 'deleted'; targetDeviceId: string; conversationId: string; messageId: string; reason: MessageDeletionReason };

/**
 * Call signaling (docs/04-websocket-realtime.md's "Call signaling" section) — a
 * separate channel/union from `MessageEvent` since these aren't message-table events
 * at all, just a blind SDP/ICE relay between the two conversation members. Every
 * variant carries `targetDeviceId`, same convention as `MessageEvent`.
 */
export type CallEvent =
  | {
      type: 'call.ring';
      targetDeviceId: string;
      conversationId: string;
      callId: string;
      fromUserId: string;
      fromDisplayName: string;
      sdp: CallSessionDescription;
    }
  | { type: 'call.answered'; targetDeviceId: string; conversationId: string; callId: string; sdp: CallSessionDescription }
  | { type: 'call.ice-candidate'; targetDeviceId: string; conversationId: string; callId: string; candidate: CallIceCandidateInit }
  | { type: 'call.rejected'; targetDeviceId: string; conversationId: string; callId: string; reason: CallRejectReason }
  | { type: 'call.ended'; targetDeviceId: string; conversationId: string; callId: string };

/**
 * Group key distribution + membership-change notification (docs/13-roadmap.md's
 * group chat pass) — a separate channel from `MessageEvent` for the same reason
 * `CallEvent` is: `group.key-share` isn't a message-table event, it's a live nudge
 * that a durable `GroupKeyShare` row (server/modules/groups/service.ts) is waiting;
 * the REST catch-up (`GET /groups/:id/key-shares`) is what makes it durable, this is
 * only the "you don't have to wait for your next poll" fast path. `group.members-changed`
 * is what tells already-connected clients to react (rotate + redistribute, or fetch a
 * newly-shared session) without needing a page refresh.
 */
export type GroupEvent =
  | { type: 'group.key-share'; targetDeviceId: string; groupId: string; keyShareId: string }
  | { type: 'group.members-changed'; targetDeviceId: string; groupId: string; conversationId: string };
