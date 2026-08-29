import { prisma } from '@comm/database';
import { generateSecureToken, hashToken } from '@comm/security';
import { AppError, type ProvisionUserRequest, type ProvisionUserResponse } from '@comm/types';
import { recordSecurityEvent } from '../../common/security-events';
import { tombstoneMessages } from '../messages/service';
import { removeUserFromAllGroups } from '../groups/service';

/**
 * The only way an account comes into existence — see docs/07-auth-architecture.md.
 * Deliberately takes no password: the admin sets identity (username/display name)
 * only, so the admin/server never possesses the credential the invitee will choose.
 */
export async function provisionUser(
  adminUserId: string,
  input: ProvisionUserRequest,
): Promise<ProvisionUserResponse> {
  const admin = await prisma.admin.findUniqueOrThrow({ where: { userId: adminUserId } });

  const existing = await prisma.user.findUnique({ where: { username: input.username } });
  if (existing) {
    throw new AppError('CONFLICT', 'That username is already taken.');
  }

  const rawToken = generateSecureToken(32);
  const expiresAt = new Date(Date.now() + input.inviteTtlHours * 60 * 60 * 1000);

  const { user } = await prisma.$transaction(async (tx) => {
    const user = await tx.user.create({
      data: {
        username: input.username,
        displayName: input.displayName,
        status: 'pending_invite',
        createdByAdminId: admin.id,
      },
    });
    await tx.invite.create({
      data: {
        userId: user.id,
        tokenHash: hashToken(rawToken),
        issuedByAdminId: admin.id,
        expiresAt,
      },
    });
    return { user };
  });

  await recordSecurityEvent({ userId: user.id, eventType: 'account_provisioned', metadata: { admin: 'true' } });

  const webOrigin = process.env.WEB_ORIGIN ?? 'http://localhost:3000';
  return {
    userId: user.id,
    username: user.username,
    inviteUrl: `${webOrigin}/invite/${rawToken}`,
    expiresAt: expiresAt.toISOString(),
  };
}

/**
 * Reuses the invite mechanism for admin-mediated account recovery — see
 * docs/07-auth-architecture.md's "Account recovery" section. Distinct from message/key
 * recovery: this regains login access only, and does not (cannot) restore any
 * device's private keys.
 */
export async function issueRecoveryInvite(
  adminUserId: string,
  targetUserId: string,
  ttlHours = 72,
): Promise<ProvisionUserResponse> {
  const admin = await prisma.admin.findUniqueOrThrow({ where: { userId: adminUserId } });
  const user = await prisma.user.findUnique({ where: { id: targetUserId } });
  if (!user) {
    throw new AppError('NOT_FOUND', 'User not found.');
  }

  const rawToken = generateSecureToken(32);
  const expiresAt = new Date(Date.now() + ttlHours * 60 * 60 * 1000);

  // Invalidate any still-pending invite for this user before issuing a new one — the
  // partial unique index (docs/02-database-schema.md) also enforces this at the DB
  // level; this keeps the app-level error message friendlier than a raw constraint
  // violation.
  await prisma.invite.updateMany({
    where: { userId: user.id, redeemedAt: null },
    data: { redeemedAt: new Date() },
  });

  await prisma.invite.create({
    data: { userId: user.id, tokenHash: hashToken(rawToken), issuedByAdminId: admin.id, expiresAt },
  });

  const webOrigin = process.env.WEB_ORIGIN ?? 'http://localhost:3000';
  return {
    userId: user.id,
    username: user.username,
    inviteUrl: `${webOrigin}/invite/${rawToken}`,
    expiresAt: expiresAt.toISOString(),
  };
}

export async function suspendUser(adminUserId: string, targetUserId: string, reason: string): Promise<void> {
  const user = await prisma.user.findUnique({ where: { id: targetUserId } });
  if (!user) {
    throw new AppError('NOT_FOUND', 'User not found.');
  }

  await prisma.$transaction([
    prisma.user.update({ where: { id: targetUserId }, data: { status: 'suspended' } }),
    prisma.session.updateMany({ where: { userId: targetUserId, revokedAt: null }, data: { revokedAt: new Date() } }),
  ]);

  await recordSecurityEvent({
    userId: targetUserId,
    eventType: 'account_suspended',
    metadata: { reason, byAdmin: adminUserId },
  });
}

/** Non-throwing check used for UI decisions (e.g. whether to show an Admin nav link)
 * — never used for the actual authorization decision on an admin route, which always
 * goes through `requireAdmin` instead (docs/35-authorization.md: a UI convenience is
 * not a security boundary). */
export async function isAdmin(userId: string): Promise<boolean> {
  const admin = await prisma.admin.findUnique({ where: { userId } });
  return admin !== null;
}

export async function listProvisionedUsers(): Promise<
  Array<{ id: string; username: string; displayName: string; status: string; createdAt: string }>
