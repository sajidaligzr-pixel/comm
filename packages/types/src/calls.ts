import { z } from 'zod';

/**
 * 1:1 audio calling (docs/04-websocket-realtime.md's "Call signaling" section) —
 * shipped ahead of the rest of Phase 6 as a narrow slice: audio only, direct
 * conversations only, no group calls, no `calls`/`call_participants` history
 * persistence yet (see docs/13-roadmap.md). The server never inspects `sdp` or
 * `candidate` contents — it's a blind relay authorized by conversation membership,
 * same trust model as message delivery.
 */

export const CallSessionDescription = z.object({
  type: z.enum(['offer', 'answer']),
  sdp: z.string().max(16 * 1024, 'Malformed call offer.'),
});
export type CallSessionDescription = z.infer<typeof CallSessionDescription>;

export const CallIceCandidateInit = z.object({
  candidate: z.string().max(4 * 1024, 'Malformed ICE candidate.'),
  sdpMid: z.string().nullable(),
  sdpMLineIndex: z.number().int().nullable(),
  usernameFragment: z.string().nullable().optional(),
});
export type CallIceCandidateInit = z.infer<typeof CallIceCandidateInit>;

// 'answered_elsewhere' is server-generated only (never sent by a client in a
// CallRejectRequest) — see message-handlers.ts's `call.answer` case: when one of
// this user's several simultaneously-active devices answers, every OTHER device
// that was also ringing for the same call gets told this, the multi-device
// counterpart to a real phone's "answered on another device, stop ringing here."
// Found live as the root cause of "notification arrives, but no incoming-call
// screen anywhere" — a call was being targeted at exactly one of a user's active
// devices (`getPrimaryRecipientDevice`'s "most recently active" guess), which is
// fragile the moment more than one of a user's devices is genuinely
// active — routine after a reinstall during testing, but just as real for anyone
// who's simply signed in on both apps/web and apps/mobile at once. Call signaling
// now fans out to every active device of the other conversation member instead of
// guessing one.
export const CallRejectReason = z.enum(['declined', 'busy', 'no-answer', 'answered_elsewhere']);
export type CallRejectReason = z.infer<typeof CallRejectReason>;

/** C→S WS envelopes (docs/04-websocket-realtime.md). Every event carries
 * `conversationId`, never a client-claimed target device — the server always
 * re-resolves "the other member's device" itself (server/modules/conversations/service.ts's
 * `getPrimaryRecipientDevice`), the same Phase-3 single-device-target simplification
 * messages already use. */
export const CallInviteRequest = z.object({
  conversationId: z.string().uuid(),
  callId: z.string().uuid(),
  sdp: CallSessionDescription,
});
export type CallInviteRequest = z.infer<typeof CallInviteRequest>;

/** Sent by the CALLEE the instant its own incoming-call screen actually appears
 * (call_controller.dart's `_onRing`/call-provider.tsx's equivalent — both the live
 * WS path and the push/REST catch-up path funnel into the exact same handler, so
 * this fires for either one identically), so the caller's "Calling…" can become
 * "Ringing…" the moment there's real confirmation the other side is actually being
 * notified — the same distinction a real phone call makes, and one this app never
 * made before: "Calling…" alone doesn't tell you anything actually happened on the
 * other end (found live, reported directly — it stayed "Calling…" for the whole
 * timeout even when the other person was online with a normal connection). No SDP
 * here — this is pure status, not signaling. */
export const CallRingingRequest = z.object({
  conversationId: z.string().uuid(),
  callId: z.string().uuid(),
});
export type CallRingingRequest = z.infer<typeof CallRingingRequest>;

export const CallAnswerRequest = z.object({
  conversationId: z.string().uuid(),
  callId: z.string().uuid(),
  sdp: CallSessionDescription,
});
export type CallAnswerRequest = z.infer<typeof CallAnswerRequest>;

export const CallIceCandidateRequest = z.object({
  conversationId: z.string().uuid(),
  callId: z.string().uuid(),
  candidate: CallIceCandidateInit,
});
export type CallIceCandidateRequest = z.infer<typeof CallIceCandidateRequest>;

export const CallRejectRequest = z.object({
  conversationId: z.string().uuid(),
  callId: z.string().uuid(),
  reason: CallRejectReason,
});
export type CallRejectRequest = z.infer<typeof CallRejectRequest>;

export const CallEndRequest = z.object({
  conversationId: z.string().uuid(),
  callId: z.string().uuid(),
});
export type CallEndRequest = z.infer<typeof CallEndRequest>;

/** `POST /calls/turn-credentials` response (docs/03-api-design.md). Empty array is a
 * valid response — it means no coturn deployment is configured yet
 * (`TURN_SHARED_SECRET`/`TURN_URLS`, docs/11-deployment-architecture.md) and ICE will
 * only gather host/reflexive candidates, which is enough for same-network/localhost
 * testing but not for two peers behind arbitrary real-world NATs. */
export const IceServer = z.object({
  urls: z.union([z.string(), z.array(z.string())]),
  username: z.string().optional(),
  credential: z.string().optional(),
});
export type IceServer = z.infer<typeof IceServer>;

export const IceServersResponse = z.object({
  iceServers: z.array(IceServer),
});
export type IceServersResponse = z.infer<typeof IceServersResponse>;

