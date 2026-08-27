import type { MessageDto, MessageDeletionReason } from './messages';
import type { CallSessionDescription, CallIceCandidateInit, CallRejectReason, GroupCallParticipant } from './calls';
import type { LiveLocation } from './locations';

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
export const GROUP_CALL_EVENTS_CHANNEL = 'comm:group-call-events';
export const LOCATION_EVENTS_CHANNEL = 'comm:location-events';

export type DeviceEvent =
  | { type: 'revoked'; deviceId: string }
  /** A brand-new device is waiting for approval (docs/07-auth-architecture.md's
   * device-approval section) — fanned out to every one of the account's OTHER
   * currently active devices the instant `login()` creates the `PendingDeviceLogin`
   * row, same as every other per-device realtime event's `targetDeviceId`
   * convention. Purely a live nudge for an already-open/connected client (the
   * Devices screen's own fetch is the durable source of truth, same "REST is
   * durable, WS is just the fast path" relationship `group.key-share` already has
   * to its own REST catch-up) — a device that's backgrounded/closed instead relies
   * entirely on the push notification apps/worker's push-dispatch.ts sends for this
   * same event. */
  | { type: 'login_pending'; targetDeviceId: string; pendingLoginId: string; name: string; deviceType: string; requestedAt: string };

/**
 * Live-location fan-out (docs/09-trust-boundaries.md's "Live location sharing"
 * exception) — its own channel/union, not folded into `MessageEvent`, since a location
 * update isn't a message-table event and its recipient set is computed completely
 * differently (every `Admin` + every granted `LocationViewer`'s active devices, via
 * `getLocationViewerDeviceIds` in conversations/service.ts, not conversation
 * membership).
 */
export type LocationEvent = { type: 'location.updated'; targetDeviceId: string; location: LiveLocation };

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
  | { type: 'call.ringing'; targetDeviceId: string; conversationId: string; callId: string }
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

/**
 * Group call signaling (docs/13-roadmap.md) — see calls.ts's own module docstring
 * for the full protocol reasoning (why this is a separate namespace from `CallEvent`
 * above, why every peer-to-peer signal names its target explicitly). Own Redis
 * channel too (`GROUP_CALL_EVENTS_CHANNEL`), not reusing `CALL_EVENTS_CHANNEL` —
 * same "additive, zero risk to the already-shipped 1:1 path" reasoning as the rest
 * of this feature.
 */
export type GroupCallEvent =
  | {
      type: 'group-call.invited';
      targetDeviceId: string;
      conversationId: string;
      callId: string;
      fromUserId: string;
      fromDisplayName: string;
      groupName: string;
    }
  /** Sent ONLY to the joining device, right after `group-call.join` — informs
   * its UI who's already on the call (so it can render a tile per existing
   * participant right away) before any of their offers have arrived. The
   * joiner does NOT use this to open connections itself — see
   * `group-call.participant-joined` below for which side actually initiates. */
  | { type: 'group-call.roster'; targetDeviceId: string; conversationId: string; callId: string; participants: GroupCallParticipant[] }
  /** Fanned to every EXISTING participant when someone new joins — by
   * convention, existing participants always initiate the offer TO a new
   * joiner (avoids glare: the joiner never opens an offer to someone already
   * in the call, only answers the offers it receives, matching `group-call.roster`'s
   * own docstring above). */
  | { type: 'group-call.participant-joined'; targetDeviceId: string; conversationId: string; callId: string; participant: GroupCallParticipant }
  | { type: 'group-call.participant-left'; targetDeviceId: string; conversationId: string; callId: string; userId: string; deviceId: string }
  | { type: 'group-call.ended'; targetDeviceId: string; conversationId: string; callId: string }
  | {
      type: 'group-call.offer';
      targetDeviceId: string;
      conversationId: string;
      callId: string;
      fromUserId: string;
      fromDeviceId: string;
      sdp: CallSessionDescription;
    }
  | {
      type: 'group-call.answer';
      targetDeviceId: string;
      conversationId: string;
      callId: string;
      fromUserId: string;
      fromDeviceId: string;
      sdp: CallSessionDescription;
    }
  | {
      type: 'group-call.ice-candidate';
      targetDeviceId: string;
      conversationId: string;
      callId: string;
      fromUserId: string;
      fromDeviceId: string;
      candidate: CallIceCandidateInit;
    };
