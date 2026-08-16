import { prisma } from '@comm/database';
import { hashPassword, verifyPassword, needsRehash, hashToken } from '@comm/security';
import { AppError, type InviteInfoResponse, type LoginRequest, type NewDeviceRegistration } from '@comm/types';
import { registerDevice } from '../devices/service';
import { recordSecurityEvent } from '../../common/security-events';
import { createSession, type IssuedSession } from './session';

export async function getInviteInfo(rawToken: string): Promise<InviteInfoResponse> {
  const invite = await prisma.invite.findUnique({
    where: { tokenHash: hashToken(rawToken) },
    include: { user: true },
  });

  // Identical error for "no such token" and "expired/redeemed" — distinguishing them
  // would let an attacker learn whether a guessed token ever existed at all.
  if (!invite || invite.redeemedAt || invite.expiresAt.getTime() < Date.now()) {
    throw new AppError('INVITE_INVALID_OR_EXPIRED', 'This invite link is invalid or has expired.');
  }

  return {
    username: invite.user.username,
    displayName: invite.user.displayName,
    expiresAt: invite.expiresAt.toISOString(),
  };
}

export interface RedeemInviteInput {
  token: string;
  password: string;
  device: NewDeviceRegistration;
}

/**
 * The one place an account moves from `pending_invite` to `active` — see
 * docs/07-auth-architecture.md's provisioning flow diagram. Everything commits in a
 * single transaction: an invite that's redeemed but whose device-registration failed
 * halfway must not leave the account active with no usable device.
 */
export async function redeemInvite(
  input: RedeemInviteInput,
  ipHash: string | null,
  userAgent: string | null,
): Promise<{
  userId: string;
  deviceId: string;
  username: string;
  displayName: string;
  mustChangePassword: boolean;
  session: IssuedSession;
}> {
  const tokenHash = hashToken(input.token);

  const invite = await prisma.invite.findUnique({ where: { tokenHash }, include: { user: true } });
  if (!invite || invite.redeemedAt || invite.expiresAt.getTime() < Date.now()) {
    throw new AppError('INVITE_INVALID_OR_EXPIRED', 'This invite link is invalid or has expired.');
  }
  if (invite.user.status !== 'pending_invite') {
    // Defensive — should be unreachable given the invariants above, but an account
    // that's already active must never be silently re-activated/re-passworded via a
    // stale invite link.
    throw new AppError('INVITE_INVALID_OR_EXPIRED', 'This invite link is invalid or has expired.');
  }

  const passwordHash = await hashPassword(input.password);

  const { deviceId, session } = await prisma.$transaction(async (tx) => {
    const redeemResult = await tx.invite.updateMany({
      where: { id: invite.id, redeemedAt: null },
      data: { redeemedAt: new Date() },
    });
    if (redeemResult.count === 0) {
      // Lost a race with a concurrent redemption of the same invite.
      throw new AppError('INVITE_INVALID_OR_EXPIRED', 'This invite link has already been used.');
    }

    await tx.user.update({
      where: { id: invite.userId },
      data: { passwordHash, status: 'active' },
    });

    // Sane, privacy-preserving defaults (docs/02-database-schema.md) — created here
    // rather than left absent, so every route that reads them can assume they exist.
    await tx.userPrivacySetting.create({ data: { userId: invite.userId } });
    await tx.notificationPreference.create({ data: { userId: invite.userId } });

    const { deviceId } = await registerDevice(tx, invite.userId, input.device);
    const session = await createSession(invite.userId, deviceId, ipHash, userAgent, tx);

    return { deviceId, session };
  });

  await recordSecurityEvent({ userId: invite.userId, eventType: 'account_provisioned', deviceId, ipHash });
  await recordSecurityEvent({ userId: invite.userId, eventType: 'login_success', deviceId, ipHash });

  return {
    userId: invite.userId,
    deviceId,
    username: invite.user.username,
    displayName: invite.user.displayName,
    // Always false here — invite redemption is exactly the case where the user just
    // chose their own password, so there's nothing to force a change on.
    mustChangePassword: false,
    session,
  };
}

export interface LoginResult {
  userId: string;
  deviceId: string;
  username: string;
  displayName: string;
  mustChangePassword: boolean;
  session: IssuedSession;
}