/**
 * `GET /calls/pending` response (apps/mobile's push notification pass) — the durable
 * counterpart to `CallEvent`'s `call.ring` variant (realtime.ts), for a call this
 * device's socket wasn't connected to receive live: `publishCallRing` is a bare
 * Redis pub/sub publish with no subscriber-side durability, so a device that was
 * fully closed/backgrounded when it fired never gets a second chance at it over WS —
 * this is that second chance, checked once after reconnecting (server/modules/calls/
 * pending.ts stores it with a TTL matching the ring timeout, same window the caller's
 * own client gives up waiting after). Same field shape as `call.ring` on purpose, so
 * a client can feed either straight into the same "start ringing" handler. `null`
 * (not a 404) when there's nothing pending — the normal case, not an error.
 */
/** `GET /calls/history` response entry (apps/mobile's Calls tab) — see
 * server/modules/calls/history.ts's own docstring for exactly how `direction` and
 * `otherUser` get derived. `status` mirrors the `CallStatus` Prisma enum
 * (schema.prisma's `Call` model) exactly, not redefined here as a Zod enum, to
 * avoid the two silently drifting apart. */
export const CallHistoryEntry = z.object({
  id: z.string().uuid(),
  conversationId: z.string().uuid(),
  otherUser: z
    .object({
      id: z.string().uuid(),
      username: z.string(),
      displayName: z.string(),
    })
    .nullable(),
  /** Set instead of `otherUser` for a group call (docs/13-roadmap.md) — group
   * calls have no single "other party" to derive the way a 1:1 call's `otherUser`
   * already did (the conversation's other member, always). Exactly one of
   * `otherUser`/`groupName` is ever non-null. */
  groupName: z.string().nullable(),
  direction: z.enum(['incoming', 'outgoing']),
  status: z.enum(['answered', 'missed', 'declined']),
  startedAt: z.string().nullable(),
  endedAt: z.string().nullable(),
  createdAt: z.string(),
});
export type CallHistoryEntry = z.infer<typeof CallHistoryEntry>;

export const PendingCallResponse = z
  .object({
    conversationId: z.string().uuid(),
    callId: z.string().uuid(),
    fromUserId: z.string().uuid(),
    fromDisplayName: z.string(),
    sdp: CallSessionDescription,
  })
  .nullable();
export type PendingCallResponse = z.infer<typeof PendingCallResponse>;

/**
 * Group calls (docs/13-roadmap.md) — a SEPARATE signaling namespace from the 1:1
 * events above, deliberately not reusing them: those broadcast one SDP/ICE payload
 * to "the other member" (correct for exactly one peer, via
 * `getAllOtherMembersActiveDeviceIds`'s blanket fan-out); a mesh call's
 * offer/answer/ICE legs are inherently PAIRWISE between whichever two participants
 * are negotiating, so every signaling payload here names its target explicitly
 * (`targetUserId`/`targetDeviceId`) and the server relays to exactly that one
 * device, never broadcasts. Audio-only, same as 1:1 — no video plumbing exists
 * anywhere in this app yet.
 *
 * Mesh, not an SFU: every participant opens a direct `RTCPeerConnection` to every
 * OTHER participant (N-1 connections each). That degrades past a handful of people
 * (each participant's upload bandwidth multiplies by N-1), which is exactly why
 * `GROUP_CALL_MAX_PARTICIPANTS` exists — a real SFU (a genuinely new media-server
 * service) is the right answer if usage ever outgrows this, not attempted here per
 * this project's "no extra infrastructure unless the code actually needs it yet"
 * posture (docs/13-roadmap.md).
 *
 * No `call_participants` table — the LIVE roster during an active call is tracked
 * in Redis (server/modules/calls/group-roster.ts), ephemeral by nature (who's
 * currently connected), while `Call` (schema.prisma, reused as-is) still records
 * one history row per call exactly like a 1:1 call does.
 */
export const GROUP_CALL_MAX_PARTICIPANTS = 6;

export const GroupCallStartRequest = z.object({
  conversationId: z.string().uuid(), // must be a `group` conversation
  callId: z.string().uuid(),
});
export type GroupCallStartRequest = z.infer<typeof GroupCallStartRequest>;

export const GroupCallJoinRequest = z.object({
  conversationId: z.string().uuid(),
  callId: z.string().uuid(),
});
export type GroupCallJoinRequest = z.infer<typeof GroupCallJoinRequest>;

export const GroupCallLeaveRequest = z.object({
  conversationId: z.string().uuid(),
  callId: z.string().uuid(),
});
export type GroupCallLeaveRequest = z.infer<typeof GroupCallLeaveRequest>;

const GroupCallPeerSignalBase = {
  conversationId: z.string().uuid(),
  callId: z.string().uuid(),
  targetUserId: z.string().uuid(),
  targetDeviceId: z.string().uuid(),
};

export const GroupCallOfferRequest = z.object({ ...GroupCallPeerSignalBase, sdp: CallSessionDescription });
export type GroupCallOfferRequest = z.infer<typeof GroupCallOfferRequest>;

export const GroupCallAnswerRequest = z.object({ ...GroupCallPeerSignalBase, sdp: CallSessionDescription });
export type GroupCallAnswerRequest = z.infer<typeof GroupCallAnswerRequest>;

export const GroupCallIceCandidateRequest = z.object({ ...GroupCallPeerSignalBase, candidate: CallIceCandidateInit });
export type GroupCallIceCandidateRequest = z.infer<typeof GroupCallIceCandidateRequest>;

export const GroupCallParticipant = z.object({
  userId: z.string().uuid(),
  deviceId: z.string().uuid(),
  displayName: z.string(),
});
export type GroupCallParticipant = z.infer<typeof GroupCallParticipant>;
