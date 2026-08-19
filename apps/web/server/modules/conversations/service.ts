import { prisma } from '@comm/database';
import { AppError, type ConversationSummary, type DisappearingTimer } from '@comm/types';

/**
 * `direct` (1:1) conversations are Phase 3; `group` conversations shipped ahead of
 * the original Phase 5 slot (docs/13-roadmap.md's group chat pass) — `toSummary`
 * below branches on `conversation.type` and is the one place that distinction is
 * resolved into the two `ConversationSummary` union shapes. No block-check here yet:
 * the `/contacts` module (blocking) hasn't landed, so this can't yet refuse "start a
 * conversation with someone who blocked you" — tracked as a follow-up, not silently
 * skipped without comment.
 */

async function toSummary(conversationId: string, callerUserId: string): Promise<ConversationSummary> {
  const conversation = await prisma.conversation.findUniqueOrThrow({
    where: { id: conversationId },
    include: { members: { include: { user: true } }, group: true },
  });
  const self = conversation.members.find((m) => m.userId === callerUserId)!;

  // `reaction` messages are real `Message` rows (they ride the exact same E2E
  // fan-out as everything else — server/modules/messages/service.ts never
  // special-cases them), but they're control messages, not content: WhatsApp
  // doesn't bump a chat's position or unread badge just because someone reacted
  // to something in it, so both queries below exclude them explicitly. Without
  // this, reacting to an old message would (wrongly) jump that conversation to
  // the top of the list and mark it unread for the other participant.
  const lastMessage = await prisma.message.findFirst({
    where: { conversationId, deletedAt: null, contentTypeHint: { not: 'reaction' } },
    orderBy: { serverReceivedAt: 'desc' },
  });

  const lastRead = self.lastReadMessageId
    ? await prisma.message.findUnique({ where: { id: self.lastReadMessageId } })
    : null;

  const unreadCount = await prisma.message.count({
    where: {
      conversationId,
      deletedAt: null,
      contentTypeHint: { not: 'reaction' },
      senderUserId: { not: callerUserId },
      ...(lastRead ? { serverReceivedAt: { gt: lastRead.serverReceivedAt } } : {}),
    },
  });

  const common = {
    id: conversation.id,
    disappearingTimer: conversation.disappearingTimer,
    lastMessageAt: lastMessage?.serverReceivedAt.toISOString() ?? null,
    unreadCount,
    archived: self.archived,
    pinned: self.pinned,
  };

  if (conversation.type === 'group') {
    // group is guaranteed non-null when type === 'group' (enforced at creation —
    // createGroup in server/modules/groups/service.ts always creates both rows in
    // one transaction), the `!` documents that invariant rather than silently
    // trusting it.
    const group = conversation.group!;
    return {
      ...common,
      type: 'group',
      group: { id: group.id, name: group.name, memberCount: conversation.members.length },
    };
  }

  const other = conversation.members.find((m) => m.userId !== callerUserId)!.user;
  return {
    ...common,
    type: 'direct',
    otherUser: { id: other.id, username: other.username, displayName: other.displayName },
  };
}

export async function createOrGetDirectConversation(callerUserId: string, withUsername: string): Promise<ConversationSummary> {
  const target = await prisma.user.findUnique({ where: { username: withUsername } });
  if (!target || target.status !== 'active') {
    throw new AppError('NOT_FOUND', 'User not found.');
  }
  if (target.id === callerUserId) {
    throw new AppError('VALIDATION_FAILED', 'You cannot start a conversation with yourself.');
  }

  const existing = await prisma.conversation.findFirst({
    where: {
      type: 'direct',
      members: { some: { userId: callerUserId } },
      AND: { members: { some: { userId: target.id } } },
    },
  });
  if (existing) {
    return toSummary(existing.id, callerUserId);
  }

  const created = await prisma.conversation.create({
    data: {
      type: 'direct',
      members: { create: [{ userId: callerUserId }, { userId: target.id }] },
    },
  });

  return toSummary(created.id, callerUserId);
}

export async function listConversations(callerUserId: string): Promise<ConversationSummary[]> {
  const memberships = await prisma.conversationMember.findMany({
    where: { userId: callerUserId },
    include: { conversation: true },
  });
  const summaries = await Promise.all(memberships.map((m) => toSummary(m.conversation.id, callerUserId)));
  return summaries.sort((a, b) => {
    const at = a.lastMessageAt ? new Date(a.lastMessageAt).getTime() : 0;
    const bt = b.lastMessageAt ? new Date(b.lastMessageAt).getTime() : 0;
    return bt - at;
  });
}

