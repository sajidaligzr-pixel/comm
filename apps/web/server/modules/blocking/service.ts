import { prisma } from '@comm/database';
import { AppError, type BlockedUserDto } from '@comm/types';

/**
 * Blocked users (docs/02-database-schema.md's original sketch, docs/13-roadmap.md's
 * blocked-users pass). Enforced at three points, per docs/08-threat-model.md's
 * "never just hidden client-side" rule:
 * - `createOrGetDirectConversation` (conversations/service.ts) — refuses to START a
 *   new conversation with someone who's blocked the caller (or whom the caller has
 *   blocked); an already-existing conversation still opens, matching WhatsApp's own
 *   behavior of never hiding chat history, just refusing new sends.
 * - `sendMessage` (messages/service.ts) — refuses a `direct` send in either
 *   direction.
 * - The `call.*` signaling handlers (realtime/message-handlers.ts) — refuses
 *   `call.invite` in either direction.
 *
 * Deliberately NOT enforced inside `group` conversations — group membership is a
 * separate, admin-controlled relationship (you can be added to a group with someone
 * you've blocked, same as WhatsApp), and per-group "hide this member's messages"
 * would need its own client-side filtering story this pass doesn't build.
 */
export async function blockUser(callerUserId: string, targetUsername: string): Promise<void> {
  const target = await prisma.user.findUnique({ where: { username: targetUsername } });
  if (!target || target.status !== 'active') {
    throw new AppError('NOT_FOUND', 'User not found.');
  }
  if (target.id === callerUserId) {
    throw new AppError('VALIDATION_FAILED', 'You cannot block yourself.');
  }
  // Idempotent — blocking an already-blocked user (a retried request, or two of
  // the caller's own devices racing) is a no-op, not an error.
  await prisma.blockedUser.upsert({
    where: { blockerUserId_blockedUserId: { blockerUserId: callerUserId, blockedUserId: target.id } },
    create: { blockerUserId: callerUserId, blockedUserId: target.id },
    update: {},
  });
}

export async function unblockUser(callerUserId: string, blockedUserId: string): Promise<void> {
  await prisma.blockedUser.deleteMany({ where: { blockerUserId: callerUserId, blockedUserId } });
}

export async function listBlockedUsers(callerUserId: string): Promise<BlockedUserDto[]> {
  const rows = await prisma.blockedUser.findMany({
    where: { blockerUserId: callerUserId },
    orderBy: { createdAt: 'desc' },
    include: { blocked: { select: { id: true, username: true, displayName: true } } },
  });
  return rows.map((row) => ({
    userId: row.blocked.id,
    username: row.blocked.username,
    displayName: row.blocked.displayName,
    blockedAt: row.createdAt.toISOString(),
  }));
}

export async function hasBlocked(blockerUserId: string, blockedUserId: string): Promise<boolean> {
  const row = await prisma.blockedUser.findUnique({
    where: { blockerUserId_blockedUserId: { blockerUserId, blockedUserId } },
  });
  return row !== null;
}

/** Symmetric check for the enforcement points above — deliberately doesn't say
 * WHICH direction blocked which (same generic refusal either way), so a caller
 * probing "did they block me, or did I block them" learns nothing from the error
 * shape, matching the IDOR-safe-filtering posture messages/service.ts already
 * documents for its own multi-device fan-out. */
export async function isEitherBlocked(userIdA: string, userIdB: string): Promise<boolean> {
  const row = await prisma.blockedUser.findFirst({
    where: {
      OR: [
        { blockerUserId: userIdA, blockedUserId: userIdB },
        { blockerUserId: userIdB, blockedUserId: userIdA },
      ],
    },
  });
  return row !== null;
}
