import { z } from 'zod';
import { Username } from './users';
import { NewDeviceRegistration } from './devices';

/**
 * Password is the sole baseline auth factor in this deployment (no forced passkey/MFA
 * — see docs/07-auth-architecture.md), so the length floor is set higher than the
 * NIST 800-63B minimum of 8. Composition rules (must contain a symbol, etc.) are
 * deliberately NOT enforced — NIST 800-63B and current guidance treat those as
 * training users toward predictable patterns rather than real strength; length is the
 * dominant factor for an Argon2id-hashed, rate-limited credential. A breached-password
 * check (e.g. k-anonymity against a HIBP-style list) is a good future hardening step,
 * not implemented in Phase 2 — tracked in docs/14-risk-register.md.
 */
export const Password = z
  .string()
  .min(12, 'Password must be at least 12 characters.')
  .max(256, 'Password is too long.');

export const InviteToken = z.string().min(16).max(512);

export const InviteRedeemRequest = z.object({
  token: InviteToken,
  password: Password,
  device: NewDeviceRegistration,
});
export type InviteRedeemRequest = z.infer<typeof InviteRedeemRequest>;

export const InviteInfoResponse = z.object({
  username: Username,
  displayName: z.string(),
  expiresAt: z.string().datetime(),
});
export type InviteInfoResponse = z.infer<typeof InviteInfoResponse>;

export const LoginRequest = z.object({
  username: Username,
  password: Password,
  // Present only when this device isn't already registered on the account.
  newDevice: NewDeviceRegistration.optional(),
  // Required when the server responds DEVICE_UNKNOWN on a first attempt without it —
  // see docs/07-auth-architecture.md's login flow.
  deviceId: z.string().uuid().optional(),
});
export type LoginRequest = z.infer<typeof LoginRequest>;

export const AuthSessionResponse = z.object({
  userId: z.string().uuid(),
  deviceId: z.string().uuid(),
  username: Username,
  displayName: z.string(),
  // When true, the client routes to /change-password before anything else — see
  // docs/07-auth-architecture.md. The real enforcement is server-side
  // (apps/web/app/(app)/layout.tsx re-checks this on every request); this field is
  // only what lets the client redirect immediately instead of bouncing once.
  mustChangePassword: z.boolean(),
});
export type AuthSessionResponse = z.infer<typeof AuthSessionResponse>;

/**
 * `POST /api/auth/login`'s actual response shape (docs/07-auth-architecture.md's
 * device-approval section) — a brand-new device no longer always completes
 * immediately: if the account already has another active device to approve
 * against, login instead returns `pending_approval` with nothing usable yet (no
 * cookies are set for that branch). The client then polls
 * `GET /api/auth/login/pending/:id` (`PendingLoginPollResponse` below), which
 * itself returns `ok` + sets the session cookies the instant it observes the
 * request was approved — completion happens on the WAITING device's own request,
 * never smuggled in from the approving device's response, so Set-Cookie always
 * lands on the same origin/request that will actually use it.
 */
export const LoginResponse = z.discriminatedUnion('status', [
  AuthSessionResponse.extend({ status: z.literal('ok') }),
  z.object({
    status: z.literal('pending_approval'),
    pendingLoginId: z.string().uuid(),
    expiresAt: z.string().datetime(),
  }),
]);
export type LoginResponse = z.infer<typeof LoginResponse>;

export const PendingLoginPollResponse = z.discriminatedUnion('status', [
  AuthSessionResponse.extend({ status: z.literal('ok') }),
  z.object({ status: z.literal('pending') }),
  z.object({ status: z.literal('denied') }),
  // Also returned once `expiresAt` has passed — no separate `expired` status
  // needed since the client's next move is identical (start over): re-run
  // createLocalIdentity/login from scratch, since the pending row was single-use
  // material for one specific submission.
]);
export type PendingLoginPollResponse = z.infer<typeof PendingLoginPollResponse>;

export const ChangePasswordRequest = z.object({
  currentPassword: Password,
  newPassword: Password,
});
export type ChangePasswordRequest = z.infer<typeof ChangePasswordRequest>;

// Apple App Store Review Guideline 5.1.1(v) requires an in-app path to delete an
// account, not just a support-ticket/website flow — this is that path's request
// shape. Re-verifying the current password (rather than trusting the session alone)
// mirrors ChangePasswordRequest above: an irreversible action gets the same
// re-authentication bar as a security-sensitive one, not just "already logged in."
export const DeleteAccountRequest = z.object({
  password: Password,
});
export type DeleteAccountRequest = z.infer<typeof DeleteAccountRequest>;
