/**
 * Dispatch for inbound WebSocket events (docs/04-websocket-realtime.md's event
 * catalog) — kept separate from ws-server.ts so that file stays focused on
 * connection/socket plumbing. Every handler re-derives authorization the same way
 * the REST routes do (via the module service functions, never trusting a
 * client-claimed field) — the WS transport is not a weaker authorization path than
 * HTTP, just a different one.
 */
import { z } from 'zod';
import {
  AppError,
  SendMessageRequest,
  CallInviteRequest,
  CallRingingRequest,
  CallAnswerRequest,
  CallIceCandidateRequest,
  CallRejectRequest,
  CallEndRequest,
  SendGroupKeyShareRequest,
} from '@comm/types';
import { RATE_LIMIT_RULES } from '@comm/security';
import type { AuthContext } from '../common/auth';
import { prisma } from '@comm/database';
import { sendMessage, acknowledgeDelivered, markConversationRead, getMessageSenderDeviceId } from '../modules/messages/service';
import { getAllOtherMembersActiveDeviceIds, requireConversationMembership } from '../modules/conversations/service';
import { isEitherBlocked } from '../modules/blocking/service';
import { createGroupKeyShare } from '../modules/groups/key-share-service';
import { setPendingCall, clearPendingCall } from '../modules/calls/pending';
import { recordCallInvited, recordCallAnswered, recordCallEnded } from '../modules/calls/history';
import { declineCall } from '../modules/calls/service';
import {
  publishNewMessage,
  publishDelivered,
  publishRead,
  publishTyping,
  publishCallRing,
  publishCallRinging,
  publishCallAnswered,
  publishCallIceCandidate,
  publishCallRejected,
  publishCallEnded,
  publishGroupKeyShare,
} from './bus';
import { enforceRateLimit } from '../common/rate-limit';

export type OutboundWsEvent = { type: string; [key: string]: unknown };

// `SendMessageRequest` is a `.refine()`d schema (ZodEffects), which has no
// `.extend()` — pull `type`/`conversationId` out with their own small schema
// instead, and validate the rest of the body with `SendMessageRequest` directly
// (extra keys a plain z.object doesn't know about, like these two, are stripped
// rather than rejected, so parsing the same raw body twice is safe).
const MessageSendEnvelope = z.object({
  type: z.literal('message.send'),
  conversationId: z.string().uuid(),
});
const MessageAckEnvelope = z.object({ type: z.literal('message.ack'), messageId: z.string().uuid() });
const MessageReadEnvelope = z.object({
  type: z.literal('message.read'),
  conversationId: z.string().uuid(),
  upToMessageId: z.string().uuid(),
});
const TypingEnvelope = z.object({
  type: z.enum(['typing.start', 'typing.stop']),
  conversationId: z.string().uuid(),
});
const CallInviteEnvelope = CallInviteRequest.extend({ type: z.literal('call.invite') });
const CallRingingEnvelope = CallRingingRequest.extend({ type: z.literal('call.ringing') });
const CallAnswerEnvelope = CallAnswerRequest.extend({ type: z.literal('call.answer') });
const CallIceCandidateEnvelope = CallIceCandidateRequest.extend({ type: z.literal('call.ice-candidate') });
const CallRejectEnvelope = CallRejectRequest.extend({ type: z.literal('call.reject') });
const CallEndEnvelope = CallEndRequest.extend({ type: z.literal('call.end') });
const GroupKeyShareEnvelope = SendGroupKeyShareRequest.extend({ type: z.literal('group.key-share') });

function errorEvent(err: unknown): OutboundWsEvent {
  if (err instanceof AppError) {
    return { type: 'error', code: err.code, message: err.message };
  }
  console.error('[realtime] unhandled inbound-message error', err);
  return { type: 'error', code: 'INTERNAL', message: 'Something went wrong. Please try again.' };
}

