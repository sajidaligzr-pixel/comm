import { z } from 'zod';

const Base64 = z.string().regex(/^[A-Za-z0-9+/]+=*$/, 'Must be base64-encoded.');

/**
 * `Base64` above has no length cap, which is fine for most uses here (a reply id,
 * an X3DH init payload's fixed-size fields), but `MessageEnvelopeUpload` carries
 * the actual message content — including voice messages
 * (components/chat/message-thread.tsx's recorder, capped at 2 minutes client-side)
 * and images (same file's `compressImageForSend`, which downscales/re-encodes to
 * JPEG client-side specifically to fit inline through this same field rather than a
 * real object-storage upload — see its docstring for why that's a deliberate Phase 3
 * simplification, not the Phase 4 media pipeline).
 * A client-side cap is not a security boundary — a malicious/modified client could
 * ignore it entirely and POST straight to the API — so the server needs its own
 * ceiling too, or an arbitrarily large "ciphertext" becomes a storage/DoS vector via
 * the plain `messages.ciphertext` bytea column, no upload-size handling involved at
 * all. 4 MiB (base64, ~3 MiB decoded) comfortably covers a 2-minute voice note or a
 * compressed photo at any reasonable quality with headroom, while still bounding the
 * worst case.
 */
const CiphertextBase64 = Base64.max(4 * 1024 * 1024, 'Message content is too large.');
// The Double Ratchet header is a fixed 40 raw bytes (packages/crypto's
// `encodeHeader`) — base64 of that is always 56 characters; 128 leaves slack for
// padding variance without opening this up to being a second large-payload field.
const HeaderBase64 = Base64.max(128, 'Malformed message header.');

export const ConversationType = z.enum(['direct', 'group']);
export type ConversationType = z.infer<typeof ConversationType>;

export const DisappearingTimer = z.enum(['off', 'h24', 'd7', 'd30']);
export type DisappearingTimer = z.infer<typeof DisappearingTimer>;

/** The one place "h24 means 24 hours" is spelled out — shared by `apps/worker`'s
 * expiry sweep (jobs/cleanup.ts) and any client-side display, so the two can never
 * quietly disagree on what a timer value means. `null` = never expires. */
export function disappearingTimerToMs(timer: DisappearingTimer): number | null {
  switch (timer) {
    case 'off':
      return null;
    case 'h24':
      return 24 * 60 * 60 * 1000;
    case 'd7':
      return 7 * 24 * 60 * 60 * 1000;
    case 'd30':
      return 30 * 24 * 60 * 60 * 1000;
  }
}

/**
 * Which of the three tombstone paths produced a deletion — see
 * `Message.deletionReason` in schema.prisma. Lives here (not just as a Prisma enum)
 * because the client needs it too, to pick which placeholder text to show.
 */
export const MessageDeletionReason = z.enum(['manual', 'disappearing_timer', 'media_retention', 'viewed']);
export type MessageDeletionReason = z.infer<typeof MessageDeletionReason>;

/**
 * docs/10-privacy-data-retention.md's media retention pass — a hard, always-on
 * default (not a per-conversation setting like `DisappearingTimer` above):
 * image/voice/file content is erased 24h after sending, full stop, to bound storage
 * growth. Deliberately NOT configurable this pass — see the roadmap note on why a
 * per-conversation override is a tracked follow-up, not built now. Text messages are
 * untouched; only `MessageContentType`s with real bytes/files behind them
 * (`image`, `voice`, `media`) are ever swept by this.
 */
export const MEDIA_RETENTION_MS = 24 * 60 * 60 * 1000;

export const MessageContentType = z.enum([
  'text',
  'image',
  'media',
  'voice',
  'location',
  'contact',
  'reaction',
  'system',
  'view_once',
]);
export type MessageContentType = z.infer<typeof MessageContentType>;

export const MessageEnvelopeType = z.enum(['x3dh_ratchet_1to1', 'megolm_group']);
export type MessageEnvelopeType = z.infer<typeof MessageEnvelopeType>;

/** Mirrors `@comm/crypto`'s `MessageEnvelope` — kept as a separate type here rather
 * than importing packages/crypto into packages/types, since packages/types is shared
 * with server code that must never depend on the E2E crypto package
 * (docs/01-folder-structure.md's module-isolation rule). */
export const MessageEnvelopeUpload = z.object({
  header: HeaderBase64,
  ciphertext: CiphertextBase64,
});
export type MessageEnvelopeUpload = z.infer<typeof MessageEnvelopeUpload>;

export const X3dhInitPayload = z.object({
  identityAgreementKey: Base64,
  ephemeralKey: Base64,
  usedSignedPreKeyId: z.number().int().nonnegative(),
  usedOneTimePreKeyId: z.number().int().nonnegative().nullable(),
});
export type X3dhInitPayload = z.infer<typeof X3dhInitPayload>;

