import { prisma } from '@comm/database';
import { AppError, GROUP_CALL_MAX_PARTICIPANTS, type GroupCallParticipant } from '@comm/types';
import { requireConversationMembership, getAllOtherMembersActiveDeviceIds } from '../conversations/service';
import { recordCallInvited, recordCallAnswered, recordCallEnded } from './history';
import { addParticipant, removeParticipant, listParticipants, clearRoster } from './group-roster';
import {
  publishGroupCallInvited,
  publishGroupCallRoster,
  publishGroupCallParticipantJoined,
  publishGroupCallParticipantLeft,
  publishGroupCallEnded,
} from '../../realtime/bus';

/**
 * Group call orchestration (docs/13-roadmap.md) — see calls.ts's own module
 * docstring (packages/types) for the full mesh-signaling design. This is the
 * membership/roster half; the actual per-peer offer/answer/ICE relay is simple
 * enough (validate + blind-forward) to live directly in message-handlers.ts,
 * same as the 1:1 call.* cases already do.
 */

async function requireGroupConversation(conversationId: string): Promise<{ groupName: string }> {
  const conversation = await prisma.conversation.findUnique({ where: { id: conversationId }, include: { group: true } });
  if (!conversation || conversation.type !== 'group' || !conversation.group) {
    throw new AppError('VALIDATION_FAILED', 'Group calls require a group conversation.');
  }
  return { groupName: conversation.group.name };
}

/** Starts a group call: one `Call` history row (reused as-is from 1:1 calling —
 * see that model's own doc comment), the initiator added to the live roster, and
 * every OTHER member's every active device rung — the exact same
 * `getAllOtherMembersActiveDeviceIds` fan-out 1:1 calling and messaging already
 * use, since "notify every member" is identical either way; only the
 * offer/answer/ICE legs that follow need per-peer targeting. */
export async function startGroupCall(
  callerUserId: string,
  callerDeviceId: string,
  conversationId: string,
  callId: string,
): Promise<void> {
  const { groupName } = await requireGroupConversation(conversationId);
  await requireConversationMembership(callerUserId, conversationId);

  const caller = await prisma.user.findUniqueOrThrow({ where: { id: callerUserId }, select: { displayName: true } });
  await recordCallInvited(callId, conversationId, callerUserId);
  await addParticipant(callId, { userId: callerUserId, deviceId: callerDeviceId, displayName: caller.displayName });

  const targets = await getAllOtherMembersActiveDeviceIds(conversationId, callerUserId);
  for (const target of targets) {
    await publishGroupCallInvited(target.deviceId, conversationId, callId, callerUserId, caller.displayName, groupName);
  }
}

/**
 * A member joins an in-progress (or just-started) call: added to the roster,
 * sent the CURRENT roster to open outbound offers to, and every already-there
 * participant is told a new joiner arrived so THEY open an offer to the new
 * joiner too — see `GroupCallEvent`'s own docstring on why that direction is
 * the deliberate glare-avoidance convention (a joiner only ever answers, never
 * initiates). Idempotent (a retried/duplicate join for a device already on the
 * roster is a no-op) and capped at `GROUP_CALL_MAX_PARTICIPANTS` — see that
 * constant's own doc comment (packages/types/src/calls.ts) for why a mesh call
 * needs a real ceiling.
 */
export async function joinGroupCall(
  callerUserId: string,
  callerDeviceId: string,
  conversationId: string,
  callId: string,
): Promise<void> {
  await requireGroupConversation(conversationId);
  await requireConversationMembership(callerUserId, conversationId);

  const existing = await listParticipants(callId);
  if (existing.some((p) => p.userId === callerUserId && p.deviceId === callerDeviceId)) {
    return;
  }
  if (existing.length >= GROUP_CALL_MAX_PARTICIPANTS) {
    throw new AppError('VALIDATION_FAILED', `This call is full (max ${GROUP_CALL_MAX_PARTICIPANTS} people).`);
  }

  const caller = await prisma.user.findUniqueOrThrow({ where: { id: callerUserId }, select: { displayName: true } });
  const me: GroupCallParticipant = { userId: callerUserId, deviceId: callerDeviceId, displayName: caller.displayName };
  await addParticipant(callId, me);

  // A second (or later) participant joining is what makes this a genuinely
  // CONNECTED call, not a missed one — mirrors 1:1 calling's `recordCallAnswered`
  // at the moment the callee actually answers; there's no single "answer" event
  // in a group call, so the first join-after-the-initiator is the equivalent
  // moment.
  if (existing.length > 0) {
    await recordCallAnswered(callId);
  }

  await publishGroupCallRoster(callerDeviceId, conversationId, callId, existing);
  for (const p of existing) {
    await publishGroupCallParticipantJoined(p.deviceId, conversationId, callId, me);
  }
}

/** Leaving auto-ends the call once the roster is empty — no separate "end call
 * for everyone" action exists; a group call simply winds down the same way a
 * real conversation does, one person leaving at a time. When it does end, EVERY
 * other group member's every active device is told (`getAllOtherMembersActiveDeviceIds`,
 * not just whoever was on the roster) — a member who never joined still received
 * `group-call.invited` when this call started, and would otherwise be left with
 * a stale "ongoing call" indicator forever if only actual participants were
 * notified. */
export async function leaveGroupCall(
  callerUserId: string,
  callerDeviceId: string,
  conversationId: string,
  callId: string,
): Promise<void> {
  await requireConversationMembership(callerUserId, conversationId);
  await removeParticipant(callId, callerUserId, callerDeviceId);

  const remaining = await listParticipants(callId);
  for (const p of remaining) {
    await publishGroupCallParticipantLeft(p.deviceId, conversationId, callId, callerUserId, callerDeviceId);
  }
  if (remaining.length === 0) {
    await clearRoster(callId);
    await recordCallEnded(callId);
    const everyone = await getAllOtherMembersActiveDeviceIds(conversationId, callerUserId);
    for (const target of everyone) {
      await publishGroupCallEnded(target.deviceId, conversationId, callId);
    }
  }
}

export async function getGroupCallRoster(callerUserId: string, conversationId: string, callId: string): Promise<GroupCallParticipant[]> {
  await requireConversationMembership(callerUserId, conversationId);
  return listParticipants(callId);
}

/**
 * Authorizes a single peer-to-peer signaling relay (offer/answer/ICE-candidate)
 * before message-handlers.ts blindly forwards it — the server never inspects
 * `sdp`/`candidate` contents (same trust model as 1:1 calling and message
 * delivery), but WHO it'll relay to is still checked: `targetDeviceId` must
 * genuinely belong to `targetUserId`, and that user must actually be a member
 * of this conversation — never trust a client-claimed target device id
 * (docs/35-authorization.md's rule, same one `sendMessage`'s multi-device
 * fan-out already applies).
 */
export async function assertValidGroupCallTarget(
  callerUserId: string,
  conversationId: string,
  targetUserId: string,
  targetDeviceId: string,
): Promise<void> {
  await requireConversationMembership(callerUserId, conversationId);
  const [target, targetMembership] = await Promise.all([
    prisma.device.findUnique({ where: { id: targetDeviceId }, select: { userId: true, status: true } }),
    prisma.conversationMember.findUnique({ where: { conversationId_userId: { conversationId, userId: targetUserId } } }),
  ]);
  if (!target || target.userId !== targetUserId || target.status !== 'active' || !targetMembership) {
    throw new AppError('VALIDATION_FAILED', 'Invalid call target.');
  }
}
