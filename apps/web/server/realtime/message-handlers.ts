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
import { getAllOtherMembersActiveDeviceIds, requireConversationMembership, getPrimaryRecipientDevice } from '../modules/conversations/service';
import { createGroupKeyShare } from '../modules/groups/key-share-service';
import {
  publishNewMessage,
  publishDelivered,
  publishRead,
  publishTyping,
  publishCallRing,
  publishCallAnswered,
  publishCallIceCandidate,
  publishCallRejected,
  publishCallEnded,
  publishGroupKeyShare,
} from './bus';
import { enforceRateLimit } from '../common/rate-limit';

export type OutboundWsEvent = { type: string; [key: string]: unknown };

const MessageSendEnvelope = SendMessageRequest.extend({
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
        const body = MessageSendEnvelope.parse(parsed);
        if (body.contentTypeHint === 'image' || body.contentTypeHint === 'voice') {
          await enforceRateLimit(RATE_LIMIT_RULES.mediaMessageSend, ctx.userId);
        }
        // One DTO per target device (docs/13-roadmap.md's group chat pass — a direct
        // conversation always yields exactly one) — each gets its own WS `new` event.
        const messages = await sendMessage(ctx, body.conversationId, body);
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
      // relay authorized purely by conversation membership. `getPrimaryRecipientDevice`
      // both checks membership AND resolves who to relay to; nothing here trusts a
      // client-claimed device id, same pattern as message.send/typing/read above.
      case 'call.invite': {
        await enforceRateLimit(RATE_LIMIT_RULES.callInvite, ctx.userId);
        const body = CallInviteEnvelope.parse(parsed);
        const recipient = await getPrimaryRecipientDevice(body.conversationId, ctx.userId);
        if (recipient) {
          const caller = await prisma.user.findUnique({ where: { id: ctx.userId }, select: { displayName: true } });
          await publishCallRing(
            recipient.deviceId,
            body.conversationId,
            body.callId,
            ctx.userId,
            caller?.displayName ?? 'Unknown',
            body.sdp,
          );
        }
        return null;
      }

      case 'call.answer': {
        await enforceRateLimit(RATE_LIMIT_RULES.callSignal, ctx.userId);
        const body = CallAnswerEnvelope.parse(parsed);
        const recipient = await getPrimaryRecipientDevice(body.conversationId, ctx.userId);
        if (recipient) {
          await publishCallAnswered(recipient.deviceId, body.conversationId, body.callId, body.sdp);
        }
        return null;
      }

      case 'call.ice-candidate': {
        await enforceRateLimit(RATE_LIMIT_RULES.callSignal, ctx.userId);
        const body = CallIceCandidateEnvelope.parse(parsed);
        const recipient = await getPrimaryRecipientDevice(body.conversationId, ctx.userId);
        if (recipient) {
          await publishCallIceCandidate(recipient.deviceId, body.conversationId, body.callId, body.candidate);
        }
        return null;
      }

      case 'call.reject': {
        await enforceRateLimit(RATE_LIMIT_RULES.callSignal, ctx.userId);
        const body = CallRejectEnvelope.parse(parsed);
        const recipient = await getPrimaryRecipientDevice(body.conversationId, ctx.userId);
        if (recipient) {
          await publishCallRejected(recipient.deviceId, body.conversationId, body.callId, body.reason);
        }
        return null;
      }

      case 'call.end': {
        await enforceRateLimit(RATE_LIMIT_RULES.callSignal, ctx.userId);
        const body = CallEndEnvelope.parse(parsed);
        const recipient = await getPrimaryRecipientDevice(body.conversationId, ctx.userId);
        if (recipient) {
          await publishCallEnded(recipient.deviceId, body.conversationId, body.callId);
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