export async function handleInboundWsMessage(ctx: AuthContext, raw: string): Promise<OutboundWsEvent | null> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { type: 'error', code: 'VALIDATION_FAILED', message: 'Malformed message.' };
  }

  const typeResult = z.object({ type: z.string() }).safeParse(parsed);
  if (!typeResult.success) {
    return { type: 'error', code: 'VALIDATION_FAILED', message: 'Missing event type.' };
  }

  try {
    switch (typeResult.data.type) {
      case 'message.send': {
        // This WS event is fully implemented and rate-limited exactly like the REST
        // route (app/api/conversations/[id]/messages/route.ts) — same budget either
        // way, since it's the same underlying action — even though the shipped
        // client actually always sends via REST instead (see that route's own
        // comment on why). This was a real gap when only the REST path was limited:
        // an authenticated socket could otherwise spam `message.send` frames with no
        // ceiling at all.
        await enforceRateLimit(RATE_LIMIT_RULES.messageSend, ctx.userId);
        const envelope = MessageSendEnvelope.parse(parsed);
        const body = SendMessageRequest.parse(parsed);
        if (body.contentTypeHint === 'image' || body.contentTypeHint === 'voice') {
          await enforceRateLimit(RATE_LIMIT_RULES.mediaMessageSend, ctx.userId);
        }
        // One DTO per target device (multi-device fan-out — see messages/service.ts)
        // — each gets its own WS `new` event.
        const messages = await sendMessage(ctx, envelope.conversationId, body);
        for (const message of messages) {
          await publishNewMessage(message);
        }
        return { type: 'message.sent', messageId: messages[0]!.id, serverReceivedAt: messages[0]!.serverReceivedAt };
      }

      case 'message.ack': {
        const body = MessageAckEnvelope.parse(parsed);
        await acknowledgeDelivered(ctx.deviceId, body.messageId);
        const senderDeviceId = await getMessageSenderDeviceId(body.messageId);
        if (senderDeviceId) {
          await publishDelivered(senderDeviceId, body.messageId, new Date().toISOString());
        }
        return null; // no response needed — this itself IS the response to message.new
      }

      case 'message.read': {
        const body = MessageReadEnvelope.parse(parsed);
        const recorded = await markConversationRead(ctx.userId, body.conversationId, body.upToMessageId);
        if (recorded) {
          const others = await getAllOtherMembersActiveDeviceIds(body.conversationId, ctx.userId);
          const readAt = new Date().toISOString();
          for (const { deviceId } of others) {
            await publishRead(deviceId, body.conversationId, body.upToMessageId, readAt);
          }
        }
        return null;
      }

      case 'typing.start':
      case 'typing.stop': {
        const body = TypingEnvelope.parse(parsed);
        await requireConversationMembership(ctx.userId, body.conversationId);

        const privacy = await prisma.userPrivacySetting.findUnique({ where: { userId: ctx.userId } });
        if (privacy && privacy.typingIndicators === false) {
          return null; // the sender opted out of sharing their own typing state
        }

        const others = await getAllOtherMembersActiveDeviceIds(body.conversationId, ctx.userId);
        const state = body.type === 'typing.start' ? 'start' : 'stop';
        for (const { deviceId } of others) {
          await publishTyping(deviceId, body.conversationId, ctx.userId, state);
        }
        return null;
      }

      // Call signaling (docs/04-websocket-realtime.md's "Call signaling") — a blind
      // relay authorized purely by conversation membership. `getAllOtherMembersActiveDeviceIds`
      // both checks membership AND resolves who to relay to; nothing here trusts a
      // client-claimed device id, same pattern as message.send/typing/read above.
      //
      // Fans out to EVERY active device of the other conversation member, not just
      // a single guessed "primary" one (`getPrimaryRecipientDevice`, used here until
      // this pass) — found live as the root cause of "the push notification arrives
      // but no incoming-call screen ever appears": that heuristic picks whichever
      // device has the most recent `lastActiveAt`, which is only ever a guess the
      // instant more than one of a user's devices is genuinely active at once
      // (routine during mobile testing after a reinstall registers a fresh device
      // without the old session ever being told to stop, but just as real for
      // anyone signed into apps/web and apps/mobile simultaneously). Ringing every
      // active device and letting whichever one answers win — see call.answer
      // below — is what a real phone does across multiple devices, not a
      // workaround; messages/typing/read already fan out the identical way via this
      // same helper.
      case 'call.invite': {
        await enforceRateLimit(RATE_LIMIT_RULES.callInvite, ctx.userId);
        const body = CallInviteEnvelope.parse(parsed);
        const targets = await getAllOtherMembersActiveDeviceIds(body.conversationId, ctx.userId);
        // Blocked users (docs/13-roadmap.md) — silently no-ops, same as the
        // "nobody reachable" branch just below, rather than throwing: a caller
        // probing whether they're blocked should see the exact same outcome as
        // calling someone whose devices all happen to be offline, not a
        // distinct error that would confirm the block.
        const blocked = targets.length > 0 && (await isEitherBlocked(ctx.userId, targets[0]!.userId));
        if (targets.length > 0 && !blocked) {
          const caller = await prisma.user.findUnique({ where: { id: ctx.userId }, select: { displayName: true } });
          const fromDisplayName = caller?.displayName ?? 'Unknown';
          await recordCallInvited(body.callId, body.conversationId, ctx.userId);
          for (const target of targets) {
            // Stored BEFORE the pub/sub publish below, not after — a device that
            // reconnects and checks GET /calls/pending in the narrow window between
            // these two calls should already find it, not race an empty result.
            await setPendingCall(target.deviceId, body.conversationId, body.callId, ctx.userId, fromDisplayName, body.sdp);
            await publishCallRing(target.deviceId, body.conversationId, body.callId, ctx.userId, fromDisplayName, body.sdp);
          }
        }
        return null;
      }

      // Sent by the callee's device(s) the instant their own incoming-call screen
      // actually appears — see CallRingingRequest's own docstring (packages/types/
      // src/calls.ts) for why this exists: "Calling…" alone never told the caller
      // whether anything actually happened on the other end. Relayed to every one
      // of the CALLER's active devices, same fan-out reasoning as every other case
      // here — if the caller is also signed in on more than one device, all of them
      // should see "Ringing…", not just whichever one happened to be primary.
      case 'call.ringing': {
        await enforceRateLimit(RATE_LIMIT_RULES.callSignal, ctx.userId);
        const body = CallRingingEnvelope.parse(parsed);
        const targets = await getAllOtherMembersActiveDeviceIds(body.conversationId, ctx.userId);
        for (const target of targets) {
          await publishCallRinging(target.deviceId, body.conversationId, body.callId);
        }
        return null;
      }

      case 'call.answer': {
        await enforceRateLimit(RATE_LIMIT_RULES.callSignal, ctx.userId);
        const body = CallAnswerEnvelope.parse(parsed);
        const targets = await getAllOtherMembersActiveDeviceIds(body.conversationId, ctx.userId);
        if (targets.length > 0) {
          // A pending-call entry is always keyed by the CALLEE's device id (see
          // call.invite above) — the caller of THIS handler is the callee
          // answering, so that's `ctx.deviceId` here, not one of `targets` (which —
          // same "other conversation member" resolution every case in this block
          // uses — are the *caller's* devices from this side).
          await clearPendingCall(ctx.deviceId);
          await recordCallAnswered(body.callId);
          for (const target of targets) {
            await publishCallAnswered(target.deviceId, body.conversationId, body.callId, body.sdp);
          }
          // This user may have OTHER devices that were also ringing for this same
          // call (the whole reason call.invite fans out above) — now that one has
          // answered, tell each of them to stop, the multi-device counterpart to a
          // real phone's "answered elsewhere." Harmless no-op on a device that was
          // never actually ringing for this callId (checked client-side).
          const myOtherDevices = await prisma.device.findMany({
            where: { userId: ctx.userId, status: 'active', id: { not: ctx.deviceId } },
            select: { id: true },
          });
          for (const device of myOtherDevices) {
            await clearPendingCall(device.id);
            await publishCallRejected(device.id, body.conversationId, body.callId, 'answered_elsewhere');
          }
        }
        return null;
      }

      case 'call.ice-candidate': {
        await enforceRateLimit(RATE_LIMIT_RULES.callSignal, ctx.userId);
        const body = CallIceCandidateEnvelope.parse(parsed);
        const targets = await getAllOtherMembersActiveDeviceIds(body.conversationId, ctx.userId);
        for (const target of targets) {
          await publishCallIceCandidate(target.deviceId, body.conversationId, body.callId, body.candidate);
        }
        return null;
      }

      case 'call.reject': {
        await enforceRateLimit(RATE_LIMIT_RULES.callSignal, ctx.userId);
        const body = CallRejectEnvelope.parse(parsed);
        // call.reject is always sent by the callee (declining, or auto-busy from
        // call_controller.dart's `_onRing`) — same `ctx.deviceId` reasoning as
        // call.answer above. Extracted into declineCall (server/modules/calls/
        // service.ts) — see that function's own docstring for why forwarding
        // happens immediately rather than waiting on this user's other devices,
        // and it's also the exact same logic `POST /api/calls/decline` needs for
        // the notification "Decline" action button, which fires from a background
        // isolate with no WS to send this over at all.
        await declineCall(ctx.userId, ctx.deviceId, body.conversationId, body.callId, body.reason);
        return null;
      }

      case 'call.end': {
        await enforceRateLimit(RATE_LIMIT_RULES.callSignal, ctx.userId);
        const body = CallEndEnvelope.parse(parsed);
        const targets = await getAllOtherMembersActiveDeviceIds(body.conversationId, ctx.userId);
        // Unlike answer/reject, call.end can come from either side (the caller's
        // own ring-timeout giving up with "no answer" — call_controller.dart's
        // `startCall` — as well as a normal post-connect hangup from either end), so
        // `ctx.deviceId` isn't reliably "the callee" here the way it is above.
        // Clearing every one of `targets`' pending entries is: for the no-answer-
        // timeout case, exactly the devices that were ringing (the case that
        // matters); for every other case those entries are already gone by now
        // (answer already cleared them), so this is just a harmless no-op.
        await recordCallEnded(body.callId);
        for (const target of targets) {
          await clearPendingCall(target.deviceId);
          await publishCallEnded(target.deviceId, body.conversationId, body.callId);
        }
        return null;
      }

      // Group session key distribution (docs/13-roadmap.md's group chat pass) — a
      // blind device-to-device relay exactly like call signaling above, except the
      // payload is also durably stored (createGroupKeyShare), not just forwarded.
      // Not currently exercised by the shipped client, which sends key-shares via
      // `POST /api/groups/:id/key-shares` exclusively (a real bug found via live
      // testing: a fire-and-forget WS send silently drops if the socket isn't open
      // yet, which reliably happened right after creating a group and immediately
      // sending its first message). Kept as a redundant, already-authorized fast
      // path — harmless, and a real future option if a lower-latency WS-first path
      // is ever wanted — rather than removed.
      case 'group.key-share': {
        await enforceRateLimit(RATE_LIMIT_RULES.groupKeyShare, ctx.userId);
        const body = GroupKeyShareEnvelope.parse(parsed);
        const { dto, targetDeviceId } = await createGroupKeyShare(ctx.userId, ctx.deviceId, body);
        await publishGroupKeyShare(targetDeviceId, dto.groupId, dto.id);
        return null;
      }

      default:
        return { type: 'error', code: 'VALIDATION_FAILED', message: `Unknown event type: ${typeResult.data.type}` };
    }
  } catch (err) {
    return errorEvent(err);
  }
}
