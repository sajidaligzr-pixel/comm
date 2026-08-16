'use client';

/**
 * Raw IndexedDB glue — deliberately NOT cryptographic code (docs/01-folder-structure.md
 * keeps that in packages/crypto). This module only knows how to put/get opaque byte
 * blobs by key in a browser database; every blob it stores has already been wrapped
 * (encrypted) by packages/crypto before it ever reaches here, and this module has no
 * way to make sense of the bytes it's holding. See docs/05-crypto-architecture.md's
 * local key storage section for what those blobs actually are.
 */
const DB_NAME = 'comm-crypto';
const DB_VERSION = 1;
const STORE_NAME = 'wrapped-blobs';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
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

/** Wipes every locally-stored key/session — called on logout/device revoke.
 * Deliberately deletes the whole database rather than iterating keys: cheaper, and
 * leaves nothing partially cleaned up if it's interrupted mid-way. */
export async function wipeCryptoDb(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(DB_NAME);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    request.onblocked = () => resolve(); // another tab has it open — best effort
  });
}
