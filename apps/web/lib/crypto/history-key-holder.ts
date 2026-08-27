'use client';

/**
 * In-memory-only holder for the current tab's unwrapped message History Key (HK)
 * — docs/07-auth-architecture.md's history-key section. Mirrors kek-holder.ts
 * exactly (never persisted raw — a page reload clears this, `ensureHistoryKey`
 * in history-key.ts re-derives/re-reads it on the next unlock) even though HK
 * itself, unlike the KEK, IS also persisted locally in wrapped form (db.ts, under
 * the local KEK) — the raw, USABLE key still only ever lives in memory for this
 * tab's lifetime, same bar every other unwrapped secret in this app holds to.
 */
let currentHistoryKey: Uint8Array | null = null;

export function setCurrentHistoryKey(hk: Uint8Array | null): void {
  currentHistoryKey = hk;
}

export function getCurrentHistoryKey(): Uint8Array | null {
  return currentHistoryKey;
}

export function clearCurrentHistoryKey(): void {
  if (currentHistoryKey) currentHistoryKey.fill(0);
  currentHistoryKey = null;
}
