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

const DB_VERSION = 1;
const STORE_NAME = 'wrapped-blobs';

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