/**
 * Single-conversation fetch, membership-gated. The web client has never needed
 * this as a REST route — `(app)/chats/[id]/page.tsx` is server-rendered and reads
 * straight from `listConversations`/the DB — but the mobile client (lib/features/
 * chats/thread_screen.dart) has no server-rendered middle step and fetches a
 * conversation's summary directly on opening a thread. Was missing entirely until
 * a real device test surfaced it: the route file existed for PATCH already, so a
 * GET there 405'd instead of 404'ing, and the mobile client's generic
 * "malformed response" handling (it expects every response to be this app's own
 * `{ok, data}` JSON envelope, which a framework-generated 405 page isn't) is what
 * actually surfaced as "malformed response from server (405)" on the phone.
 */
export async function getConversation(callerUserId: string, conversationId: string): Promise<ConversationSummary> {
  await requireConversationMembership(callerUserId, conversationId);
  return toSummary(conversationId, callerUserId);
}

/**
 * `disappearingTimer` is a shared conversation setting — either member can change
 * it, same as WhatsApp (not owned by whoever last touched it); enforcement of the
 * timer itself is `apps/worker`'s expiry sweep (jobs/cleanup.ts), this just persists
 * the setting. `archived` is the opposite: a per-caller view preference (WhatsApp's
 * "Archive chat" — hides it from your own list only), so it's written to the
 * CALLER's own `ConversationMember` row specifically, never the other member's.
 */
export async function updateConversationSettings(
  callerUserId: string,
  conversationId: string,
  changes: { disappearingTimer?: DisappearingTimer; archived?: boolean; pinned?: boolean },
): Promise<ConversationSummary> {
  await requireConversationMembership(callerUserId, conversationId);

  if (changes.disappearingTimer !== undefined) {
    await prisma.conversation.update({ where: { id: conversationId }, data: { disappearingTimer: changes.disappearingTimer } });
  }
  if (changes.archived !== undefined || changes.pinned !== undefined) {
    await prisma.conversationMember.update({
      where: { conversationId_userId: { conversationId, userId: callerUserId } },
      data: {
        ...(changes.archived !== undefined ? { archived: changes.archived } : {}),
        ...(changes.pinned !== undefined ? { pinned: changes.pinned } : {}),
      },
    });
  }

  return toSummary(conversationId, callerUserId);
}

/** Authorization primitive reused by the messages module — re-derives membership
 * from the database every call, never trusted from a client-supplied claim
 * (docs/35-authorization.md). */
export async function requireConversationMembership(callerUserId: string, conversationId: string): Promise<void> {
  const membership = await prisma.conversationMember.findUnique({
    where: { conversationId_userId: { conversationId, userId: callerUserId } },
  });
  if (!membership) {
    throw new AppError('FORBIDDEN', 'You are not a member of this conversation.');
  }
}

/**
 * Used by the realtime layer to route typing indicators, read receipts, and
 * delete-for-everyone scrubs to every OTHER member's live sockets
 * (docs/04-websocket-realtime.md). Originally direct-conversation-only ("the other
 * member" was unambiguous) with a group variant deferred to "ships alongside group
 * support" — that follow-up was missed when groups actually shipped (found in
 * security review testing message ticks in a 3-person group: only one of the two
 * other members ever got a `read`/`typing`/`deleted` event). Generalized here to
 * every other member, and every active device of each — a strict superset of the
 * old direct-only, single-device behavior, so direct conversations are unaffected.
 */
export async function getAllOtherMembersActiveDeviceIds(
  conversationId: string,
  callerUserId: string,
): Promise<Array<{ userId: string; deviceId: string }>> {
  await requireConversationMembership(callerUserId, conversationId);

  const others = await prisma.conversationMember.findMany({
    where: { conversationId, userId: { not: callerUserId } },
    select: { userId: true },
  });
  if (others.length === 0) return [];

  const devices = await prisma.device.findMany({
    where: { userId: { in: others.map((m) => m.userId) }, status: 'active' },
    select: { id: true, userId: true },
  });
  return devices.map((d) => ({ userId: d.userId, deviceId: d.id }));
}

/**
 * The group-conversation analog of `getPrimaryRecipientDevice` above — same
 * single-device-per-member simplification (Phase 3's tracked gap, not solved anew
 * here), generalized from "the one other member" to "every other member." Used by
 * `sendMessage`'s fan-out loop (server/modules/messages/service.ts) — one
 * `MessageRecipient` row and one WS `new` event per device returned here.
 */
export async function getGroupMemberPrimaryDevices(
  conversationId: string,
  callerUserId: string,
): Promise<Array<{ userId: string; deviceId: string }>> {
  const others = await prisma.conversationMember.findMany({
    where: { conversationId, userId: { not: callerUserId } },
    select: { userId: true },
  });

  const targets = await Promise.all(
    others.map(async (m) => {
      const device = await prisma.device.findFirst({
        where: { userId: m.userId, status: 'active' },
        orderBy: { lastActiveAt: 'desc' },
      });
      return device ? { userId: m.userId, deviceId: device.id } : null;
    }),
  );
  return targets.filter((t): t is { userId: string; deviceId: string } => t !== null);
}
