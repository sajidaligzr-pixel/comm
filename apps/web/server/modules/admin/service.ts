import { prisma } from '@comm/database';
import { generateSecureToken, hashToken } from '@comm/security';
import { AppError, type ProvisionUserRequest, type ProvisionUserResponse } from '@comm/types';
import { recordSecurityEvent } from '../../common/security-events';

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
