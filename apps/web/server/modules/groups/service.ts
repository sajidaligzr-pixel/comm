import { randomUUID } from 'node:crypto';
import { prisma } from '@comm/database';
import {
  AppError,
  type GroupSummary,
  type GroupMemberDto,
  type GroupRole,
  type CreateUploadUrlResponse,
  type GroupInviteLinkDto,
  type GroupInvitePeekDto,
} from '@comm/types';
import { generateSecureToken } from '@comm/security';
import { getObjectStorage } from '@comm/storage';
import { requireConversationMembership, getGroupMemberPrimaryDevices } from '../conversations/service';

const AVATAR_MAX_BYTES = 5 * 1024 * 1024; // 5 MiB — a group icon, not a general file attachment

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

  // Minted fresh per-request, same as message-attachment downloads — see
  // GroupSummary.avatarUrl's own docstring for why this isn't just the raw
  // objectKey handed to the client.
  const avatarUrl = group.avatarObjectKey ? await getObjectStorage().createDownloadUrl(group.avatarObjectKey) : null;

  return {
    id: group.id,
    conversationId: group.conversation!.id,
    name: group.name,
    description: group.description,
    onlyAdminsCanMessage: group.onlyAdminsCanMessage,
    avatarUrl,
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
 * conversations module's `getGroupMemberPrimaryDevices` (still one device per
 * *member*, a separate, smaller, still-open gap from the one 1:1 messages already
 * closed — see that function's own docstring) after resolving `groupId` to its
 * `conversationId`.
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
 * Promote to admin or demote to member — no crypto/epoch implications either way
 * (unlike removal), since `role` only gates server-side authorization checks
 * (`requireGroupAdmin`, `updateGroup`, etc.), never anything the Megolm session
 * cares about. A no-op (not an error) if the target already holds that role.
 * Demoting the group's LAST admin is rejected — this route can never leave a group
 * with zero admins, mirroring `removeGroupMember`'s "use leave group instead" rule
 * for the analogous "don't let the caller strand the group" concern.
 */
export async function setGroupMemberRole(
  groupId: string,
  callerUserId: string,
  targetUserId: string,
  role: GroupRole,
): Promise<GroupSummary> {
  await requireGroupAdmin(groupId, callerUserId);
  const membership = await prisma.groupMember.findUnique({ where: { groupId_userId: { groupId, userId: targetUserId } } });
  if (!membership || membership.removedAt) {
    throw new AppError('NOT_FOUND', 'That user is not in the group.');
  }
  if (membership.role === role) {
    return toGroupSummary(groupId, callerUserId);
  }
  if (role === 'member') {
    const adminCount = await prisma.groupMember.count({ where: { groupId, role: 'admin', removedAt: null } });
    if (adminCount <= 1) {
      throw new AppError('VALIDATION_FAILED', 'A group needs at least one admin — promote someone else first.');
    }
  }
  await prisma.groupMember.update({ where: { groupId_userId: { groupId, userId: targetUserId } }, data: { role } });
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

// ── Group avatar ──────────────────────────────────────────────────────────────
// Deliberately NOT the message-attachment pipeline (media/service.ts) — that one's
// Redis-tracked pending-upload/quota bookkeeping exists to bound per-account
// *message* content under a cap; a group icon is a single small image with no
// analogous per-account growth concern, so it goes straight through
// `getObjectStorage()` instead. Not E2E encrypted, unlike message content — same
// trust model `User.avatarObjectKey` already documents (server-visible, plain
// object storage, gated by membership on read).

export async function createGroupAvatarUploadUrl(groupId: string, callerUserId: string): Promise<CreateUploadUrlResponse> {
  await requireGroupAdmin(groupId, callerUserId);
  const objectKey = randomUUID();
  const target = await getObjectStorage().createUploadTarget(objectKey, AVATAR_MAX_BYTES);
  return { objectKey, target };
}

/** No verification the object actually exists at `objectKey` — same trust level
 * this app already extends to a completed upload elsewhere (nothing server-side
 * probes storage to confirm bytes landed); worst case a bogus key just fails to
 * render for the group, not a cross-account issue. */
export async function confirmGroupAvatar(groupId: string, callerUserId: string, objectKey: string): Promise<GroupSummary> {
  await requireGroupAdmin(groupId, callerUserId);
  await prisma.group.update({ where: { id: groupId }, data: { avatarObjectKey: objectKey } });
  return toGroupSummary(groupId, callerUserId);
}

export async function removeGroupAvatar(groupId: string, callerUserId: string): Promise<GroupSummary> {
  await requireGroupAdmin(groupId, callerUserId);
  await prisma.group.update({ where: { id: groupId }, data: { avatarObjectKey: null } });
  return toGroupSummary(groupId, callerUserId);
}

// ── Group invite links ───────────────────────────────────────────────────────
// See GroupInviteLink's own schema docstring for why the token is stored in
// plaintext rather than hashed like every other token in this schema.

async function activeInviteLink(groupId: string) {
  return prisma.groupInviteLink.findFirst({ where: { groupId, revokedAt: null }, orderBy: { createdAt: 'desc' } });
}

/** Idempotent — returns the existing active link if one exists rather than always
 * minting a new one, so opening "Invite via link" repeatedly doesn't invalidate a
 * link someone already shared. Use `regenerateGroupInviteLink` to force a fresh one. */
export async function getOrCreateGroupInviteLink(groupId: string, callerUserId: string): Promise<GroupInviteLinkDto> {
  await requireGroupAdmin(groupId, callerUserId);
  const existing = await activeInviteLink(groupId);
  if (existing) return { token: existing.token, groupId };

  const created = await prisma.groupInviteLink.create({
    data: { groupId, token: generateSecureToken(24), createdById: callerUserId },
  });
  return { token: created.token, groupId };
}

/** Revokes any current link and mints a new one — the "Reset link" action
 * (WhatsApp's own naming for this exact operation): anyone still holding the old
 * link can no longer use it, without needing to know who they were. */
export async function regenerateGroupInviteLink(groupId: string, callerUserId: string): Promise<GroupInviteLinkDto> {
  await requireGroupAdmin(groupId, callerUserId);
  await prisma.groupInviteLink.updateMany({ where: { groupId, revokedAt: null }, data: { revokedAt: new Date() } });
  const created = await prisma.groupInviteLink.create({
    data: { groupId, token: generateSecureToken(24), createdById: callerUserId },
  });
  return { token: created.token, groupId };
}

export async function revokeGroupInviteLink(groupId: string, callerUserId: string): Promise<void> {
  await requireGroupAdmin(groupId, callerUserId);
  await prisma.groupInviteLink.updateMany({ where: { groupId, revokedAt: null }, data: { revokedAt: new Date() } });
}

/** Before committing to join — mirrors devices/service.ts's `getDeviceLinkInfo`
 * (an identical "resolve what this token points to first" shape for device-linking
 * tokens). Requires auth (unlike account-invite redemption, which IS how you get an
 * account) but not group membership — that's exactly what this is deciding. */
export async function peekGroupInvite(token: string, callerUserId: string): Promise<GroupInvitePeekDto> {
  const link = await prisma.groupInviteLink.findUnique({
    where: { token },
    include: { group: { include: { conversation: true, members: { where: { removedAt: null } } } } },
  });
  if (!link || link.revokedAt) {
    throw new AppError('NOT_FOUND', 'This invite link is invalid or has been reset.');
  }
  const alreadyMember = link.group.members.some((m) => m.userId === callerUserId);
  return {
    groupId: link.group.id,
    groupName: link.group.name,
    memberCount: link.group.members.length,
    alreadyMember,
    conversationId: alreadyMember ? link.group.conversation!.id : null,
  };
}

/** The self-service counterpart to `addGroupMember` — same reactivate-or-create
 * membership logic (a former member re-joining via link gets a fresh `joinedAt`,
 * same as being re-added by an existing member would), same "no epoch bump, current
 * session only, no retroactive history" semantics (see `addGroupMember`'s own
 * docstring). Publishing `group.members-changed` is the caller route's job, exactly
 * like every other group-membership mutation in this file. */
export async function joinGroupViaInviteLink(token: string, callerUserId: string): Promise<GroupSummary> {
  const link = await prisma.groupInviteLink.findUnique({ where: { token }, include: { group: { include: { conversation: true } } } });
  if (!link || link.revokedAt) {
    throw new AppError('NOT_FOUND', 'This invite link is invalid or has been reset.');
  }
  const groupId = link.group.id;
  const conversationId = link.group.conversation!.id;

  const existing = await prisma.groupMember.findUnique({ where: { groupId_userId: { groupId, userId: callerUserId } } });
  if (existing && !existing.removedAt) {
    return toGroupSummary(groupId, callerUserId); // already a member — join is a no-op, not an error
  }

  await prisma.$transaction(async (tx) => {
    if (existing) {
      await tx.groupMember.update({
        where: { groupId_userId: { groupId, userId: callerUserId } },
        data: { removedAt: null, role: 'member', joinedAt: new Date() },
      });
    } else {
      await tx.groupMember.create({ data: { groupId, userId: callerUserId, role: 'member' } });
    }
    await tx.conversationMember.upsert({
      where: { conversationId_userId: { conversationId, userId: callerUserId } },
      create: { conversationId, userId: callerUserId },
      update: {},
    });
  });

  return toGroupSummary(groupId, callerUserId);
}
