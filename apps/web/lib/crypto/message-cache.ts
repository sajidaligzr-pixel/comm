'use client';

/**
 * The durable, local record of decrypted message history — and the reason it has to
 * exist at all: Double Ratchet message keys are deleted immediately after a single
 * use (docs/05-crypto-architecture.md's forward-secrecy design), so a ciphertext can
 * only ever be decrypted ONCE, by whichever device processes it first. The server's
 * stored ciphertext is not a durable archive a client can re-read from later — this
 * local cache is. It also holds this device's OWN sent messages, which could never
 * be re-decrypted from the stored ciphertext at all (a Double Ratchet's sending
 * chain is one-directional — the sender doesn't keep the keys either).
 *
 * Wrapped under the same local KEK as identity/session data (docs/05-crypto-architecture.md#local-key-storage)
 * — plaintext message content is exactly the kind of sensitive local data
 * docs/32-local-data-storage.md says must not sit around unencrypted.
 */
import { wrapBytes, unwrapBytes, utf8ToBytes, bytesToUtf8 } from '@comm/crypto';
import type { MessageDeletionReason } from '@comm/types';
import { putBlob, getBlob } from './db';
import type { AttachmentDescriptor } from '../message-content';

export interface CachedMessage {
  id: string;
  conversationId: string;
  senderUserId: string;
  isOwn: boolean;
  contentTypeHint: string;
  text: string;
  /** Base64-encoded media bytes, present when `contentTypeHint` is `'voice'` (raw
   * audio) or `'image'` (JPEG, downscaled/re-encoded client-side before sending) —
   * both run through the exact same AEAD envelope as text (see
   * components/chat/message-thread.tsx); this is just where the decrypted bytes land
   * instead of `text`. */
  mediaBase64?: string;
  mediaDurationSec?: number;
  /** Present when `contentTypeHint === 'media'` (docs/13-roadmap.md's
   * file-attachment pass) — the decrypted descriptor for a generic file, distinct
   * from `mediaBase64`: the file's ciphertext lives in object storage, not inline,
   * so only the small key/objectKey/name/size descriptor is cached here. The actual
   * bytes are fetched + decrypted on demand when the user taps Download (see
   * lib/crypto/attachment-crypto.ts), not eagerly. */
  attachment?: AttachmentDescriptor;
  sentAt: string;
  replyToMessageId: string | null;
  /** Tombstoned locally after a `DELETE /api/messages/:id` (own message) or a live
   * `deleted` realtime event (the other side deleted it) — `text`/`mediaBase64` are
   * cleared alongside this, mirroring the server nulling out ciphertext on delete
   * (docs/02-database-schema.md's "On deletion" note): the plaintext shouldn't
   * linger in local storage either once both sides have agreed it's gone. */
  deleted?: boolean;
  /** Which tombstone path produced `deleted: true` — lets the UI show "deleted" vs
   * "disappeared" vs "expired" instead of one generic placeholder for all three
   * (docs/10-privacy-data-retention.md's media retention pass). Absent on messages
   * cached before this field existed, which is why every read site treats a missing
   * reason the same as `'manual'` (the original, only-ever behavior). */
  deletedReason?: MessageDeletionReason;
}

function cacheKey(conversationId: string): string {
  return `messages:${conversationId}`;
}

/**
 * Serializes every read-modify-write against one conversation's cached blob.
 * Without this, two mutations arriving close together for the same conversation —
 * two `deleted` events, a `new` and a `deleted`, etc. — each read the same
 * pre-change snapshot and independently write back a full-blob overwrite, so
 * whichever write loses the race is silently discarded rather than merged. Found
 * live-testing media retention (docs/10-privacy-data-retention.md): a single sweep
 * run tombstoning an image, a voice note, and a file in the same conversation fired
 * three `deleted` events back to back, and without this lock one of the three
 * reliably never made it into the local cache even though the server-side tombstone
 * was correct. Keyed by conversationId, not global, so unrelated conversations never
 * block each other.
 */
const writeQueues = new Map<string, Promise<unknown>>();

