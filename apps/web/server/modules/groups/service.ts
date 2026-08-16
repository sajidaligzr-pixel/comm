import { prisma } from '@comm/database';
import { AppError, type GroupSummary, type GroupMemberDto } from '@comm/types';
import { requireConversationMembership, getGroupMemberPrimaryDevices } from '../conversations/service';

/**
 * Group CRUD + membership (docs/13-roadmap.md's group chat pass, ahead of the
 * original Phase 5 slot). A group and its `Conversation` row are created together,
 * always — `GroupMember` (crypto/authorization membership, epoch-aware) and
 * `ConversationMember` (message visibility) are kept in lockstep by every function
 * here, never updated independently, so `conversations/service.ts`'s existing
 * `requireConversationMembership` continues to be the one gate every message/typing/
 * read path already relies on.
 */

async function toGroupSummary(groupId: string, callerUserId: string): Promise<GroupSummary> {
  const group = await prisma.group.findUniqueOrThrow({
    where: { id: groupId },
    include: {
      conversation: true,
      members: { where: { removedAt: null }, include: { user: true }, orderBy: { joinedAt: 'asc' } },
    },
  });
  const self = group.members.find((m) => m.userId === callerUserId);
  if (!self) {
    throw new AppError('FORBIDDEN', 'You are not a member of this group.');
  }

  const members: GroupMemberDto[] = group.members.map((m) => ({
    userId: m.userId,
    username: m.user.username,
    displayName: m.user.displayName,
    role: m.role,
    joinedAt: m.joinedAt.toISOString(),
  }));

  return {
    id: group.id,
    conversationId: group.conversation!.id,
    name: group.name,
    description: group.description,
    onlyAdminsCanMessage: group.onlyAdminsCanMessage,
    callerRole: self.role,
    members,
    createdAt: group.createdAt.toISOString(),
  };
}

/**
 * Creates the `Group`, its `Conversation`, and every member's `GroupMember` +
 * `ConversationMember` row, plus the initial `GroupSession(epoch: 0)` bookkeeping
 * row, all in one transaction — a group is never observably half-created. Member
 * usernames are resolved the same way `/conversations/direct` resolves
 * `withUsername`: looked up, required active, deduplicated, self excluded.
 */
export async function createGroup(
  callerUserId: string,
  name: string,
  description: string | undefined,
  memberUsernames: string[],
): Promise<GroupSummary> {
  const normalized = Array.from(new Set(memberUsernames.map((u) => u.toLowerCase())));
  const users = await prisma.user.findMany({ where: { username: { in: normalized }, status: 'active' } });
  const foundUsernames = new Set(users.map((u) => u.username.toLowerCase()));
  const missing = normalized.filter((u) => !foundUsernames.has(u));
  if (missing.length > 0) {
    throw new AppError('NOT_FOUND', `Could not find: ${missing.join(', ')}`);
  }

  const memberIds = Array.from(new Set([callerUserId, ...users.map((u) => u.id)]));
  if (memberIds.length < 2) {
    throw new AppError('VALIDATION_FAILED', 'A group needs at least one other member.');
  }

  const group = await prisma.$transaction(async (tx) => {
    const created = await tx.group.create({
      data: {
        name,
        description: description ?? null,
        conversation: { create: { type: 'group' } },
        members: {
          create: memberIds.map((userId) => ({ userId, role: userId === callerUserId ? 'admin' : 'member' })),
        },
        sessions: { create: { epoch: 0 } },
      },
      include: { conversation: true },
    });
    await tx.conversationMember.createMany({
      data: memberIds.map((userId) => ({ conversationId: created.conversation!.id, userId })),
    });
    return created;
  });

  return toGroupSummary(group.id, callerUserId);
}

export async function getGroup(groupId: string, callerUserId: string): Promise<GroupSummary> {
  return toGroupSummary(groupId, callerUserId);
}

/**
 * Which single device to target per OTHER current member, for the CALLER to
 * key-share a group session to (docs/13-roadmap.md's design note) — the client-side
 * analog of "who do I need to send my outbound session to." Delegates to the
 * conversations module's `getGroupMemberPrimaryDevices` (same single-device-per-member
 * simplification `getPrimaryRecipientDevice` already uses for 1:1) after resolving
 * `groupId` to its `conversationId`.
 */
export async function getGroupMemberDeviceTargets(
  groupId: string,
  callerUserId: string,
): Promise<Array<{ userId: string; deviceId: string }>> {
  const group = await prisma.group.findUnique({ where: { id: groupId }, include: { conversation: true } });
  if (!group) throw new AppError('NOT_FOUND', 'Group not found.');
  // Caller must currently be a member — re-derived from the DB, never assumed from
  // the fact that they know a valid groupId. Without this, any authenticated user
  // (or a just-removed former member) could enumerate every current member's userId
  // + deviceId for a group they don't belong to (found in security review).
  await requireConversationMembership(callerUserId, group.conversation!.id);
  return getGroupMemberPrimaryDevices(group.conversation!.id, callerUserId);
}

/** Every CURRENT member's active devices — used to notify clients of a membership
 * change (`group.members-changed`, server/realtime/bus.ts) so they can react (rotate
 * + redistribute on a removal, or share the live session with a new member). */
