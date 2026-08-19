import { prisma, CallStatus } from '@comm/database';
import type { CallHistoryEntry } from '@comm/types';

/**
 * Call history persistence (docs/02-database-schema.md's "Calls" section,
 * docs/13-roadmap.md's tracked gap — "no recent calls list, no missed-call log").
 * One row per call, written once at `call.invite` and updated in place as the call
 * resolves (message-handlers.ts's call.* cases call these three functions, in
 * addition to the existing signaling-relay/pending-call bookkeeping those cases
 * already do) — see the `Call` model's own docstring (schema.prisma) for the exact
 * state machine.
 */

export async function recordCallInvited(callId: string, conversationId: string, initiatorUserId: string): Promise<void> {
  // `status` defaults to `missed` in the schema — the correct terminal outcome if
  // nothing below ever updates this row (the callee's device never answers, and the
  // caller eventually gives up). Nothing here overrides that default; the other two
  // functions do only when the call's actual outcome differs from it.
  await prisma.call.create({
    data: { id: callId, conversationId, initiatorUserId },
  });
}

/** Idempotent by construction — `where: { id: callId }` only ever matches the one
 * row `recordCallInvited` created, and Prisma's `update` is a straight overwrite,
 * not an increment/append, so a retried or duplicate WS message can't corrupt this. */
export async function recordCallAnswered(callId: string): Promise<void> {
  await prisma.call.updateMany({
    where: { id: callId },
    data: { status: CallStatus.answered, startedAt: new Date() },
  });
}

export async function recordCallDeclined(callId: string): Promise<void> {
  await prisma.call.updateMany({
    where: { id: callId },
    data: { status: CallStatus.declined, endedAt: new Date() },
  });
}

/** Always sets `endedAt`, but only touches `status` if the call was never answered
 * (still sitting at the `missed` default) — a call.end for one that reached
 * `answered` first (a normal post-connect hangup) must not get overwritten back to
 * looking like a miss just because this is also where the call formally closes. */
export async function recordCallEnded(callId: string): Promise<void> {
  await prisma.call.updateMany({
    where: { id: callId, status: CallStatus.missed },
    data: { endedAt: new Date() },
  });
  await prisma.call.updateMany({
    where: { id: callId, status: { not: CallStatus.missed }, endedAt: null },
    data: { endedAt: new Date() },
  });
}

/**
 * "Recent calls" (apps/mobile's Calls tab) — every call across every conversation
 * this user is a member of, newest first. `direction` and `otherUser` are both
 * derived here rather than stored: 1:1-only calling means the conversation's other
 * member IS the other party, always (see the `Call` model's own docstring on why
 * there's no separate participants table yet), and direction is just a comparison
 * against `initiatorUserId` the caller already has to look up anyway.
 */
export async function listCallHistory(userId: string, limit: number): Promise<CallHistoryEntry[]> {
  const calls = await prisma.call.findMany({
    where: { conversation: { members: { some: { userId } } } },
    orderBy: { createdAt: 'desc' },
    take: limit,
    include: {
      conversation: {
        include: {
          group: true,
          members: {
            where: { userId: { not: userId } },
            include: { user: { select: { id: true, username: true, displayName: true } } },
          },
        },
      },
    },
  });

  return calls.map((call) => {
    // Group calls (docs/13-roadmap.md) have no single "other party" the way a 1:1
    // call's `members[0]` derivation already assumed — that would silently pick
    // an arbitrary OTHER member (not necessarily even someone who joined the
    // call) and mislabel the entry, so this branches on conversation type instead.
    const isGroup = call.conversation.type === 'group';
    const other = isGroup ? null : (call.conversation.members[0]?.user ?? null);
    return {
      id: call.id,
      conversationId: call.conversationId,
      otherUser: other,
      groupName: isGroup ? (call.conversation.group?.name ?? null) : null,
      direction: call.initiatorUserId === userId ? 'outgoing' : 'incoming',
      status: call.status,
      startedAt: call.startedAt?.toISOString() ?? null,
      endedAt: call.endedAt?.toISOString() ?? null,
      createdAt: call.createdAt.toISOString(),
    };
  });
}
