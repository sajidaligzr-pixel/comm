'use client';

/**
 * Multi-device message HISTORY sync — the per-message half (docs/07-auth-architecture.md's
 * history-key section; history-key.ts is the account-level bootstrap this depends
 * on). `syncHistoryEntry` is called from message-thread.tsx/group-message-thread.tsx
 * at every point a message's plaintext becomes known on this device (composing a
 * send, or a live/catch-up decrypt succeeding) — it's what makes that plaintext
 * recoverable later on a device that has no live pairwise/group session for this
 * specific message. `tryDecryptViaHistory` is the read side: the fallback this
 * device reaches for when its normal per-device/group decrypt can't open a
 * message at all.
 */
import { wrapBytes, unwrapBytes, utf8ToBytes, bytesToUtf8, bytesToBase64, base64ToBytes } from '@comm/crypto';
import { apiFetch } from '../api-client';
import { getCurrentHistoryKey } from './history-key-holder';
import type { CachedMessage } from './message-cache';

/** Best-effort, fire-and-forget by every caller — a failed upload here never
 * blocks rendering the message on THIS device; it only means a secondary/future
 * device won't be able to recover this specific message until some other device
 * of this account's own succeeds at writing it instead. */
export async function syncHistoryEntry(message: CachedMessage): Promise<void> {
  const hk = getCurrentHistoryKey();
  if (!hk) return; // no HK this session (e.g. a biometric unlock with nothing cached yet) — skip silently
  try {
    const wrapped = wrapBytes(hk, utf8ToBytes(JSON.stringify(message)));
    await apiFetch(`/api/messages/${message.id}/history-copy`, { body: { ciphertext: bytesToBase64(wrapped) } });
  } catch {
    // See this function's own docstring.
  }
}

/**
 * The stored history ciphertext already IS a full serialized `CachedMessage` (not
 * just raw plaintext bytes) — see `syncHistoryEntry` above — so recovering it is
 * exactly "unwrap, parse," no `decodeMessagePlaintext` step needed the way a live
 * per-device/group decrypt requires. Returns `null` (never throws) on anything
 * short of success — no HK yet, no entry yet, or a malformed/tampered blob — so
 * every call site can treat this exactly like "still can't decrypt on this
 * device," the same honest, non-fatal outcome the live decrypt path already has.
 */
export function tryDecryptViaHistory(historyCiphertextBase64: string | undefined | null): CachedMessage | null {
  if (!historyCiphertextBase64) return null;
  const hk = getCurrentHistoryKey();
  if (!hk) return null;
  try {
    const plaintext = unwrapBytes(hk, base64ToBytes(historyCiphertextBase64));
    return JSON.parse(bytesToUtf8(plaintext)) as CachedMessage;
  } catch {
    return null;
  }
}