/** Shared by both branches below — kept as one object spread into each rather than a
 * Zod `.extend()` chain, since `discriminatedUnion` needs the literal `type` field at
 * the top level of each member schema, not composed in from a base. */
const ConversationSummaryCommon = {
  id: z.string().uuid(),
  disappearingTimer: DisappearingTimer,
  lastMessageAt: z.string().datetime().nullable(),
  unreadCount: z.number().int().nonnegative(),
  /** Per-member, not shared — same as WhatsApp: archiving is a private view
   * preference (hides the conversation from your own main list), not something
   * that affects what the other participant(s) see. Lives on `ConversationMember`,
   * not `Conversation` (server/modules/conversations/service.ts). */
  archived: z.boolean(),
  /** Same per-member-view-preference shape as `archived` above — pins this
   * conversation to the top of the CALLER's own list only. */
  pinned: z.boolean(),
};

/**
 * A discriminated union, not a single shape with an optional `otherUser` — the
 * group-chat pass (docs/13-roadmap.md) added a second conversation shape, and every
 * call site that previously assumed exactly one other participant (`toSummary` in
 * server/modules/conversations/service.ts, `conversation-list.tsx`,
 * `chats-shell.tsx`'s search filter, `MessageThread`'s header props) has to branch on
 * `type` explicitly now rather than silently only handling `direct`.
 */
export const ConversationSummary = z.discriminatedUnion('type', [
  z.object({
    ...ConversationSummaryCommon,
    type: z.literal('direct'),
    otherUser: z.object({
      id: z.string().uuid(),
      username: z.string(),
      displayName: z.string(),
    }),
    /** Whether the CALLER has blocked `otherUser` — drives the "Block"/"Unblock"
     * toggle in the thread header. Deliberately does NOT reveal whether the
     * other side blocked the caller (see docs/13-roadmap.md's blocked-users
     * pass) — that stays a private fact the same way WhatsApp never tells you
     * "this person blocked you," only that sends/calls silently don't land. */
    callerHasBlockedOtherUser: z.boolean(),
  }),
  z.object({
    ...ConversationSummaryCommon,
    type: z.literal('group'),
    group: z.object({
      id: z.string().uuid(),
      name: z.string(),
      memberCount: z.number().int().positive(),
    }),
  }),
]);
export type ConversationSummary = z.infer<typeof ConversationSummary>;

export const CreateDirectConversationRequest = z.object({
  withUsername: z.string(),
});
export type CreateDirectConversationRequest = z.infer<typeof CreateDirectConversationRequest>;

/**
 * `PATCH /api/conversations/:id`. `disappearingTimer` is a shared conversation
 * setting (either member can change it, matches WhatsApp — not owned by whoever
 * turned it on); `archived` is a per-caller view preference (see
 * `ConversationSummary.archived` above) — the two are persisted to different
 * tables but exposed as one PATCH since they're both "conversation settings" from
 * the client's point of view. At least one field must be present.
 */
export const UpdateConversationRequest = z
  .object({
    disappearingTimer: DisappearingTimer.optional(),
    archived: z.boolean().optional(),
    pinned: z.boolean().optional(),
  })
  .refine((v) => v.disappearingTimer !== undefined || v.archived !== undefined || v.pinned !== undefined, {
    message: 'At least one setting must be provided.',
  });
export type UpdateConversationRequest = z.infer<typeof UpdateConversationRequest>;

/**
 * `POST /api/conversations/:id/messages` (WS `message.send` uses the same shape —
 * docs/04-websocket-realtime.md). Two shapes depending on `conversation.type`,
 * distinguished by which of `envelope`/`recipients` is present (enforced by the
 * `.refine()` below, not by a discriminated union — the two cases share every other
 * field, and `sendMessage` itself is what already knows the conversation's type):
 *
 * - **group**: one shared envelope (`envelope`/`x3dhInit`) — every member reads the
 *   same Megolm-style group-session ciphertext, so there's nothing per-device to
 *   name from the client. `recipients` must be absent.
 * - **direct**: `recipients` — one entry per target device, each independently
 *   encrypted (pairwise Double Ratchet sessions can't share a ciphertext across
 *   devices). The client resolves the full target set itself (every other member's
 *   active devices, `GET /api/conversations/:id/recipient-devices`, **plus** its own
 *   other active devices, `GET /api/devices`) and calls `encryptForDevice` once per
 *   target — this is what makes multi-device sync real: a second phone, a desktop
 *   client, a web tab left open elsewhere all receive their own copy, not just
 *   whichever single device happened to be "most recently active." `envelope`/
 *   `x3dhInit` must be absent; `sendMessage` (server/modules/messages/service.ts)
 *   still validates every supplied device against the real membership/device state,
 *   never trusting the client's target list blindly.
 */
