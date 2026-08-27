import { z } from 'zod';

const Base64 = z.string().regex(/^[A-Za-z0-9+/]+=*$/, 'Must be base64-encoded.');

/**
 * Multi-device message HISTORY sync ("log in anywhere, see your full message
 * history, like WhatsApp" — docs/07-auth-architecture.md's history-key section,
 * `UserHistoryKey`/`MessageHistoryEntry` in packages/database/prisma/schema.prisma
 * carry the full design rationale). Every wire value here is already-wrapped
 * ciphertext or a KDF salt — this module never carries plaintext or an unwrapped
 * key, same as every other crypto-adjacent type in this package.
 */
export const UserHistoryKeyResponse = z.object({
  wrappedKey: Base64,
  salt: Base64,
});
export type UserHistoryKeyResponse = z.infer<typeof UserHistoryKeyResponse>;

/** `POST /api/account/history-key` — create-if-absent. The response is the
 * CANONICAL row after this call, which may not be what was submitted: if another
 * of the caller's own devices won a concurrent create first, this returns THAT
 * row instead (server/modules/history/service.ts's `createUserHistoryKeyIfAbsent`)
 * — the losing device re-derives its wrapping key from the winner's `salt` rather
 * than retrying. */
export const CreateUserHistoryKeyRequest = z.object({
  wrappedKey: Base64,
  salt: Base64,
});
export type CreateUserHistoryKeyRequest = z.infer<typeof CreateUserHistoryKeyRequest>;

/** `POST /api/messages/:id/history-copy` — same size ceiling reasoning as
 * `MessageEnvelopeUpload`'s `CiphertextBase64` in messages.ts: this carries a
 * full message's plaintext (re-encrypted under the caller's own History Key), the
 * same content this same caller already legitimately holds via the normal
 * per-device/group envelope, just wrapped a second way. */
export const UploadMessageHistoryEntryRequest = z.object({
  ciphertext: Base64.max(4 * 1024 * 1024, 'Message content is too large.'),
});
export type UploadMessageHistoryEntryRequest = z.infer<typeof UploadMessageHistoryEntryRequest>;
