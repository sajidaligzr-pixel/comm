import { bytesToUtf8, bytesToBase64 } from '@comm/crypto';
import type { MessageDeletionReason } from '@comm/types';

/** `contentTypeHint`s whose plaintext is binary media, not UTF-8 text — shared
 * between `components/chat/message-thread.tsx` (the open-thread decrypt paths) and
 * `components/chat/chats-shell.tsx` (the sidebar-preview decrypt path), since both
 * independently reconstruct a `CachedMessage` from the same wire `MessageDto` and
 * must treat these content types identically or a message received while only the
 * sidebar preview decrypts it (never the open thread) would get cached with its raw
 * media bytes wrongly run through `bytesToUtf8` instead of `bytesToBase64` — garbling
 * it permanently, since Double Ratchet message keys are single-use and there is no
 * second chance to re-decrypt correctly later. */
export function hasMediaBytes(contentTypeHint: string): boolean {
  return contentTypeHint === 'voice' || contentTypeHint === 'image';
}

/** Descriptor for a generic file attachment (docs/13-roadmap.md's file-attachment
 * pass) — this is the actual "plaintext" of a `contentTypeHint: 'media'` message: a
 * small JSON blob naming an object-storage key + the AES-256-GCM key/nonce needed to
 * decrypt it, never the file bytes themselves (those live in object storage,
 * encrypted, fetched on demand — see lib/crypto/attachment-crypto.ts). */
export interface AttachmentDescriptor {
  objectKey: string;
  key: string;
  nonce: string;
  mimeType: string;
  fileName: string;
  sizeBytes: number;
}

export interface DecodedMessageContent {
  text: string;
  mediaBase64?: string;
  attachment?: AttachmentDescriptor;
}

/**
 * The single place a decrypted message plaintext is turned into cacheable fields —
 * extracted for the exact same reason `hasMediaBytes` was: message-thread.tsx (4 call
 * sites) and chats-shell.tsx's sidebar-preview path must decode identically, or a
 * message that only the sidebar decrypts first gets corrupted with no second chance
 * to fix it later (single-use ratchet keys). Voice/image bytes go to `mediaBase64`
 * (rendered as a `data:` URL, no network round-trip); a `media` descriptor goes to
 * `attachment` (rendered as a file bubble with an on-demand Download action); anything
 * else is treated as UTF-8 text.
 */
/**
 * One tombstoned-message placeholder, shared by every place that renders one — the
 * open-thread bubble, the reply-quote preview, and the sidebar's last-message line
 * (docs/10-privacy-data-retention.md's media retention pass added the second
 * branch here; before that every deletion showed identical text regardless of why).
 * `deletedReason` absent (an old cached row, or a manual/disappearing-timer delete)
 * falls through to the original generic text — only `media_retention` gets its own.
 */
export function deletedPlaceholderText(contentTypeHint: string, deletedReason: MessageDeletionReason | undefined): string {
  if (deletedReason !== 'media_retention') return 'This message was deleted';
  if (contentTypeHint === 'voice') return 'This voice message has expired';
  if (contentTypeHint === 'image') return 'This photo has expired';
  if (contentTypeHint === 'media') return 'This file has expired';
  return 'This message was deleted';
}

export function decodeMessagePlaintext(contentTypeHint: string, plaintext: Uint8Array): DecodedMessageContent {
  if (hasMediaBytes(contentTypeHint)) {
    return { text: '', mediaBase64: bytesToBase64(plaintext) };
  }
  if (contentTypeHint === 'media') {
    try {
      const descriptor = JSON.parse(bytesToUtf8(plaintext)) as AttachmentDescriptor;
      return { text: '', attachment: descriptor };
    } catch {
      // A malformed/unrecognized descriptor is rendered as an empty bubble rather
      // than thrown — the same "skip, don't crash the thread" posture the catch-up
      // decrypt loops already take for undecryptable messages.
      return { text: '' };
    }
  }
  return { text: bytesToUtf8(plaintext) };
}
