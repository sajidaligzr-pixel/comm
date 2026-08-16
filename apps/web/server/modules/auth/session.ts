import { randomUUID } from 'node:crypto';
import { prisma, Prisma } from '@comm/database';
import { generateSecureToken, hashToken } from '@comm/security';
import { AppError } from '@comm/types';
import { signAccessToken } from '../../common/jwt';
import { recordSecurityEvent } from '../../common/security-events';

type Db = Prisma.TransactionClient | typeof prisma;

const REFRESH_TOKEN_TTL_DAYS = Number(process.env.REFRESH_TOKEN_TTL_DAYS ?? 30);

export interface IssuedSession {
  accessToken: string;
  refreshToken: string;
  accessTokenMaxAgeSeconds: number;
  refreshTokenMaxAgeSeconds: number;
}

/**
 * Creates a brand new session (new token family) — used at login/invite-redeem, never
 * at refresh (refresh reuses the existing family so reuse-detection below has
 * something to compare against). See docs/07-auth-architecture.md's
 * "session/token rotation" section.
 */
export async function createSession(
  userId: string,
  deviceId: string,
  ipHash: string | null,
  userAgent: string | null,
  db: Db = prisma,
): Promise<IssuedSession> {
  const accessTokenFamily = randomUUID();
  return issueSessionRow(db, userId, deviceId, accessTokenFamily, ipHash, userAgent);
}

async function issueSessionRow(
  db: Db,
  userId: string,
  deviceId: string,
  accessTokenFamily: string,
  ipHash: string | null,
  userAgent: string | null,
): Promise<IssuedSession> {
  const rawRefreshToken = generateSecureToken(32);
  const expiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000);

  const session = await db.session.create({
    data: {
      userId,
      deviceId,
      refreshTokenHash: hashToken(rawRefreshToken),
      accessTokenFamily,
      expiresAt,
      ipHash,
      userAgent,
    },
  });

  const accessToken = await signAccessToken({ sub: userId, deviceId, sessionId: session.id });

  return {
    accessToken,
    refreshToken: rawRefreshToken,
    accessTokenMaxAgeSeconds: 15 * 60,
    refreshTokenMaxAgeSeconds: REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60,
  };
}

/**
 * Refresh-token rotation with reuse detection (docs/07-auth-architecture.md /
 * docs/12-testing-strategy.md's session-theft test case). Session rows are never
 * deleted on rotation — the old row is kept, marked revoked, and its hash remains in
 * the table so a later attempt to present that *same* raw token again is
 * distinguishable from "just an invalid token": it's found, but already revoked,
 * which is exactly the reuse signal. On detection, every session in the family is
 * revoked — erring toward forcing the legitimate user to log in again over leaving a
 * potentially-stolen token valid.
 */
export async function rotateSession(
  rawRefreshToken: string,
  ipHash: string | null,
  userAgent: string | null,
): Promise<IssuedSession> {
  const tokenHash = hashToken(rawRefreshToken);
  const existing = await prisma.session.findUnique({ where: { refreshTokenHash: tokenHash } });

  if (!existing) {
    throw new AppError('AUTH_INVALID', 'Your session has expired. Please sign in again.');
  }

  if (existing.revokedAt || existing.expiresAt.getTime() < Date.now()) {
    // This exact refresh token was already used (rotated away) or explicitly
    // revoked, and is being presented again — treat the whole family as
    // compromised. Idempotent if the family is already fully revoked.
    await prisma.session.updateMany({
      where: { accessTokenFamily: existing.accessTokenFamily, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    await recordSecurityEvent({
      userId: existing.userId,
      eventType: 'suspicious_login',
      deviceId: existing.deviceId,
      ipHash,
      metadata: { reason: 'refresh_token_reuse' },
    });
    throw new AppError('AUTH_INVALID', 'Your session has expired. Please sign in again.');
  }

  return prisma.$transaction(async (tx) => {
    await tx.session.update({ where: { id: existing.id }, data: { revokedAt: new Date(), lastUsedAt: new Date() } });
    return issueSessionRow(tx, existing.userId, existing.deviceId, existing.accessTokenFamily, ipHash, userAgent);
  });
}

export async function revokeSession(sessionId: string): Promise<void> {
  await prisma.session.update({ where: { id: sessionId }, data: { revokedAt: new Date() } });
}