function withConversationLock<T>(conversationId: string, run: () => Promise<T>): Promise<T> {
  const prior = writeQueues.get(conversationId) ?? Promise.resolve();
  const result = prior.then(run, run); // run regardless of whether the prior queued op threw
  // a rejection here must never wedge the queue for later callers
  const queued = result.catch(() => undefined);
  writeQueues.set(conversationId, queued);
  // Evicted once settled, but only if nothing newer has queued behind it in the
  // meantime (a real leak found auditing this for production: every conversation
  // ever touched kept a permanent entry here for the life of the tab otherwise) —
  // same compare-and-delete pattern conversation-crypto.ts's decrypt memo already
  // uses, so a genuinely new operation that queued in the meantime is never
  // evicted out from under it.
  void queued.then(() => {
    if (writeQueues.get(conversationId) === queued) writeQueues.delete(conversationId);
  });
  return result;
}

export async function loadCachedMessages(kek: Uint8Array, conversationId: string): Promise<CachedMessage[]> {
  const wrapped = await getBlob(cacheKey(conversationId));
  if (!wrapped) return [];
  try {
    const plaintext = unwrapBytes(kek, wrapped);
    return JSON.parse(bytesToUtf8(plaintext)) as CachedMessage[];
  } catch {
    // A KEK mismatch (e.g. stale cache from before a password change) is not a
    // reason to crash the chat UI — just start from an empty local history.
    return [];
  }
}

async function saveCachedMessages(kek: Uint8Array, conversationId: string, messages: CachedMessage[]): Promise<void> {
  const wrapped = wrapBytes(kek, utf8ToBytes(JSON.stringify(messages)));
  await putBlob(cacheKey(conversationId), wrapped);
}

/** Idempotent by message id — safe to call for a message that's already cached
 * (e.g. a duplicate WS delivery after reconnect, docs/04-websocket-realtime.md's
 * at-least-once delivery model). */
export function appendCachedMessage(kek: Uint8Array, message: CachedMessage): Promise<CachedMessage[]> {
  return withConversationLock(message.conversationId, async () => {
    const existing = await loadCachedMessages(kek, message.conversationId);
    if (existing.some((m) => m.id === message.id)) return existing;
    const updated = [...existing, message].sort((a, b) => new Date(a.sentAt).getTime() - new Date(b.sentAt).getTime());
    await saveCachedMessages(kek, message.conversationId, updated);
    return updated;
  });
}

/** Prepends a page of older messages (pagination "load earlier") — same
 * idempotent-by-id merge as `appendCachedMessage`, just for a batch arriving at the
 * front of history instead of one arriving live at the end. */
export function prependCachedMessages(
  kek: Uint8Array,
  conversationId: string,
  olderMessages: CachedMessage[],
): Promise<CachedMessage[]> {
  return withConversationLock(conversationId, async () => {
    const existing = await loadCachedMessages(kek, conversationId);
    const existingIds = new Set(existing.map((m) => m.id));
    const merged = [...olderMessages.filter((m) => !existingIds.has(m.id)), ...existing].sort(
      (a, b) => new Date(a.sentAt).getTime() - new Date(b.sentAt).getTime(),
    );
    await saveCachedMessages(kek, conversationId, merged);
    return merged;
  });
}

/** Rolls back an optimistically-cached outgoing message whose send failed — see
 * message-thread.tsx's optimistic-send flow. Not used for anything else: a
 * successfully-sent or received message is never silently removed, only tombstoned
 * via `markCachedMessageDeleted` (an explicit, user-visible action). */
export function removeCachedMessage(kek: Uint8Array, conversationId: string, messageId: string): Promise<CachedMessage[]> {
  return withConversationLock(conversationId, async () => {
    const existing = await loadCachedMessages(kek, conversationId);
    const updated = existing.filter((m) => m.id !== messageId);
    await saveCachedMessages(kek, conversationId, updated);
    return updated;
  });
}

/** Tombstones a message locally — mirrors the server's own delete semantics
 * (docs/02-database-schema.md's "On deletion": ciphertext genuinely nulled out, not
 * just flagged). Idempotent and a no-op if the message isn't cached on this device
 * at all (e.g. it was deleted before this device ever decrypted it). */
export function markCachedMessageDeleted(
  kek: Uint8Array,
  conversationId: string,
  messageId: string,
  reason: MessageDeletionReason = 'manual',
): Promise<CachedMessage[]> {
  return withConversationLock(conversationId, async () => {
    const existing = await loadCachedMessages(kek, conversationId);
    if (!existing.some((m) => m.id === messageId)) return existing;
    const updated = existing.map((m) =>
      m.id === messageId
        ? { ...m, text: '', mediaBase64: undefined, attachment: undefined, deleted: true, deletedReason: reason }
        : m,
    );
    await saveCachedMessages(kek, conversationId, updated);
    return updated;
  });
}
