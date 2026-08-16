import { z } from 'zod';
import { Username, DisplayName } from './users';

/**
 * Admin provisioning input never includes a password — see docs/07-auth-architecture.md:
 * the admin sets identity, the invitee sets their own credential during redemption, so
 * the admin/server never possesses it.
 */
export const ProvisionUserRequest = z.object({
  username: Username,
  displayName: DisplayName,
  inviteTtlHours: z.number().int().min(1).max(24 * 14).default(72),
});
export type ProvisionUserRequest = z.infer<typeof ProvisionUserRequest>;

export const ProvisionUserResponse = z.object({
  userId: z.string().uuid(),
  username: Username,
  inviteUrl: z.string(),
  expiresAt: z.string().datetime(),
});
export type ProvisionUserResponse = z.infer<typeof ProvisionUserResponse>;

export const SuspendUserRequest = z.object({
  reason: z.string().trim().min(1).max(500),
});
export type SuspendUserRequest = z.infer<typeof SuspendUserRequest>;