const RecipientEnvelope = z.object({
  deviceId: z.string().uuid(),
  envelope: MessageEnvelopeUpload,
  x3dhInit: X3dhInitPayload.nullable(),
});
export type RecipientEnvelope = z.infer<typeof RecipientEnvelope>;

/** Only present when `contentTypeHint === 'media'` — links this message to an
 * already-uploaded object (docs/13-roadmap.md's media pass). `objectKey` must match a
 * live `media:pending:<objectKey>` Redis record created by this same caller via
 * `POST /api/media/upload-url` (apps/web/server/modules/messages/service.ts) — the
 * server never trusts a client-claimed objectKey it didn't itself mint. */
export const MessageAttachmentRef = z.object({
  objectKey: z.string().uuid(),
  encryptedSizeBytes: z.number().int().positive(),
});
export type MessageAttachmentRef = z.infer<typeof MessageAttachmentRef>;

export const SendMessageRequest = z
  .object({
    messageId: z.string().uuid(),
    envelopeType: MessageEnvelopeType,
    envelope: MessageEnvelopeUpload.optional(),
    x3dhInit: X3dhInitPayload.nullable().optional(),
    recipients: z.array(RecipientEnvelope).min(1).optional(),
    contentTypeHint: MessageContentType,
    replyToMessageId: z.string().uuid().nullable(),
    sentAt: z.string().datetime(),
    attachment: MessageAttachmentRef.optional(),
  })
  .refine((v) => (v.envelope !== undefined) !== (v.recipients !== undefined), {
    message: 'Provide exactly one of envelope (group) or recipients (direct).',
  });
export type SendMessageRequest = z.infer<typeof SendMessageRequest>;

export const MessageDto = z.object({
  id: z.string().uuid(),
  conversationId: z.string().uuid(),
  senderUserId: z.string().uuid(),
  senderDeviceId: z.string().uuid(),
  recipientDeviceId: z.string().uuid(),
  envelopeType: MessageEnvelopeType,
  envelope: MessageEnvelopeUpload,
  x3dhInit: X3dhInitPayload.nullable(),
  contentTypeHint: MessageContentType,
  replyToMessageId: z.string().uuid().nullable(),
  sentAt: z.string().datetime(),
  serverReceivedAt: z.string().datetime(),
  deliveredAt: z.string().datetime().nullable(),
  readAt: z.string().datetime().nullable(),
  /**
   * The CALLER's OWN history-sync copy of this message, if one exists yet
   * (packages/database/prisma/schema.prisma's `MessageHistoryEntry`,
   * docs/07-auth-architecture.md's history-key section) — a fallback decrypt path
   * for whenever `envelope` above isn't decryptable on THIS device (a brand-new
   * device, or one that was never a target for this specific message's live
   * pairwise/group session). `null` if this account's own devices haven't written
   * one yet (nobody has successfully decrypted this message live yet on any of
   * this account's devices) — same "no catch-up path until someone's actually
   * online to see it" limitation the live delivery path already discloses.
   */
  history: z.object({ ciphertext: Base64 }).nullable(),
});
export type MessageDto = z.infer<typeof MessageDto>;

export const MarkReadRequest = z.object({
  upToMessageId: z.string().uuid(),
});
export type MarkReadRequest = z.infer<typeof MarkReadRequest>;

/**
 * `GET /api/messages/starred` — see `StarredMessage`'s doc comment in
 * schema.prisma for why this is metadata-only, never plaintext: the server
 * genuinely has no content to give back (E2E), so this just tells the client
 * WHICH message, in WHICH conversation, to look up in its own local decrypted
 * cache (`loadCachedMessages(kek, conversationId)`, then find by id) — a
 * client that never decrypted that message has nothing to show, same honest
 * limitation as every other view in this app.
 */
export const StarredMessageDto = z.object({
  messageId: z.string().uuid(),
  conversationId: z.string().uuid(),
  starredAt: z.string().datetime(),
});
export type StarredMessageDto = z.infer<typeof StarredMessageDto>;

/**
 * `GET /api/messages/:id/receipts` — "seen by" for a GROUP message (1:1 already
 * shows this as a single/double/blue tick, never a per-person breakdown, same as
 * WhatsApp). One entry per member who has at least one `MessageRecipient` row for
 * this message (server/modules/messages/service.ts's `getMessageReceipts` — a
 * member with multiple devices is collapsed to their best state across all of
 * them: read beats delivered beats neither). A member absent from this list never
 * had a reachable device when the message was sent — same "no catch-up path"
 * limitation `sendMessage`'s own docstring already states.
 */
export const MessageReceiptDto = z.object({
  userId: z.string().uuid(),
  username: z.string(),
  displayName: z.string(),
  deliveredAt: z.string().datetime().nullable(),
  readAt: z.string().datetime().nullable(),
});
export type MessageReceiptDto = z.infer<typeof MessageReceiptDto>;