/**
 * See docs/07-auth-architecture.md's login flow and brute-force section. Rate
 * limiting happens at the route layer (docs/03-api-design.md); this function focuses
 * on the credential/device logic and always takes a comparable amount of time on the
 * "user not found" vs "wrong password" paths (verifies against a fixed dummy hash in
 * the former case) so a timing side channel doesn't reveal account existence ahead of
 * the rate limiter doing its job either way.
 */
export async function login(
  input: LoginRequest,
  ipHash: string | null,
  userAgent: string | null,
): Promise<LoginResult> {
  const user = await prisma.user.findUnique({ where: { username: input.username } });

  const DUMMY_HASH =
    '$argon2id$v=19$m=65536,t=3,p=1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
  const passwordOk = await verifyPassword(input.password, user?.passwordHash ?? DUMMY_HASH);

  if (!user || user.status !== 'active' || !user.passwordHash || !passwordOk) {
    if (user) {
      await recordSecurityEvent({ userId: user.id, eventType: 'login_failed', ipHash });
    }
    throw new AppError('AUTH_INVALID', 'Invalid username or password.');
  }

  if (needsRehash(user.passwordHash)) {
    const rehashed = await hashPassword(input.password);
    await prisma.user.update({ where: { id: user.id }, data: { passwordHash: rehashed } });
  }

  let deviceId: string;
  let isNewDevice = false;

  if (input.deviceId) {
    const device = await prisma.device.findUnique({ where: { id: input.deviceId } });
    if (!device || device.userId !== user.id || device.status !== 'active') {
      throw new AppError('DEVICE_REVOKED', 'This device is not recognized. Please link it again.');
    }
    deviceId = device.id;
  } else if (input.newDevice) {
    const created = await registerDevice(prisma, user.id, input.newDevice);
    deviceId = created.deviceId;
    isNewDevice = true;
  } else {
    throw new AppError('VALIDATION_FAILED', 'Missing device information for this login.');
  }

  const session = await createSession(user.id, deviceId, ipHash, userAgent);

  await recordSecurityEvent({
    userId: user.id,
    eventType: isNewDevice ? 'new_device_linked' : 'login_success',
    deviceId,
    ipHash,
  });
  if (isNewDevice) {
    await recordSecurityEvent({ userId: user.id, eventType: 'login_success', deviceId, ipHash });
  }

  return {
    userId: user.id,
    deviceId,
    username: user.username,
    displayName: user.displayName,
    mustChangePassword: user.mustChangePassword,
    session,
  };
}

/**
 * Requires the CURRENT password even though the caller is already authenticated —
 * changing a credential is exactly the kind of state-changing action that shouldn't
 * be doable by session possession alone (a hijacked-but-still-valid session
 * shouldn't be able to lock the real owner out by rotating the password). Clears
 * `mustChangePassword` and, deliberately, revokes every OTHER session on the account
 * — a password change is a strong signal to invalidate anything that might be a
 * stolen session elsewhere, matching docs/07-auth-architecture.md's session-rotation
 * intent; the session making this request stays valid so the user isn't logged out
 * by their own action.
 */
export async function changePassword(
  userId: string,
  currentSessionId: string,
  currentPassword: string,
  newPassword: string,
): Promise<void> {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });


  const currentOk = await verifyPassword(currentPassword, user.passwordHash ?? '');
  if (!currentOk) {
    throw new AppError('AUTH_INVALID', 'Current password is incorrect.');
  }

  const newHash = await hashPassword(newPassword);

  await prisma.$transaction([
    prisma.user.update({
      where: { id: userId },
      data: { passwordHash: newHash, mustChangePassword: false },
    }),
    prisma.session.updateMany({
      where: { userId, id: { not: currentSessionId }, revokedAt: null },
      data: { revokedAt: new Date() },
    }),
  ]);

  await recordSecurityEvent({ userId, eventType: 'password_changed' });
}

/**
 * Used only by the `(app)` layout guard to decide whether to redirect to
 * /change-password — deliberately NOT folded into `getAuthContextOrRedirect` itself,
 * since that function is also used to protect /change-password, and baking this
 * check in there would redirect that very page into a loop.
 */
export async function getMustChangePassword(userId: string): Promise<boolean> {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  return user.mustChangePassword;
}
