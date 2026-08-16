import { z } from 'zod';

// Case-insensitive at the DB layer (citext, see docs/02-database-schema.md) — validated
// lowercase-normalized here so the app and the DB agree on identity without relying on
// DB collation alone.
export const Username = z
  .string()
  .trim()
  .toLowerCase()
  .min(3, 'Username must be at least 3 characters.')
  .max(32, 'Username must be at most 32 characters.')
  .regex(/^[a-z0-9_]+$/, 'Username may only contain lowercase letters, numbers, and underscores.');

export const DisplayName = z.string().trim().min(1).max(64);
export const About = z.string().trim().max(160).optional();

export const UserStatus = z.enum(['pending_invite', 'active', 'suspended', 'deleted']);
export type UserStatus = z.infer<typeof UserStatus>;

export const VisibilityLevel = z.enum(['everyone', 'contacts', 'nobody']);
export type VisibilityLevel = z.infer<typeof VisibilityLevel>;

export const UserProfile = z.object({
  id: z.string().uuid(),
  username: Username,
  displayName: DisplayName,
  about: About,
  avatarObjectKey: z.string().nullable(),
  status: UserStatus,
  createdAt: z.string().datetime(),
});
export type UserProfile = z.infer<typeof UserProfile>;

export const UpdateProfileRequest = z.object({
  displayName: DisplayName.optional(),
  about: About,
});
export type UpdateProfileRequest = z.infer<typeof UpdateProfileRequest>;

export const PrivacySettings = z.object({
  lastSeen: VisibilityLevel.default('contacts'),
  onlineStatus: z.enum(['everyone', 'same_as_last_seen']).default('same_as_last_seen'),
  profilePhoto: VisibilityLevel.default('contacts'),
  about: VisibilityLevel.default('contacts'),
  readReceipts: z.boolean().default(true),
  typingIndicators: z.boolean().default(true),
  calls: VisibilityLevel.default('contacts'),
  groupsAddMe: z.enum(['everyone', 'contacts']).default('contacts'),
});
export type PrivacySettings = z.infer<typeof PrivacySettings>;
