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

export const ChangePasswordRequest = z.object({
  currentPassword: Password,
  newPassword: Password,
});
export type ChangePasswordRequest = z.infer<typeof ChangePasswordRequest>;
