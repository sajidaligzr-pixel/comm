import { z } from 'zod';

/**
 * Blocked users (docs/02-database-schema.md's original sketch, docs/13-roadmap.md's
 * blocked-users pass). Enforced server-side on every message/call path
 * (createOrGetDirectConversation, sendMessage, the call.* signaling handlers) —
 * see docs/08-threat-model.md for why this must never be a client-only hide.
 * Deliberately scoped to direct conversations only this pass; blocking inside a
 * group is a separate, harder problem (server/modules/blocking/service.ts's own
 * note on why) left for later, same as WhatsApp's own scoping.
 */
export const BlockUserRequest = z.object({
  username: z.string(),
});
export type BlockUserRequest = z.infer<typeof BlockUserRequest>;

export const BlockedUserDto = z.object({
  userId: z.string().uuid(),
  username: z.string(),
  displayName: z.string(),
  blockedAt: z.string().datetime(),
});
export type BlockedUserDto = z.infer<typeof BlockedUserDto>;
