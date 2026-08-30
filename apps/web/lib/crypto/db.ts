'use client';

/**
 * Raw IndexedDB glue — deliberately NOT cryptographic code (docs/01-folder-structure.md
 * keeps that in packages/crypto). This module only knows how to put/get opaque byte
 * blobs by key in a browser database; every blob it stores has already been wrapped
 * (encrypted) by packages/crypto before it ever reaches here, and this module has no
 * way to make sense of the bytes it's holding. See docs/05-crypto-architecture.md's
 * local key storage section for what those blobs actually are.
 */
import { getActiveAccount } from './active-account';

const DB_VERSION = 2;
const STORE_NAME = 'wrapped-blobs';
/** One row per message (id/conversationId/sentAt plaintext, ciphertext the
 * AEAD-wrapped full message) — added in DB_VERSION 2, replacing the single
 * one-blob-per-conversation record message-cache.ts used to keep in
 * STORE_NAME under key `messages:<conversationId>`. See message-cache.ts's
 * own docstring for why: that design had no way to fetch just the newest
 * slice of a big conversation — opening one meant pulling the WHOLE blob out
 * of IndexedDB and JSON-parsing all of it at once, found live to be the real
 * cause of "opening a big chat takes a while, shows a spinner." An indexed
 * per-message store lets a query ask for only one conversation's rows
 * directly, the way IndexedDB is actually meant to be used — this app was
 * only ever using it as an opaque key-value store before, none of its real
 * indexing. */
const MESSAGES_STORE_NAME = 'messages';
const MESSAGES_CONVERSATION_INDEX = 'conversationId';

/** One database PER ACCOUNT, not one shared database for the whole browser — see
 * active-account.ts's docstring for the real bug this closes. Every function below
 * calls this fresh on each open rather than caching a name, so it always reflects
 * whichever account is currently active in this tab. */
function dbName(): string {
  return `comm-crypto__${getActiveAccount()}`;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(dbName(), DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
      if (!db.objectStoreNames.contains(MESSAGES_STORE_NAME)) {
        const store = db.createObjectStore(MESSAGES_STORE_NAME, { keyPath: 'id' });
        store.createIndex(MESSAGES_CONVERSATION_INDEX, 'conversationId', { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function putBlob(key: string, value: Uint8Array): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

export async function getBlob(key: string): Promise<Uint8Array | null> {
  const db = await openDb();
  const result = await new Promise<Uint8Array | null>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const req = tx.objectStore(STORE_NAME).get(key);
    req.onsuccess = () => resolve((req.result as Uint8Array | undefined) ?? null);
    req.onerror = () => reject(req.error);
  });
  db.close();
  return result;
}

export async function deleteBlob(key: string): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

/** Every key currently in `wrapped-blobs` that starts with [prefix] — used for
 * exactly one purpose so far: message-cache.ts's one-time migration off the
 * old one-blob-per-conversation cache (key `messages:<conversationId>`) into
 * the new indexed `messages` store, but kept generic rather than migration-
 * specific-named in case a future one-time migration needs the identical
 * shape. `IDBKeyRange.bound(prefix, prefix + '￿')` is the standard
 * IndexedDB idiom for "every string key starting with this prefix" — there's
 * no native `startsWith` query. */
export async function getAllBlobKeysWithPrefix(prefix: string): Promise<string[]> {
  const db = await openDb();
  const keys = await new Promise<string[]>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const req = tx.objectStore(STORE_NAME).getAllKeys(IDBKeyRange.bound(prefix, prefix + '￿'));
    req.onsuccess = () => resolve((req.result as string[] | undefined) ?? []);
    req.onerror = () => reject(req.error);
  });
  db.close();
  return keys;
}

/** One row in the `messages` object store — `ciphertext` is the AEAD-wrapped
 * full `CachedMessage` JSON (message-cache.ts owns that encoding, this file
 * only ever moves opaque bytes); `id`/`conversationId`/`sentAt` are plaintext
 * so IndexedDB can actually index/query by them, mirroring the server's own
 * Message table's already-accepted metadata-visible/content-encrypted split
 * (docs/02-database-schema.md) — not a new exposure. */
export interface MessageRow {
  id: string;
  conversationId: string;
  sentAt: string;
  ciphertext: Uint8Array;
}

export async function putMessageRow(row: MessageRow): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(MESSAGES_STORE_NAME, 'readwrite');
    tx.objectStore(MESSAGES_STORE_NAME).put(row);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

/** Every cached row for one conversation, in whatever order IndexedDB's index
 * scan happens to return them — callers sort by `sentAt` themselves (trivial
 * at this scale, ≤500 rows, and avoids needing a compound index just for
 * ordering). */
export async function getMessageRowsForConversation(conversationId: string): Promise<MessageRow[]> {
  const db = await openDb();
  const rows = await new Promise<MessageRow[]>((resolve, reject) => {
    const tx = db.transaction(MESSAGES_STORE_NAME, 'readonly');
    const index = tx.objectStore(MESSAGES_STORE_NAME).index(MESSAGES_CONVERSATION_INDEX);
    const req = index.getAll(IDBKeyRange.only(conversationId));
    req.onsuccess = () => resolve((req.result as MessageRow[] | undefined) ?? []);
    req.onerror = () => reject(req.error);
  });
  db.close();
  return rows;
}

/** Bulk variant of [putMessageRow] — one transaction for every row instead of
 * one open/close per row (message-cache.ts's `prependCachedMessages`/history
 * catch-up, and the legacy-cache migration). */
export async function putMessageRows(rows: MessageRow[]): Promise<void> {
  if (rows.length === 0) return;
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(MESSAGES_STORE_NAME, 'readwrite');
    const store = tx.objectStore(MESSAGES_STORE_NAME);
    for (const row of rows) store.put(row);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

export async function getMessageRow(id: string): Promise<MessageRow | null> {
  const db = await openDb();
  const row = await new Promise<MessageRow | null>((resolve, reject) => {
    const tx = db.transaction(MESSAGES_STORE_NAME, 'readonly');
    const req = tx.objectStore(MESSAGES_STORE_NAME).get(id);
    req.onsuccess = () => resolve((req.result as MessageRow | undefined) ?? null);
    req.onerror = () => reject(req.error);
  });
  db.close();
  return row;
}

export async function deleteMessageRow(id: string): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(MESSAGES_STORE_NAME, 'readwrite');
    tx.objectStore(MESSAGES_STORE_NAME).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

/** Bulk delete by explicit id list (message-cache.ts's trim, and
 * clearCachedMessages's "wipe this whole conversation") — one transaction for
 * every id, not one open/close per id. */
export async function deleteMessageRows(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(MESSAGES_STORE_NAME, 'readwrite');
    const store = tx.objectStore(MESSAGES_STORE_NAME);
    for (const id of ids) store.delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

/** Wipes every locally-stored key/session for the CURRENTLY ACTIVE account only —
 * called on logout/device revoke. Deliberately deletes the whole database rather than
 * iterating keys: cheaper, and leaves nothing partially cleaned up if it's interrupted
 * mid-way. Now that each account has its own database (see `dbName`), this is also
 * what makes that safe to call at all on a browser shared by more than one account —
 * it was never able to reach any other account's data even before, but now that's
 * true by construction (a different database entirely), not just by convention. */
export async function wipeCryptoDb(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(dbName());
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    request.onblocked = () => resolve(); // another tab has it open — best effort
  });
}
