'use client';

/**
 * Multi-device message HISTORY sync bootstrap (docs/07-auth-architecture.md's
 * history-key section) — gets this device's raw History Key (HK) into memory
 * (history-key-holder.ts) by whichever path is cheapest and actually available:
 *
 * 1. Already cached locally (wrapped under this device's own local KEK, same
 *    `wrapBytes`/db.ts convention as the identity bundle) — the common case after
 *    the very first bootstrap, no network round trip and no password needed, so
 *    this works on a biometric unlock too.
 * 2. Not cached yet, but we have the password (a real password login/invite
 *    redemption/device-link-complete, never a biometric unlock): fetch the
 *    account's HK from the server and unwrap it, or — if the server doesn't have
 *    one yet either — generate a brand-new one and upload it. Either way, cache
 *    the result locally afterward so step 1 covers every later unlock on this
 *    device.
 * 3. Not cached, no password available (a biometric unlock on a device that
 *    somehow never completed step 1/2 before — shouldn't normally happen, since
 *    biometric unlock can only ever be enabled after at least one password login
 *    already ran on this device): degrade gracefully. This session simply has no
 *    HK — the existing per-device pairwise/group decrypt path is completely
 *    unaffected either way, this is a pure additive fallback.
 */
import { deriveKek, generateKekSalt, wrapBytes, unwrapBytes, bytesToBase64, base64ToBytes } from '@comm/crypto';
import type { UserHistoryKeyResponse } from '@comm/types';
import { apiFetch, ApiError } from '../api-client';
import { getBlob, putBlob } from './db';
import { setCurrentHistoryKey } from './history-key-holder';

const HISTORY_KEY_BLOB_KEY = 'history-key';
const HK_LENGTH = 32;

function randomHistoryKey(): Uint8Array {
  const hk = new Uint8Array(HK_LENGTH);
  crypto.getRandomValues(hk);
  return hk;
}

export async function ensureHistoryKey(localKek: Uint8Array, password: string | null): Promise<void> {
  const cached = await getBlob(HISTORY_KEY_BLOB_KEY);
  if (cached) {
    try {
      setCurrentHistoryKey(unwrapBytes(localKek, cached));
      return;
    } catch {
      // Shouldn't happen (the local KEK that wrapped this is the same one
      // unlocking right now) — fall through and re-bootstrap rather than leaving
      // this session with no HK at all over a corrupted cache entry.
    }
  }

  if (!password) return; // biometric path, nothing cached yet — see module docstring's case 3

  let existing: UserHistoryKeyResponse | null;
  try {
    existing = await apiFetch<UserHistoryKeyResponse>('/api/account/history-key', { method: 'GET' });
  } catch (err) {
    if (err instanceof ApiError && err.code === 'NOT_FOUND') {
      existing = null;
    } else {
      return; // best-effort bootstrap — a network hiccup here shouldn't block sign-in
    }
  }

  let hk: Uint8Array;
  if (existing) {
    const wrapKek = await deriveKek(password, base64ToBytes(existing.salt));
    hk = unwrapBytes(wrapKek, base64ToBytes(existing.wrappedKey));
  } else {
    hk = randomHistoryKey();
    const salt = generateKekSalt();
    const wrapKek = await deriveKek(password, salt);
    const wrappedKey = wrapBytes(wrapKek, hk);
    const canonical = await apiFetch<UserHistoryKeyResponse>('/api/account/history-key', {
      body: { wrappedKey: bytesToBase64(wrappedKey), salt: bytesToBase64(salt) },
    });
    // Lost a race with another of this account's own devices creating one at the
    // same time — adopt the WINNING row rather than the one just generated here
    // (packages/types/src/history.ts's own doc comment on this response).
    if (canonical.wrappedKey !== bytesToBase64(wrappedKey)) {
      const winningKek = await deriveKek(password, base64ToBytes(canonical.salt));
      hk = unwrapBytes(winningKek, base64ToBytes(canonical.wrappedKey));
    }
  }

  await putBlob(HISTORY_KEY_BLOB_KEY, wrapBytes(localKek, hk));
  setCurrentHistoryKey(hk);
}
