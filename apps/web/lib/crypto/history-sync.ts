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

const BACKFILL_DONE_KEY_PREFIX = 'comm-history-backfill-done__';

/**
 * One-time-per-conversation-per-device backfill closing a real gap in this
 * feature: `message-thread.tsx`/`group-message-thread.tsx`'s own catch-up loop
 * (`if (cachedIds.has(item.id)) continue`) only ever calls `syncHistoryEntry`
 * for a message THIS device *newly* decrypts — anything already sitting in
 * this device's local cache (from before this feature shipped, or just from
 * ordinary earlier use) never gets a `message_history_entries` row written by
 * anyone, so a brand-new device added later genuinely has no path to recover
 * it — not a bug in the new device, a gap in every existing device ever
 * contributing that backlog. Reported live exactly this way: a new device's
 * "old message can't be decrypted."
 *
 * Walks the conversation's already-loaded cache once, guarded by a
 * `localStorage` marker (same direct-localStorage convention every other
 * dismissed/seen flag in this app already uses, e.g. install-prompt.tsx's
 * `DISMISSED_KEY`) so it never re-runs for the same conversation on this
 * device again.
 *
 * Found live, the hard way, on a genuinely large conversation's first pass
 * (mirrors apps/mobile's identical fix — see thread_screen.dart's own
 * backfill helper for the full account): firing each
 * `syncHistoryEntry` call immediately after the previous one resolved — no
 * real delay beyond whatever each call's own network round trip happened to
 * leave — was still enough sustained request volume to saturate a real
 * connection and starve this app's OTHER foreground requests (the message
 * list fetch, delivery-status polling, sending a message) that share the
 * same connection pool, making the whole app feel slow for as long as the
 * backfill kept running, not just this one thread. Two fixes: wait a few
 * seconds after this fires before starting at all (letting the page's own
 * critical-path requests go first), and a real delay between every
 * iteration, not just whatever gap the network happened to leave — both
 * keep this to roughly one request in flight at a time. `writeMessageHistoryEntry`
 * (server/modules/history/service.ts) is a real `upsert` (a write every call,
 * not a cheap existence check) with its own rate limit
 * (`historyEntryWrite`, packages/security/src/rate-limit.ts) besides — the
 * delay stays comfortably under it too. Callers fire this with `void`, same
 * as every individual `syncHistoryEntry` call already is — it's meant to run
 * in the background, taking as long as it needs to, not hold up rendering a
 * long conversation's first open after this ships.
 */
export async function maybeBackfillHistoryEntries(conversationId: string, cached: CachedMessage[]): Promise<void> {
  if (cached.length === 0) return;
  try {
    if (localStorage.getItem(BACKFILL_DONE_KEY_PREFIX + conversationId) !== null) return;
  } catch {
    return; // no localStorage — never mind, same as any other dismissed-flag check in this app
  }
  await new Promise((resolve) => setTimeout(resolve, 5000));
  for (const message of cached) {
    await syncHistoryEntry(message);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  try {
    localStorage.setItem(BACKFILL_DONE_KEY_PREFIX + conversationId, '1');
  } catch {
    // best-effort, same as every other localStorage write in this app
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
