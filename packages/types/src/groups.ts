import { z } from 'zod';
import { MessageEnvelopeUpload, X3dhInitPayload } from './messages';

/**
 * `/groups` — docs/13-roadmap.md's group chat pass (real Megolm-style group ratchet,
 * docs/05-crypto-architecture.md#group-encryption), ahead of the original Phase 5
 * slot. Group avatars and invite links landed in a later pass (see `GroupSummary`'s
 * `avatarObjectKey`/`avatarUrl` and `GroupInviteLinkDto` below). Still trimmed vs.
 * the original design doc: no promote/demote UI yet (the `role` field and its
 * enforcement exist; no route changes it after creation).
 */

export const GroupRole = z.enum(['member', 'admin']);
export type GroupRole = z.infer<typeof GroupRole>;

export const GroupMemberDto = z.object({
  userId: z.string().uuid(),
  username: z.string(),
  displayName: z.string(),
  role: GroupRole,
  joinedAt: z.string().datetime(),
});
export type GroupMemberDto = z.infer<typeof GroupMemberDto>;

export const GroupSummary = z.object({
  id: z.string().uuid(),
  conversationId: z.string().uuid(),
  name: z.string(),
  description: z.string().nullable(),
  onlyAdminsCanMessage: z.boolean(),
  /** A freshly-minted signed download URL (server/modules/media, `getObjectStorage()
   * .createDownloadUrl`), not the raw `avatarObjectKey` — minted per-request, same
   * pattern message-attachment downloads already use, rather than handing back a
   * durable object key the client would have to separately resolve. Null when no
   * avatar is set; both clients fall back to initials, same as a user with none. */
  avatarUrl: z.string().nullable(),
  /** The CALLING user's own role — every response is scoped to who's asking, same
   * spirit as `ConversationSummary` never leaking data the caller isn't party to. */
  callerRole: GroupRole,
  members: z.array(GroupMemberDto),
  createdAt: z.string().datetime(),
});
export type GroupSummary = z.infer<typeof GroupSummary>;

/** `POST /api/groups/:id/avatar/upload-url` response — same shape as
 * `CreateUploadUrlResponse` (media.ts) reused directly rather than re-declared,
 * since it's the identical "here's where to PUT the bytes" contract; group avatars
 * just skip that flow's `MessageAttachment`/quota bookkeeping entirely (a single
 * small image per group, not per-message content under a per-account cap). */
export const GroupAvatarConfirmRequest = z.object({ objectKey: z.string() });
export type GroupAvatarConfirmRequest = z.infer<typeof GroupAvatarConfirmRequest>;

/**
 * WhatsApp-style "join via link" (docs/13-roadmap.md's Groups "Remaining" note).
 * `token` here is always the RAW token (see `GroupInviteLink.token`'s own schema
 * docstring for why it's stored, not just hashed, server-side) — safe to keep
 * returning as plaintext to an already-authorized admin on every fetch.
 */
export const GroupInviteLinkDto = z.object({
  token: z.string(),
  groupId: z.string().uuid(),
});
export type GroupInviteLinkDto = z.infer<typeof GroupInviteLinkDto>;

/** `GET /api/groups/invite/:token` — a peek, before committing to actually join
 * (mirrors `getDeviceLinkInfo`'s identical "show what this token resolves to first"
 * shape for device-linking). `alreadyMember` lets the client skip straight to "Open
 * chat" instead of "Join" for a link the caller has already redeemed. */
export const GroupInvitePeekDto = z.object({
  groupId: z.string().uuid(),
  groupName: z.string(),
  memberCount: z.number().int().nonnegative(),
  alreadyMember: z.boolean(),
  conversationId: z.string().uuid().nullable(),
});
export type GroupInvitePeekDto = z.infer<typeof GroupInvitePeekDto>;

const GroupName = z.string().trim().min(1, 'Group name is required.').max(100, 'Group name is too long.');
const GroupDescription = z.string().trim().max(500, 'Description is too long.');

export const CreateGroupRequest = z.object({
  name: GroupName,
  description: GroupDescription.optional(),
  // At least one other member besides the creator — a "group" of one isn't
  // meaningful. Capped generously (not a real expected size) purely as a sanity
  // ceiling on request payload size, not a product limit.
  memberUsernames: z.array(z.string()).min(1, 'Add at least one other member.').max(255),
});
export type CreateGroupRequest = z.infer<typeof CreateGroupRequest>;

export const UpdateGroupRequest = z
  .object({
    name: GroupName.optional(),
    description: GroupDescription.nullable().optional(),
    onlyAdminsCanMessage: z.boolean().optional(),
  })
  .refine((v) => v.name !== undefined || v.description !== undefined || v.onlyAdminsCanMessage !== undefined, {
    message: 'At least one setting must be provided.',
  });
export type UpdateGroupRequest = z.infer<typeof UpdateGroupRequest>;

export const AddGroupMemberRequest = z.object({
  username: z.string(),
});
export type AddGroupMemberRequest = z.infer<typeof AddGroupMemberRequest>;

/**
 * Group session key distribution (docs/13-roadmap.md's design note — docs/05 says key
 * material is "delivered 1:1, over each member's already-established Double Ratchet
 * session" but doesn't specify a transport; this is that transport). The envelope is
 * the EXISTING 1:1 Double-Ratchet envelope shape encrypting a small "group session
 * descriptor" plaintext client-side (apps/web/lib/crypto/group-sessions.ts) — never a
 * new server-side crypto format, and never something this module parses.
 */
export const GroupKeyShareDto = z.object({
  id: z.string().uuid(),
  groupId: z.string().uuid(),
  epoch: z.number().int().nonnegative(),
  fromDeviceId: z.string().uuid(),
  /** The sending device's owner — resolved server-side (never trusted from the
   * envelope, which the server can't read anyway) so the client can key its local
   * inbound session storage by sender identity without an extra round trip. */
  fromUserId: z.string().uuid(),
  envelope: MessageEnvelopeUpload,
  x3dhInit: X3dhInitPayload.nullable(),
  createdAt: z.string().datetime(),
});
export type GroupKeyShareDto = z.infer<typeof GroupKeyShareDto>;

/**
 * WS C→S `group.key-share` — one member's client relaying its (re)shared outbound
 * group session to one other member's device. Blindly relayed by the server, exactly
 * like `call.*` signaling: authorized by re-deriving group membership for both the
 * caller and `toDeviceId`'s owner, never a client-claimed device id trusted alone.
 */
export const SendGroupKeyShareRequest = z.object({
  groupId: z.string().uuid(),
  epoch: z.number().int().nonnegative(),
  toDeviceId: z.string().uuid(),
  envelope: MessageEnvelopeUpload,
  x3dhInit: X3dhInitPayload.nullable(),
});
export type SendGroupKeyShareRequest = z.infer<typeof SendGroupKeyShareRequest>;
