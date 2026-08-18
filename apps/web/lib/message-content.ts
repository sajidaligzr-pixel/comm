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
  // `reaction` falls through to plain UTF-8 text just like everything else below —
  // its JSON payload lives in `CachedMessage.text` exactly like a real text message
  // would, which is what lets it ride the entire existing cache/persistence path
  // (message-cache.ts) with zero schema changes. `buildReactionState` below is what
  // gives that JSON blob meaning; nothing renders it as a bubble (both threads filter
  // `contentTypeHint === 'reaction'` out of their visible-message list).
  return { text: bytesToUtf8(plaintext) };
}

/**
 * The plaintext of a `contentTypeHint: 'reaction'` message — never sent as its own
 * bubble, just a small encrypted control message riding the exact multi-device fan-out
 * every other message type already gets (server/modules/messages/service.ts never
 * special-cases it at all: it's just another opaque ciphertext to relay). `emoji: null`
 * means "I'm removing my reaction," not "I'm reacting with nothing" — WhatsApp/Telegram
 * both cap one active reaction per person per message, so there's no separate "which
 * emoji am I removing" to track: a new reaction from the same sender always replaces
 * whatever that sender's previous one was, `buildReactionState` below resolves the full
 * per-message state by keeping only the latest (by `sentAt`) reaction row per sender.
 */
export interface ReactionPayload {
  targetMessageId: string;
  emoji: string | null;
}

export function parseReactionPayload(text: string): ReactionPayload | null {
  try {
    const parsed = JSON.parse(text) as Partial<ReactionPayload>;
    if (typeof parsed.targetMessageId !== 'string') return null;
    if (parsed.emoji !== null && typeof parsed.emoji !== 'string') return null;
    return { targetMessageId: parsed.targetMessageId, emoji: parsed.emoji };
  } catch {
    return null;
  }
}

export interface ReactionSummary {
  emoji: string;
  count: number;
  /** Whether the CURRENT device's user is one of the people behind this emoji's
   * count — drives both the pill's highlighted style and the toggle-off behavior
   * when it's clicked again. */
  mine: boolean;
}

/**
 * Scans every cached message in a conversation (not just the visible ones — reaction
 * rows are cached but never rendered as bubbles) and resolves, per target message, the
 * one currently-active emoji for each sender plus the aggregated pill counts the UI
 * actually renders. Takes the whole `CachedMessage[]` rather than being threaded
 * through the decrypt call sites individually — same reasoning `hasMediaBytes` and
 * `decodeMessagePlaintext` already documented: one shared function both
 * message-thread.tsx and group-message-thread.tsx call, so they can never quietly
 * disagree on how a reaction resolves.
 */
export function buildReactionState(
  messages: Array<{ id: string; senderUserId: string; contentTypeHint: string; text: string; sentAt: string }>,
  currentUserId: string,
): Map<string, { summaries: ReactionSummary[]; mine: string | null }> {
  // Latest (by sentAt) reaction per (targetMessageId, senderUserId) — an older
  // reaction arriving out of order (e.g. via `load older`, or a delayed catch-up
  // fetch racing a live WS event) must never clobber a newer one.
  const latestBySender = new Map<string, Map<string, { emoji: string | null; sentAt: string }>>();
  for (const m of messages) {
    if (m.contentTypeHint !== 'reaction') continue;
    const payload = parseReactionPayload(m.text);
    if (!payload) continue;
    let bySender = latestBySender.get(payload.targetMessageId);
    if (!bySender) {
      bySender = new Map();
      latestBySender.set(payload.targetMessageId, bySender);
    }
    const existing = bySender.get(m.senderUserId);
    if (!existing || new Date(m.sentAt).getTime() >= new Date(existing.sentAt).getTime()) {
      bySender.set(m.senderUserId, { emoji: payload.emoji, sentAt: m.sentAt });
    }
  }

  const result = new Map<string, { summaries: ReactionSummary[]; mine: string | null }>();
  for (const [targetMessageId, bySender] of latestBySender) {
    const counts = new Map<string, number>();
    let mine: string | null = null;
    for (const [senderUserId, { emoji }] of bySender) {
      if (!emoji) continue; // this sender's latest action was a removal
      counts.set(emoji, (counts.get(emoji) ?? 0) + 1);
      if (senderUserId === currentUserId) mine = emoji;
    }
    const summaries: ReactionSummary[] = [...counts.entries()].map(([emoji, count]) => ({
      emoji,
      count,
      mine: emoji === mine,
    }));
    if (summaries.length > 0) result.set(targetMessageId, { summaries, mine });
  }
  return result;
}