> {
  const users = await prisma.user.findMany({
    orderBy: { createdAt: 'desc' },
    take: 200,
  });
  return users.map((u) => ({
    id: u.id,
    username: u.username,
    displayName: u.displayName,
    status: u.status,
    createdAt: u.createdAt.toISOString(),
  }));
}

/**
 * Admin-initiated account deletion — deliberately more thorough than
 * `deleteOwnAccount` (auth/service.ts): that self-service path stays a
 * profile-only soft-delete on purpose, explicitly to avoid silently erasing the
 * OTHER participant's own message history (see its own docstring). This one is
 * asked for directly to do the opposite — "delete all his chats from
 * everywhere" — because deleting *someone else's* account is far more often a
 * moderation/abuse action than a person choosing to leave, and the whole point
 * is to remove that account's footprint, not preserve it for people they talked to.
 *
 * Scope, disclosed rather than left to guess at:
 * - Every DIRECT conversation this account was part of is deleted outright
 *   (`Conversation` row and all — every relation to `Message`/`ConversationMember`
 *   is `onDelete: Cascade`, so this alone also removes every message, per-device
 *   recipient row, and every participant's history-sync copy in one statement).
 *   A direct conversation is inherently just the two of them; once one side is
 *   gone there's no "other side" left with an independent reason to keep it.
 * - Every GROUP this account belongs to keeps existing for its other members —
 *   only this account's OWN membership is removed (`removeUserFromAllGroups`)
 *   and only this account's OWN messages within those groups are tombstoned
 *   (`account_deleted` reason). Other members' own messages/history are
 *   untouched — a group is shared data other real accounts still legitimately
 *   depend on, not "this account's chat" the way a DM is.
 * - This account's own remaining `MessageHistoryEntry` rows (its personal
 *   decrypted-copy cache for messages OTHERS sent in groups it belonged to) are
 *   cleared too, even though the underlying messages themselves are untouched.
 *
 * The account row itself gets the same soft-delete treatment `deleteOwnAccount`
 * uses (status/PII scrub, sessions+devices revoked) — no separate hard User
 * delete, for the identical `username`-permanently-reserved reason that
 * function's own docstring gives.
 */
export async function adminDeleteUser(adminUserId: string, targetUserId: string): Promise<void> {
  // Re-verified here, not just trusted from the route's own `requireAdmin` — same
  // defense-in-depth `provisionUser` above already applies, worth the extra query
  // given how destructive this specific action is.
  const callerIsAdmin = await prisma.admin.findUnique({ where: { userId: adminUserId } });
  if (!callerIsAdmin) {
    throw new AppError('FORBIDDEN', 'Not authorized.');
  }
  if (targetUserId === adminUserId) {
    throw new AppError('VALIDATION_FAILED', 'Use account settings to delete your own account instead.');
  }
  const user = await prisma.user.findUnique({ where: { id: targetUserId } });
  if (!user) {
    throw new AppError('NOT_FOUND', 'User not found.');
  }
  const targetIsAdmin = await prisma.admin.findUnique({ where: { userId: targetUserId } });
  if (targetIsAdmin) {
    throw new AppError('VALIDATION_FAILED', 'Remove admin access from this account before deleting it.');
  }

  // Direct conversations: delete outright, cascades everything (see docstring).
  const directMemberships = await prisma.conversationMember.findMany({
    where: { userId: targetUserId, conversation: { type: 'direct' } },
    select: { conversationId: true },
  });
  for (const { conversationId } of directMemberships) {
    await prisma.conversation.delete({ where: { id: conversationId } }).catch(() => undefined);
  }

  // Groups: leave every one, tombstoning only this account's own messages in each.
  const ownGroupMessages = await prisma.message.findMany({
    where: { senderUserId: targetUserId, conversation: { type: 'group' } },
    select: { id: true },
  });
  await tombstoneMessages(
    prisma,
    ownGroupMessages.map((m) => m.id),
    'account_deleted',
  );
  await removeUserFromAllGroups(targetUserId);

  // Whatever's left of this account's own history-sync cache (messages OTHER
  // members sent in a group it belonged to — those messages themselves are
  // untouched, only this account's personal copy of them is cleared).
  await prisma.messageHistoryEntry.deleteMany({ where: { userId: targetUserId } });

  await prisma.$transaction([
    prisma.user.update({
      where: { id: targetUserId },
      data: {
        status: 'deleted',
        passwordHash: null,
        mustChangePassword: false,
        displayName: 'Deleted account',
        about: null,
        avatarObjectKey: null,
      },
    }),
    prisma.session.updateMany({ where: { userId: targetUserId, revokedAt: null }, data: { revokedAt: new Date() } }),
    prisma.device.updateMany({
      where: { userId: targetUserId, status: 'active' },
      data: { status: 'revoked', revokedAt: new Date(), revokedReason: 'admin' },
    }),
  ]);

  await recordSecurityEvent({
    userId: targetUserId,
    eventType: 'account_deleted',
    metadata: { byAdmin: adminUserId },
  });
}
