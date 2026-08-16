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

export const CallRejectReason = z.enum(['declined', 'busy', 'no-answer']);
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
