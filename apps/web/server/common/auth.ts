import type { NextRequest } from 'next/server';
import { prisma } from '@comm/database';
import { AppError } from '@comm/types';
import { verifyAccessToken } from './jwt';
import { ACCESS_TOKEN_COOKIE, CSRF_COOKIE, CSRF_HEADER } from './cookies';
import { constantTimeEqual } from '@comm/security';

export interface AuthContext {
  userId: string;
  deviceId: string;
  sessionId: string;
}

/**
 * The DB-checking core shared by both the HTTP path (`requireAuth` below, called with
 * a cookie read from a `NextRequest`) and the raw WebSocket upgrade path
 * (`server/realtime/ws-server.ts`, which has no `NextRequest` to work with — just raw
 * headers). Deliberately re-checks the session/device against Postgres on every call
 * rather than trusting the JWT's signature+expiry alone: a still-valid, unexpired
 * token says nothing about whether the session was revoked or the device was revoked
 * a second ago (docs/06-device-architecture.md's "revocation takes effect
 * immediately" claim depends on this DB check existing, not on short token TTLs
 * alone). The extra round-trip is an accepted cost — see docs/14-risk-register.md if
 * this needs a Redis-cached revocation-list optimization once it's measured as a real
 * bottleneck; not optimized preemptively.
 */
export async function authenticateAccessToken(token: string | undefined): Promise<AuthContext> {
  if (!token) {
    throw new AppError('AUTH_INVALID', 'You must be signed in to do that.');
  }

  const verified = await verifyAccessToken(token);
  if (!verified.valid) {
    throw new AppError(verified.reason === 'expired' ? 'AUTH_EXPIRED' : 'AUTH_INVALID', 'Your session has expired. Please sign in again.');
  }

  const { sub: userId, deviceId, sessionId } = verified.claims;

  const session = await prisma.session.findUnique({
    where: { id: sessionId },
    include: { device: true },
  });

  if (!session || session.revokedAt || session.expiresAt.getTime() < Date.now()) {
    throw new AppError('AUTH_EXPIRED', 'Your session has expired. Please sign in again.');
  }
  if (session.userId !== userId || session.deviceId !== deviceId) {
    // The token's claims disagree with the session row they point at — treat as
    // invalid rather than trusting either side individually.
    throw new AppError('AUTH_INVALID', 'Your session is no longer valid. Please sign in again.');
  }
  if (session.device.status === 'revoked') {
    throw new AppError('DEVICE_REVOKED', 'This device has been signed out.');
  }

  // Coarse presence signal only (docs/06-device-architecture.md's "Last active: 2
  // minutes ago"), throttled to avoid a write on every single request.
  const staleForMs = Date.now() - session.device.lastActiveAt.getTime();
  if (staleForMs > 60_000) {
    await prisma.device.update({ where: { id: deviceId }, data: { lastActiveAt: new Date() } });
  }

  return { userId, deviceId, sessionId };
}

/** HTTP-path wrapper — see docs/03-api-design.md's "starts its handler with
 * requireAuth(req)". */
export async function requireAuth(req: NextRequest): Promise<AuthContext> {
  return authenticateAccessToken(req.cookies.get(ACCESS_TOKEN_COOKIE)?.value);
}

/**
 * Authorization, not authentication — confirms the already-authenticated caller
 * holds the `admins` role, re-derived from the database every call (never from a
 * client-asserted role, per docs/35-authorization.md's explicit "never trust
 * role=admin sent from the browser" rule).
 */
export async function requireAdmin(ctx: AuthContext): Promise<{ adminId: string; role: 'superadmin' | 'support' }> {
  const admin = await prisma.admin.findUnique({ where: { userId: ctx.userId } });
  if (!admin) {
    throw new AppError('FORBIDDEN', 'You do not have permission to do that.');
  }
  return { adminId: admin.id, role: admin.role };
}

/**
 * Authorization for the live-location-sharing feature (docs/09-trust-boundaries.md's
 * "Live location sharing" exception) — passes for any `Admin` (every admin can see
 * everyone's live location by construction) OR any user holding an additive
 * `LocationViewer` grant, re-derived from the database every call, same posture as
 * `requireAdmin` above. Deliberately its own check rather than reusing `requireAdmin`
 * directly: a granted viewer should see the map without gaining any of `Admin`'s other
 * (account-provisioning) powers.
 */
export async function requireLocationAccess(ctx: AuthContext): Promise<void> {
  const [admin, viewer] = await Promise.all([
    prisma.admin.findUnique({ where: { userId: ctx.userId } }),
    prisma.locationViewer.findUnique({ where: { userId: ctx.userId } }),
  ]);
  if (!admin && !viewer) {
    throw new AppError('FORBIDDEN', 'You do not have permission to do that.');
  }
}

/**
 * Double-submit CSRF check for authenticated, state-changing requests. Cookies alone
 * don't protect against CSRF (a cross-origin form/script can trigger a cookie-bearing
 * request); a cross-origin page cannot read this site's cookie value to also send it
 * as a header, so a mismatch (or missing header) means the request didn't originate
 * from a page that could read our cookies — i.e. not from a legitimate same-origin
 * client. See docs/14-session-security.md.
 */
export function requireCsrf(req: NextRequest): void {
  const cookieToken = req.cookies.get(CSRF_COOKIE)?.value;
  const headerToken = req.headers.get(CSRF_HEADER);
  if (!cookieToken || !headerToken || !constantTimeEqual(cookieToken, headerToken)) {
    throw new AppError('FORBIDDEN', 'Request could not be verified. Please refresh and try again.');
  }
}
