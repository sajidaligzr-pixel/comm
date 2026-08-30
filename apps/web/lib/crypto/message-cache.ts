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
 * Backed by db.ts's indexed `messages` object store (one row per message), not a
 * single blob per conversation any more — that design (one AEAD-wrapped JSON array
 * per conversation) had no way to fetch just the newest slice of a big
 * conversation: every open pulled the WHOLE blob out of IndexedDB and JSON-parsed
 * all of it at once, found live to be the real cause of "opening a big chat takes a
 * while, shows a spinner." Each row's own `ciphertext` column is still wrapped
 * under the same local KEK as identity/session data
 * (docs/05-crypto-architecture.md#local-key-storage) — plaintext message content is
 * exactly the kind of sensitive local data docs/32-local-data-storage.md says must
 * not sit around unencrypted; only `id`/`conversationId`/`sentAt` are plaintext
 * IndexedDB fields (needed to index/query at all), mirroring the server's own
 * Message table's already-accepted metadata-visible/content-encrypted split.
 */
import { wrapBytes, unwrapBytes, utf8ToBytes, bytesToUtf8 } from '@comm/crypto';
import type { MessageDeletionReason } from '@comm/types';
import {
  deleteMessageRow,
  deleteMessageRows,
  getAllBlobKeysWithPrefix,
  getBlob,
  deleteBlob,
  getMessageRow,
  getMessageRowsForConversation,
  putBlob,
  putMessageRow,
  putMessageRows,
} from './db';
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

/** Bounds how much history is kept per conversation locally — this is a cache, not
 * the durable server-side record of the *encrypted* history; older plaintext falls
 * out of it and in practice cannot be recovered (the ratchet message key it was
 * decrypted with is long gone by then) — same tradeoff the mobile client's own
 * cache accepts. */
const MAX_CACHED_PER_CONVERSATION = 500;

async function encodeMessage(kek: Uint8Array, message: CachedMessage): Promise<Uint8Array> {
  return wrapBytes(kek, utf8ToBytes(JSON.stringify(message)));
}

async function decodeRow(kek: Uint8Array, ciphertext: Uint8Array): Promise<CachedMessage> {
  const plaintext = unwrapBytes(kek, ciphertext);
  return JSON.parse(bytesToUtf8(plaintext)) as CachedMessage;
}

/** Deletes the oldest rows for [conversationId] beyond [MAX_CACHED_PER_CONVERSATION]
 * — IndexedDB has no "delete all but the newest N" query, so this loads this
 * conversation's already-small row set (≤ max + however many were just added),
 * sorts, and deletes the excess by id. Never touches any other conversation's rows. */
async function trim(conversationId: string): Promise<void> {
  const rows = await getMessageRowsForConversation(conversationId);
  if (rows.length <= MAX_CACHED_PER_CONVERSATION) return;
  const sorted = [...rows].sort((a, b) => new Date(a.sentAt).getTime() - new Date(b.sentAt).getTime());
  const excess = sorted.slice(0, sorted.length - MAX_CACHED_PER_CONVERSATION);
  await deleteMessageRows(excess.map((r) => r.id));
}

export async function loadCachedMessages(kek: Uint8Array, conversationId: string): Promise<CachedMessage[]> {
  const rows = await getMessageRowsForConversation(conversationId);
  const decoded: CachedMessage[] = [];
  for (const row of rows) {
    try {
      decoded.push(await decodeRow(kek, row.ciphertext));
    } catch {
      // A KEK mismatch (e.g. stale cache from before a password change) or a
      // corrupt single row isn't a reason to lose the rest of the conversation
      // — same "fail this one message, not the whole cache" reasoning the old
      // blob-based version could only apply at the whole-list level.
    }
  }
  return decoded.sort((a, b) => new Date(a.sentAt).getTime() - new Date(b.sentAt).getTime());
}

/** Idempotent by message id — safe to call for a message that's already cached
 * (e.g. a duplicate WS delivery after reconnect, docs/04-websocket-realtime.md's
 * at-least-once delivery model): `putMessageRow` overwrites in place, and a
 * duplicate delivery of the same message id is always byte-identical content
 * anyway. Returns the conversation's full updated list, same shape every caller
 * already expects to `setState` directly with. */
export async function appendCachedMessage(kek: Uint8Array, message: CachedMessage): Promise<CachedMessage[]> {
  await putMessageRow({
    id: message.id,
    conversationId: message.conversationId,
    sentAt: message.sentAt,
    ciphertext: await encodeMessage(kek, message),
  });
  await trim(message.conversationId);
  return loadCachedMessages(kek, message.conversationId);
}

/** Prepends a page of older messages (pagination "load earlier") — same
 * idempotent-by-id merge as `appendCachedMessage`, just for a batch arriving at the
 * front of history instead of one arriving live at the end. One transaction for
 * the whole page, not one per message. */
export async function prependCachedMessages(
  kek: Uint8Array,
  conversationId: string,
  olderMessages: CachedMessage[],
): Promise<CachedMessage[]> {
  if (olderMessages.length > 0) {
    const rows = await Promise.all(
      olderMessages.map(async (message) => ({
        id: message.id,
        conversationId: message.conversationId,
        sentAt: message.sentAt,
        ciphertext: await encodeMessage(kek, message),
      })),
    );
    await putMessageRows(rows);
    await trim(conversationId);
  }
  return loadCachedMessages(kek, conversationId);
}

/** Rolls back an optimistically-cached outgoing message whose send failed — see
 * message-thread.tsx's optimistic-send flow. Not used for anything else: a
 * successfully-sent or received message is never silently removed, only tombstoned
 * via `markCachedMessageDeleted` (an explicit, user-visible action). A single
 * indexed delete now, not a read-decrypt-filter-re-encrypt-write of the whole
 * conversation. */
export async function removeCachedMessage(kek: Uint8Array, conversationId: string, messageId: string): Promise<CachedMessage[]> {
  await deleteMessageRow(messageId);
  return loadCachedMessages(kek, conversationId);
}

/** Tombstones a message locally — mirrors the server's own delete semantics
 * (docs/02-database-schema.md's "On deletion": ciphertext genuinely nulled out, not
 * just flagged). Idempotent and a no-op if the message isn't cached on this device
 * at all (e.g. it was deleted before this device ever decrypted it). One indexed
 * row read + write now, not the whole conversation. */
export async function markCachedMessageDeleted(
  kek: Uint8Array,
  conversationId: string,
  messageId: string,
  reason: MessageDeletionReason = 'manual',
): Promise<CachedMessage[]> {
  const row = await getMessageRow(messageId);
  if (row) {
    const existing = await decodeRow(kek, row.ciphertext);
    const updated: CachedMessage = {
      ...existing,
      text: '',
      mediaBase64: undefined,
      attachment: undefined,
      deleted: true,
      deletedReason: reason,
    };
    await putMessageRow({ ...row, ciphertext: await encodeMessage(kek, updated) });
  }
  return loadCachedMessages(kek, conversationId);
}

/**
 * "Delete chat" (chats-shell.tsx's per-row action, mirroring apps/mobile's
 * identically-named feature exactly — see message_cache.dart's own docstring)
 * — wipes this device's own local decrypted history for one conversation.
 * Deliberately NOT a server-side delete: no such route exists (only `archived`,
 * a per-caller view preference), and WhatsApp's own "Delete chat" has the same
 * scope: it clears your device's view, not the other person's, and the
 * conversation reappears if they message you again. Since a Double Ratchet
 * ciphertext can only ever be decrypted once (this file's own module docstring),
 * this history is not recoverable afterward even from the server's stored
 * ciphertext.
 *
 * Used together with `markConversationLocallyDeleted` below, NOT `archived` —
 * reusing the archive flag for this would land a "deleted" chat inside the
 * Archived section instead of actually making it disappear, the exact bug this
 * two-function split (matching the mobile client's own fix for the identical
 * mistake) avoids from the start.
 */
export async function clearCachedMessages(conversationId: string): Promise<void> {
  const rows = await getMessageRowsForConversation(conversationId);
  await deleteMessageRows(rows.map((r) => r.id));
}

const LOCALLY_DELETED_KEY = 'messages:locally-deleted-conversations';

async function readLocallyDeleted(): Promise<Set<string>> {
  const raw = await getBlob(LOCALLY_DELETED_KEY);
  if (!raw) return new Set();
  try {
    const decoded = JSON.parse(bytesToUtf8(raw)) as unknown;
    return Array.isArray(decoded) ? new Set(decoded.filter((id): id is string => typeof id === 'string')) : new Set();
  } catch {
    return new Set();
  }
}

async function writeLocallyDeleted(ids: Set<string>): Promise<void> {
  if (ids.size === 0) {
    await deleteBlob(LOCALLY_DELETED_KEY);
    return;
  }
  await putBlob(LOCALLY_DELETED_KEY, utf8ToBytes(JSON.stringify([...ids])));
}

/**
 * The other half of "Delete chat" (see `clearCachedMessages` above).
 * Unencrypted on the wire, plaintext at rest is fine here — a conversation id
 * is not sensitive content, unlike everything else this file stores. This is
 * local-only and never reaches the server — deleting a chat on one device has
 * no effect on the conversation's `archived` state or visibility on any other
 * device, matching every other "local view preference" in this file.
 */
export async function markConversationLocallyDeleted(conversationId: string): Promise<void> {
  const ids = await readLocallyDeleted();
  ids.add(conversationId);
  await writeLocallyDeleted(ids);
}

/** Called the moment a live message arrives for a conversation (chats-shell.tsx's
 * WS 'new' handler) — this is what actually makes good on "this chat will come
 * back if they message you again" from the delete-confirmation dialog: a
 * locally-deleted conversation is hidden by `locallyDeletedConversationIds`
 * below, not removed from the account, so the moment a new message shows it's
 * still live, this un-hides it. A no-op if the id wasn't hidden to begin with. */
export async function unmarkConversationLocallyDeleted(conversationId: string): Promise<void> {
  const ids = await readLocallyDeleted();
  if (ids.delete(conversationId)) {
    await writeLocallyDeleted(ids);
  }
}

/** Bulk read — chats-shell.tsx filters an entire freshly-loaded conversation
 * list against this once, rather than one blob read per row. */
export function locallyDeletedConversationIds(): Promise<Set<string>> {
  return readLocallyDeleted();
}

const LEGACY_CACHE_KEY_PREFIX = 'messages:';

/**
 * One-time-per-account migration off the old one-blob-per-conversation cache
 * (`wrapped-blobs` store, key `messages:<conversationId>`) into this file's new
 * indexed `messages` store — mirrors apps/mobile's `migrateLegacyMessageCache`
 * exactly, see that function's own docstring. Called once per unlock (see
 * `complete-unlock.ts`) after the KEK becomes available, since decrypting the
 * old blobs needs it. Safe to call on every unlock: a conversation whose old
 * blob was already migrated (and deleted) simply isn't found by
 * `getAllBlobKeysWithPrefix` any more, so a re-run after a successful migration
 * is a fast no-op, not a re-import. Never throws — one conversation's
 * corrupt/undecryptable legacy blob just means that conversation's local
 * history is gone, exactly as it already would be under the old cache in the
 * same situation, not a reason to fail unlock.
 *
 * `LOCALLY_DELETED_KEY` above shares the same `messages:` prefix by
 * coincidence of naming, not by the legacy per-conversation cache format —
 * excluded explicitly so migration doesn't try to treat it as a conversation's
 * message list.
 */
export async function migrateLegacyMessageCache(kek: Uint8Array): Promise<void> {
  const legacyKeys = (await getAllBlobKeysWithPrefix(LEGACY_CACHE_KEY_PREFIX)).filter(
    (key) => key !== LOCALLY_DELETED_KEY,
  );
  for (const key of legacyKeys) {
    const conversationId = key.substring(LEGACY_CACHE_KEY_PREFIX.length);
    try {
      const wrapped = await getBlob(key);
      if (wrapped) {
        const plaintext = unwrapBytes(kek, wrapped);
        const messages = JSON.parse(bytesToUtf8(plaintext)) as CachedMessage[];
        const rows = await Promise.all(
          messages.map(async (message) => ({
            id: message.id,
            conversationId: message.conversationId,
            sentAt: message.sentAt,
            ciphertext: await encodeMessage(kek, message),
          })),
        );
        await putMessageRows(rows);
        await trim(conversationId);
      }
    } catch {
      // See this function's own docstring — one conversation's corrupt/
      // undecryptable legacy blob doesn't block migrating the rest.
    }
    await deleteBlob(key);
  }
}