export async function getGroupMemberActiveDeviceIds(groupId: string): Promise<string[]> {
  const members = await prisma.groupMember.findMany({ where: { groupId, removedAt: null }, select: { userId: true } });
  const devices = await prisma.device.findMany({
    where: { userId: { in: members.map((m) => m.userId) }, status: 'active' },
    select: { id: true },
  });
  return devices.map((d) => d.id);
}

/** Re-derives the caller's live `GroupMember` row from the database — never trusts a
 * client-claimed role, same posture as `requireAdmin` in server/common/auth.ts. */
async function requireGroupAdmin(groupId: string, callerUserId: string): Promise<void> {
  const membership = await prisma.groupMember.findUnique({ where: { groupId_userId: { groupId, userId: callerUserId } } });
  if (!membership || membership.removedAt || membership.role !== 'admin') {
    throw new AppError('FORBIDDEN', 'Only group admins can do that.');
  }
}

export async function updateGroup(
  groupId: string,
  callerUserId: string,
  changes: { name?: string; description?: string | null; onlyAdminsCanMessage?: boolean },
): Promise<GroupSummary> {
  await requireGroupAdmin(groupId, callerUserId);
  await prisma.group.update({
    where: { id: groupId },
    data: {
      ...(changes.name !== undefined ? { name: changes.name } : {}),
      ...(changes.description !== undefined ? { description: changes.description } : {}),
      ...(changes.onlyAdminsCanMessage !== undefined ? { onlyAdminsCanMessage: changes.onlyAdminsCanMessage } : {}),
    },
  });
  return toGroupSummary(groupId, callerUserId);
}

/**
 * Adding a member does NOT bump the epoch — per docs/05-crypto-architecture.md's
 * group-encryption design, a new member gets the CURRENT session going forward only
 * (no retroactive history access), which existing members' clients handle by
 * reacting to the `group.members-changed` event this publishes (see the WS handler)
 * and key-sharing their live session to the new member — no server-side rotation
 * needed for an addition, only a removal.
 */
export async function addGroupMember(groupId: string, callerUserId: string, username: string): Promise<GroupSummary> {
  const group = await prisma.group.findUnique({ where: { id: groupId }, include: { conversation: true } });
  if (!group) throw new AppError('NOT_FOUND', 'Group not found.');
  await requireConversationMembership(callerUserId, group.conversation!.id);

  const target = await prisma.user.findUnique({ where: { username: username.toLowerCase() } });
  if (!target || target.status !== 'active') {
    throw new AppError('NOT_FOUND', 'User not found.');
  }

  const existing = await prisma.groupMember.findUnique({ where: { groupId_userId: { groupId, userId: target.id } } });
  if (existing && !existing.removedAt) {
    throw new AppError('CONFLICT', 'That user is already in the group.');
  }

  await prisma.$transaction(async (tx) => {
    if (existing) {
      // Re-joining after a previous removal — reactivate rather than a second row
      // (the compound PK forbids a duplicate anyway), fresh joinedAt.
      await tx.groupMember.update({
        where: { groupId_userId: { groupId, userId: target.id } },
        data: { removedAt: null, role: 'member', joinedAt: new Date() },
      });
    } else {
      await tx.groupMember.create({ data: { groupId, userId: target.id, role: 'member' } });
    }
    await tx.conversationMember.upsert({
      where: { conversationId_userId: { conversationId: group.conversation!.id, userId: target.id } },
      create: { conversationId: group.conversation!.id, userId: target.id },
      update: {},
    });
  });

  return toGroupSummary(groupId, callerUserId);
}

/**
 * Removal DOES bump the epoch — the removed member's `ConversationMember` row is
 * deleted outright (they immediately lose message/read/typing access via the
 * existing `requireConversationMembership` gate, no separate check needed anywhere
 * else), while their `GroupMember` row is kept with `removedAt` set (bookkeeping —
 * docs/02-database-schema.md's note on why). The actual key rotation
 * (new outbound session, redistributed to only the current member set) is entirely
 * client-driven, triggered by the `group.members-changed` event this publishes.
 */
export async function removeGroupMember(groupId: string, callerUserId: string, targetUserId: string): Promise<GroupSummary> {
  await requireGroupAdmin(groupId, callerUserId);
  const group = await prisma.group.findUniqueOrThrow({ where: { id: groupId }, include: { conversation: true } });

  const membership = await prisma.groupMember.findUnique({ where: { groupId_userId: { groupId, userId: targetUserId } } });
  if (!membership || membership.removedAt) {
    throw new AppError('NOT_FOUND', 'That user is not in the group.');
  }
  if (targetUserId === callerUserId) {
    throw new AppError('VALIDATION_FAILED', 'Use a dedicated "leave group" action instead.');
  }

  const latestSession = await prisma.groupSession.findFirst({ where: { groupId }, orderBy: { epoch: 'desc' } });
  const nextEpoch = (latestSession?.epoch ?? -1) + 1;

  await prisma.$transaction(async (tx) => {
    await tx.groupMember.update({ where: { groupId_userId: { groupId, userId: targetUserId } }, data: { removedAt: new Date() } });
    await tx.conversationMember
      .delete({ where: { conversationId_userId: { conversationId: group.conversation!.id, userId: targetUserId } } })
      .catch(() => undefined); // already gone is fine, not an error
    if (latestSession) {
      await tx.groupSession.update({ where: { id: latestSession.id }, data: { supersededAt: new Date() } });
    }
    await tx.groupSession.create({ data: { groupId, epoch: nextEpoch } });
  });

  return toGroupSummary(groupId, callerUserId);
}
