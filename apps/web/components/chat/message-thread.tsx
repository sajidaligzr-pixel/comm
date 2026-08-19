'use client';

import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import type { MessageDto, MessageDeletionReason, DeviceSummary } from '@comm/types';
import { utf8ToBytes, bytesToBase64 } from '@comm/crypto';
import { cn } from '@/lib/cn';
import { formatBubbleTime, formatDateSeparator, formatRecordingTime, isSameCalendarDay } from '@/lib/format';
import { apiFetch, ApiError } from '@/lib/api-client';
import { encryptForDevice, decryptFromDeviceOnce } from '@/lib/crypto/conversation-crypto';
import { getCurrentKek } from '@/lib/crypto/kek-holder';
import {
  loadCachedMessages,
  appendCachedMessage,
  prependCachedMessages,
  removeCachedMessage,
  markCachedMessageDeleted,
  type CachedMessage,
} from '@/lib/crypto/message-cache';
import { connectRealtime, onRealtimeEvent, sendRealtimeEvent } from '@/lib/realtime-client';
import {
  decodeMessagePlaintext,
  deletedPlaceholderText,
  buildReactionState,
  messageMatchesSearch,
  splitForHighlight,
  type AttachmentDescriptor,
  type ReactionPayload,
} from '@/lib/message-content';
import { encryptAttachment } from '@/lib/crypto/attachment-crypto';
import { uploadAttachmentCiphertext } from '@/lib/media-client';
import { EmojiPicker } from './emoji-picker';
import { ForwardDialog } from './forward-dialog';
import { VoiceBubble, ImageBubble, FileBubble } from './bubbles';
import {
  IconSend,
  IconCheck,
  IconCheckDouble,
  IconClock,
  IconMic,
  IconTrash,
  IconReply,
  IconForward,
  IconX,
  IconMoreVertical,
  IconChevronUp,
  IconChevronDown,
  IconImage,
  IconPaperclip,
  IconSearch,
} from '../icons';

interface DeliveryStatus {
  delivered: boolean;
  read: boolean;
}

const MAX_RECORDING_SECONDS = 120;

// Kept comfortably under `MessageEnvelopeUpload`'s 4 MiB base64 ciphertext cap
// (packages/types/src/messages.ts) — base64 expands bytes by ~4/3, and the AEAD
// envelope adds a small fixed overhead on top, so the raw plaintext ceiling needs
// real margin under 3 MiB, not right up against it.
const MAX_IMAGE_BYTES = 2.5 * 1024 * 1024;
const MAX_IMAGE_DIMENSION = 1600;

/**
 * Downscales and re-encodes a picked image to JPEG entirely client-side before it
 * ever gets encrypted — this is what lets images ride the exact same inline-ciphertext
 * path voice messages already use (no object storage, no signed uploads) rather than
 * needing Phase 4's real media pipeline. A deliberate, narrow slice: this sends the
 * photo itself, not a general file-attachment system (no non-image files, no
 * originals-preserved-losslessly guarantee — the whole point is fitting through a
 * field sized for a two-minute voice note). Retries at lower quality before giving up,
 * since `canvas.toBlob`'s quality knob is a request, not a guaranteed output size.
 */
async function compressImageForSend(file: File): Promise<Uint8Array> {
  const bitmap = await createImageBitmap(file);
  try {
    const scale = Math.min(1, MAX_IMAGE_DIMENSION / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas is unavailable in this browser.');
    ctx.drawImage(bitmap, 0, 0, width, height);

    for (const quality of [0.75, 0.5, 0.35]) {
      const blob: Blob = await new Promise((resolve, reject) => {
        canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not encode image.'))), 'image/jpeg', quality);
      });
      if (blob.size <= MAX_IMAGE_BYTES) {
        return new Uint8Array(await blob.arrayBuffer());
      }
    }
    throw new Error('This photo is too large to send even after compression.');
  } finally {
    bitmap.close();
  }
}

export function MessageThread({
  conversationId,
  currentUserId,
  otherUserId,
  otherDisplayName,
  disappearingTimerMs,
}: {
  conversationId: string;
  currentUserId: string;
  otherUserId: string;
  otherDisplayName: string;
  /** `null` = disappearing messages off. Server-side enforcement (the actual
   * ciphertext erasure) is apps/worker's hourly sweep; this is what makes it feel
   * immediate on whichever device has the thread open, by tombstoning locally-cached
   * messages the moment they cross the threshold rather than waiting for that sweep. */
  disappearingTimerMs: number | null;
}): React.JSX.Element {
  const [messages, setMessages] = useState<CachedMessage[]>([]);
  const [status, setStatus] = useState<Record<string, DeliveryStatus>>({});
  const [pendingIds, setPendingIds] = useState<Set<string>>(new Set());
  const [otherTyping, setOtherTyping] = useState(false);
  const [text, setText] = useState('');
  const [error, setError] = useState<string | undefined>();
  const [ready, setReady] = useState(false);
  const [replyingTo, setReplyingTo] = useState<CachedMessage | null>(null);
  const [forwardingMessage, setForwardingMessage] = useState<CachedMessage | null>(null);
  const [activeMenuId, setActiveMenuId] = useState<string | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [recordingSeconds, setRecordingSeconds] = useState(0);
  const [sendingImage, setSendingImage] = useState(false);
  const [sendingFile, setSendingFile] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchIndex, setSearchIndex] = useState(0);

  const scrollRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const bubbleRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  // Every device an outgoing message needs its own independently-encrypted envelope
  // for — the other member's active devices, plus the caller's own other active
  // devices (self-fan-out — a second phone, a desktop client, a web tab left open
  // elsewhere). Refreshed on every load, same timing as the old single-device ref
  // this replaced; a device that comes online mid-thread is picked up the next time
  // this effect reruns (conversation reopen), not mid-session — an acceptable,
  // bounded staleness window, same one the old ref already had.
  const targetDeviceIdsRef = useRef<Array<{ userId: string; deviceId: string }>>([]);
  const typingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const recordedChunksRef = useRef<Blob[]>([]);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const recordingIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const skipNextAutoScrollRef = useRef(false);
  const messagesRef = useRef(messages);
  const statusRef = useRef(status);

  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);
  useEffect(() => {
    statusRef.current = status;
  }, [status]);

  // `reaction` rows live in the same cached `messages` array as everything else
  // (see lib/message-content.ts's module docstring) but are never rendered as
  // bubbles — `visibleMessages` below is what the thread actually maps over,
  // while this resolves each real message's current reaction pills from the
  // full array, reactions included.
  const visibleMessages = messages.filter((m) => m.contentTypeHint !== 'reaction');
  const reactionState = useMemo(() => buildReactionState(messages, currentUserId), [messages, currentUserId]);

  /** Tapping a pill (or picking an emoji from the react trigger) toggles: the same
   * emoji you already reacted with removes it, any other emoji (including a first
   * reaction) replaces it — matches Telegram/WhatsApp's one-reaction-per-person
   * model. Goes through the exact same `sendEncrypted` every other content type
   * uses, so it gets full multi-device fan-out for free and needs no dedicated
   * server route at all. */
  async function handleReact(targetMessageId: string, emoji: string) {
    setActiveMenuId(null);
    const mine = reactionState.get(targetMessageId)?.mine ?? null;
    const next = mine === emoji ? null : emoji;
    const payload: ReactionPayload = { targetMessageId, emoji: next };
    await sendEncrypted({ contentTypeHint: 'reaction', plaintext: utf8ToBytes(JSON.stringify(payload)) });
  }

  // In-chat search (lib/message-content.ts's `messageMatchesSearch` docstring on
  // why this is a plain linear scan, not a real index) — matches in chronological
  // order (oldest first), so the LAST entry is the most recent match, which is
  // where a fresh query jumps by default, same as WhatsApp's own in-chat search.
  const normalizedSearchQuery = searchQuery.trim().toLowerCase();
  const searchMatches = useMemo(
    () => visibleMessages.filter((m) => messageMatchesSearch(m, normalizedSearchQuery)).map((m) => m.id),
    [visibleMessages, normalizedSearchQuery],
  );
  useEffect(() => {
    setSearchIndex(searchMatches.length > 0 ? searchMatches.length - 1 : 0);
    // Deliberately keyed on the query text, not `searchMatches` itself — jumping
    // back to "most recent" every time a NEW message happens to match the
    // already-typed query would yank the user away from wherever they were
    // browsing to.
  }, [normalizedSearchQuery]);
  useEffect(() => {
    if (!searchOpen) return;
    const id = searchMatches[searchIndex];
    if (id) bubbleRefs.current.get(id)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [searchOpen, searchIndex, searchMatches]);

  function closeSearch() {
    setSearchOpen(false);
    setSearchQuery('');
  }

  // Local, immediate enforcement of the disappearing-message timer — checked on
  // mount/timer-change and then periodically, not just once, since a message can
  // cross the threshold while the thread stays open. apps/worker's hourly sweep is
  // what actually erases the ciphertext server-side and reaches devices that don't
  // have this thread open; this is what makes it feel instant on this one.
  useEffect(() => {
    if (!disappearingTimerMs) return;

    function pruneExpired() {
      const kek = getCurrentKek();
      if (!kek) return;
      const now = Date.now();
      const expiredIds = messagesRef.current
        .filter((m) => !m.deleted && now - new Date(m.sentAt).getTime() > disappearingTimerMs!)
        .map((m) => m.id);
      if (expiredIds.length === 0) return;
      void (async () => {
        let updated = messagesRef.current;
        for (const id of expiredIds) {
          updated = await markCachedMessageDeleted(kek, conversationId, id, 'disappearing_timer');
        }
        setMessages(updated);
      })();
    }

    pruneExpired();
    const interval = setInterval(pruneExpired, 30_000);
    return () => clearInterval(interval);
  }, [disappearingTimerMs, conversationId]);

  // Belt-and-suspenders for the live 'delivered'/'read' WS listeners below — found
  // live, reported directly: both the mobile and web clients open on the same
  // conversation, a message sent from this device sat on a single tick with no
  // live update at all, only catching up once the thread was closed and reopened
  // (which forces the full `load()` above, reseeding `status` from a fresh REST
  // fetch). Whatever gap let that one WS frame go missing, this guarantees
  // convergence within one poll interval regardless — a light re-check of just
  // this device's own messages' delivered/read flags, not a full reload (decrypt
  // included) of the whole thread. Skips the network round trip entirely once
  // there's nothing left to wait on (every own message already read), so an
  // idle-but-open thread doesn't poll forever for no reason.
  useEffect(() => {
    // Sync wrapper around the actual async work — same idiom as pruneExpired above
    // (setInterval's callback type is void-returning; an async function handed to
    // it directly trips @typescript-eslint/no-misused-promises).
    function poll() {
      const hasPending = messagesRef.current.some((m) => m.isOwn && !statusRef.current[m.id]?.read);
      if (!hasPending) return;
      void (async () => {
        try {
          const page = await apiFetch<{ items: MessageDto[]; nextCursor: string | null }>(
            `/api/conversations/${conversationId}/messages?limit=50`,
          );
          const next: Record<string, DeliveryStatus> = {};
          for (const item of page.items) {
            if (item.senderUserId !== currentUserId) continue;
            next[item.id] = { delivered: !!item.deliveredAt, read: !!item.readAt };
          }
          setStatus((prev) => ({ ...prev, ...next }));
        } catch {
          // Best-effort — the next tick, a live WS event, or a full reload catches up.
        }
      })();
    }
    const interval = setInterval(poll, 8_000);
    return () => clearInterval(interval);
  }, [conversationId, currentUserId]);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      const kek = getCurrentKek();
      if (!kek) {
        setError('This device is locked. Please sign in again.');
        return;
      }

      const cached = await loadCachedMessages(kek, conversationId);
      if (!cancelled) setMessages(cached);

      const [otherMemberDevices, ownDevices] = await Promise.all([
        apiFetch<Array<{ userId: string; deviceId: string }>>(`/api/conversations/${conversationId}/recipient-devices`),
        apiFetch<DeviceSummary[]>('/api/devices'),
      ]);
      const ownOtherDevices = ownDevices
        .filter((d) => !d.isCurrentDevice && d.status === 'active')
        .map((d) => ({ userId: currentUserId, deviceId: d.id }));
      targetDeviceIdsRef.current = [...otherMemberDevices, ...ownOtherDevices];

      // Catch up on anything this device hasn't decrypted yet — Double Ratchet
      // message keys are single-use, so this is a one-shot "first look" at each
      // ciphertext, not a re-readable archive (lib/crypto/message-cache.ts).
      const page = await apiFetch<{ items: MessageDto[]; nextCursor: string | null }>(
        `/api/conversations/${conversationId}/messages?limit=50`,
      );
      const cachedIds = new Set(cached.map((m) => m.id));
      const seededStatus: Record<string, DeliveryStatus> = {};
      let latest = cached;
      for (const item of page.items) {
        if (item.senderUserId === currentUserId) {
          // Own outgoing message — already durably cached from when it was sent, so
          // there's nothing to decrypt; just seed its delivered/read state, which
          // otherwise wouldn't be known again until a NEW live WS event arrives.
          seededStatus[item.id] = { delivered: !!item.deliveredAt, read: !!item.readAt };
          continue;
        }
        if (cachedIds.has(item.id)) continue;
        try {
          const plaintext = await decryptFromDeviceOnce(item.id, item.senderDeviceId, item.envelope, item.x3dhInit);
          latest = await appendCachedMessage(kek, {
            id: item.id,
            conversationId,
            senderUserId: item.senderUserId,
            isOwn: false,
            contentTypeHint: item.contentTypeHint,
            ...decodeMessagePlaintext(item.contentTypeHint, plaintext),
            sentAt: item.sentAt,
            replyToMessageId: item.replyToMessageId,
          });
        } catch {
          // Undecryptable on this device (e.g. sent to a different device before
          // this one existed) — skipped rather than shown as an error; an honest
          // Phase 3 limitation of the per-device session model, not a bug.
        }
      }
      if (!cancelled) {
        setMessages(latest);
        setStatus((prev) => ({ ...seededStatus, ...prev }));
        setNextCursor(page.nextCursor);
        setReady(true);
      }

      // Mark read up through whatever's newest, same as the live 'new' handler does
      // immediately for a message that arrives while this thread is already open —
      // this catch-up path is the ONLY other place a message a device hasn't acked
      // yet gets shown to the user (opening the app/thread after being offline when
      // it was sent), and until this call existed here it was the one gap: a
      // recipient could fully read a message this way and the sender's ticks would
      // still sit at "sent" forever, since `message.ack`/`message.read` were only
      // ever fired from the live-arrival path (found in security-review regression
      // testing). Uses the REST route rather than a WS send for the same reason the
      // group key-share fix does — this runs right after `connectRealtime()` is
      // kicked off below, before the socket is necessarily open yet.
      if (page.items.length > 0) {
        apiFetch(`/api/conversations/${conversationId}/read`, {
          method: 'POST',
          body: { upToMessageId: page.items[0]!.id },
        }).catch(() => undefined);
      }
    }

    void load();
    connectRealtime();

    const offNew = onRealtimeEvent('new', (payload) => {
      const message = payload.message as MessageDto;
      if (message.conversationId !== conversationId || message.senderUserId === currentUserId) return;
      void (async () => {
        const kek = getCurrentKek();
        if (!kek) return;
        try {
          const plaintext = await decryptFromDeviceOnce(message.id, message.senderDeviceId, message.envelope, message.x3dhInit);
          const updated = await appendCachedMessage(kek, {
            id: message.id,
            conversationId,
            senderUserId: message.senderUserId,
            isOwn: false,
            contentTypeHint: message.contentTypeHint,
            ...decodeMessagePlaintext(message.contentTypeHint, plaintext),
            sentAt: message.sentAt,
            replyToMessageId: message.replyToMessageId,
          });
          setMessages(updated);
          // REST, not sendRealtimeEvent — same "don't leave a fragile WS-only path"
          // reasoning as the catch-up loop above and the group key-share fix before
          // it: the socket being open at the instant this 'new' event arrived doesn't
          // guarantee it's still open a few `await`s later when these fire, and
          // there's no retry if it isn't. Both routes still publish the same live WS
          // event to the sender either way (server/realtime/bus.ts) — this only
          // changes how the ack itself gets *to* the server, not what happens after.
          apiFetch(`/api/messages/${message.id}/delivered`, { method: 'POST' }).catch(() => undefined);
          apiFetch(`/api/conversations/${conversationId}/read`, {
            method: 'POST',
            body: { upToMessageId: message.id },
          }).catch(() => undefined);
        } catch {
          // See the catch-up loop's note above.
        }
      })();
    });

    const offDelivered = onRealtimeEvent('delivered', (payload) => {
      const messageId = payload.messageId as string;
      setStatus((prev) => ({ ...prev, [messageId]: { delivered: true, read: prev[messageId]?.read ?? false } }));
    });
    const offRead = onRealtimeEvent('read', (payload) => {
      if (payload.conversationId !== conversationId) return;
      setStatus((prev) => {
        const next = { ...prev };
        next[payload.upToMessageId as string] = { delivered: true, read: true };
        return next;
      });
    });
    const offTypingStart = onRealtimeEvent('typing', (payload) => {
      if (payload.conversationId !== conversationId || payload.fromUserId !== otherUserId) return;
      setOtherTyping(payload.state === 'start');
    });
    const offDeleted = onRealtimeEvent('deleted', (payload) => {
      if (payload.conversationId !== conversationId) return;
      void (async () => {
        const kek = getCurrentKek();
        if (!kek) return;
        const reason = payload.reason as MessageDeletionReason | undefined;
        const updated = await markCachedMessageDeleted(kek, conversationId, payload.messageId as string, reason);
        setMessages(updated);
      })();
    });

    return () => {
      cancelled = true;
      offNew();
      offDelivered();
      offRead();
      offTypingStart();
      offDeleted();
    };
    // Deliberately keyed on conversationId alone — currentUserId/otherUserId are
    // stable for the lifetime of a mounted thread, and including them would just
    // add no-op re-subscriptions.
  }, [conversationId]);

  useEffect(() => {
    if (skipNextAutoScrollRef.current) {
      skipNextAutoScrollRef.current = false;
      return;
    }
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length]);

  useEffect(() => {
    return () => {
      // Unmounting mid-recording (e.g. navigating away) must still release the mic.
      mediaStreamRef.current?.getTracks().forEach((t) => t.stop());
      if (recordingIntervalRef.current) clearInterval(recordingIntervalRef.current);
    };
  }, []);

  function notifyTyping(state: 'start' | 'stop') {
    sendRealtimeEvent({ type: `typing.${state}`, conversationId });
  }

  function handleInputChange(value: string) {
    setText(value);
    if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current);
    notifyTyping('start');
    typingTimeoutRef.current = setTimeout(() => notifyTyping('stop'), 2000);
  }

  /** Shared by text, voice, image, and file sends: encrypt, render optimistically
   * right away (WhatsApp-style instant bubble with a clock icon), POST, and roll the
   * optimistic bubble back out of the local cache if the send actually fails. */
  async function sendEncrypted(opts: {
    contentTypeHint: 'text' | 'voice' | 'image' | 'media' | 'reaction';
    plaintext: Uint8Array;
    draftText?: string;
    mediaDurationSec?: number;
    /** Only for `contentTypeHint: 'media'` — links this send to an
     * already-uploaded object (docs/13-roadmap.md's media pass). */
    attachment?: { objectKey: string; encryptedSizeBytes: number };
  }) {
    setError(undefined);
    const kek = getCurrentKek();
    if (!kek) {
      setError('This device is locked. Please sign in again.');
      return;
    }
    const targets = targetDeviceIdsRef.current;
    if (targets.length === 0) {
      setError('This contact has no active device to message yet.');
      return;
    }

    const messageId = crypto.randomUUID();
    const replyToMessageId = replyingTo?.id ?? null;
    setReplyingTo(null);

    try {
      // One independent envelope per target device (the other member's active
      // devices, and the caller's own other active devices) — real multi-device
      // sync, not just delivery to whichever single device used to be guessed as
      // "primary." `encryptForDevice` is safe to call any number of times; each call
      // either reuses that device's already-established ratchet session or runs a
      // fresh X3DH handshake against its published bundle first.
      const recipients = await Promise.all(
        targets.map(async (t) => {
          const { envelope, x3dhInit } = await encryptForDevice(t.userId, t.deviceId, opts.plaintext);
          return { deviceId: t.deviceId, envelope, x3dhInit };
        }),
      );
      const sentAt = new Date().toISOString();

      setPendingIds((prev) => new Set(prev).add(messageId));
      const decoded = decodeMessagePlaintext(opts.contentTypeHint, opts.plaintext);
      const optimistic: CachedMessage = {
        id: messageId,
        conversationId,
        senderUserId: currentUserId,
        isOwn: true,
        contentTypeHint: opts.contentTypeHint,
        text: opts.draftText ?? decoded.text,
        mediaBase64: decoded.mediaBase64,
        attachment: decoded.attachment,
        mediaDurationSec: opts.mediaDurationSec,
        sentAt,
        replyToMessageId,
      };
      setMessages(await appendCachedMessage(kek, optimistic));

      await apiFetch(`/api/conversations/${conversationId}/messages`, {
        method: 'POST',
        body: {
          messageId,
          envelopeType: 'x3dh_ratchet_1to1',
          recipients,
          contentTypeHint: opts.contentTypeHint,
          replyToMessageId,
          sentAt,
          attachment: opts.attachment,
        },
      });
    } catch (err) {
      const kek2 = getCurrentKek();
      if (kek2) setMessages(await removeCachedMessage(kek2, conversationId, messageId));
      // Was `err instanceof ApiError ? err.message : 'Could not send that message.'` — any
      // failure that wasn't a server-returned ApiError (a local encryption error, a plain
      // network failure, anything thrown before the request even went out) collapsed into
      // one generic string with no way to tell which. group-message-thread.tsx already
      // surfaces the real `Error#message` for this exact case; this brings the 1:1 path in
      // line with it, and is what actually revealed the real cause here rather than
      // guessing further from the outside.
      setError(err instanceof ApiError ? err.message : err instanceof Error ? err.message : 'Could not send that message.');
      if (opts.draftText !== undefined) setText(opts.draftText); // give the user their draft back
    } finally {
      setPendingIds((prev) => {
        const next = new Set(prev);
        next.delete(messageId);
        return next;
      });
    }
  }

  async function handleSend(e: FormEvent) {
    e.preventDefault();
    const trimmed = text.trim();
    if (!trimmed || isRecording) return;
    setText('');
    if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current);
    notifyTyping('stop');
    await sendEncrypted({ contentTypeHint: 'text', plaintext: utf8ToBytes(trimmed), draftText: trimmed });
  }

  async function handleLoadOlder() {
    if (!nextCursor || loadingOlder) return;
    setLoadingOlder(true);
    const kek = getCurrentKek();
    const container = scrollRef.current;
    const prevScrollHeight = container?.scrollHeight ?? 0;
    try {
      if (!kek) return;
      const page = await apiFetch<{ items: MessageDto[]; nextCursor: string | null }>(
        `/api/conversations/${conversationId}/messages?limit=50&cursor=${nextCursor}`,
      );
      const knownIds = new Set(messages.map((m) => m.id));
      const additions: CachedMessage[] = [];
      for (const item of page.items) {
        if (item.senderUserId === currentUserId || knownIds.has(item.id)) continue;
        try {
          const plaintext = await decryptFromDeviceOnce(item.id, item.senderDeviceId, item.envelope, item.x3dhInit);
          additions.push({
            id: item.id,
            conversationId,
            senderUserId: item.senderUserId,
            isOwn: false,
            contentTypeHint: item.contentTypeHint,
            ...decodeMessagePlaintext(item.contentTypeHint, plaintext),
            sentAt: item.sentAt,
            replyToMessageId: item.replyToMessageId,
          });
        } catch {
          // See the initial catch-up loop's note.
        }
      }
      skipNextAutoScrollRef.current = true;
      setMessages(await prependCachedMessages(kek, conversationId, additions));
      setNextCursor(page.nextCursor);
      requestAnimationFrame(() => {
        if (container) container.scrollTop = container.scrollHeight - prevScrollHeight;
      });
    } finally {
      setLoadingOlder(false);
    }
  }

  async function handleImageSelected(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ''; // allow picking the exact same file again later
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      setError('That file is not an image.');
      return;
    }
    setError(undefined);
    setSendingImage(true);
    try {
      const bytes = await compressImageForSend(file);
      await sendEncrypted({ contentTypeHint: 'image', plaintext: bytes });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not send that photo.');
    } finally {
      setSendingImage(false);
    }
  }

  /**
   * General file attachments (docs/13-roadmap.md's media pass) — unlike voice/image,
   * this doesn't fit through the inline-ciphertext trick (no compression, arbitrary
   * types/sizes), so it goes through the real object-storage pipeline: encrypt
   * client-side (attachment-crypto.ts), upload the ciphertext (media-client.ts), then
   * send only a small descriptor `{objectKey, key, nonce, mimeType, fileName,
   * sizeBytes}` through the exact same E2E envelope every other message uses — the
   * server never sees the file's real name, type, or content.
   */
  async function handleFileSelected(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setError(undefined);
    setSendingFile(true);
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const { ciphertext, key, nonce } = await encryptAttachment(bytes);
      const { objectKey, encryptedSizeBytes } = await uploadAttachmentCiphertext(ciphertext);
      const descriptor: AttachmentDescriptor = {
        objectKey,
        key: bytesToBase64(key),
        nonce: bytesToBase64(nonce),
        mimeType: file.type || 'application/octet-stream',
        fileName: file.name,
        sizeBytes: file.size,
      };
      await sendEncrypted({
        contentTypeHint: 'media',
        plaintext: utf8ToBytes(JSON.stringify(descriptor)),
        attachment: { objectKey, encryptedSizeBytes },
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not send that file.');
    } finally {
      setSendingFile(false);
    }
  }

  async function handleDelete(messageId: string) {
    setActiveMenuId(null);
    // A lightweight native confirm is enough for a destructive-but-recoverable
    // (the other side can just be told/resent) action — not worth a custom modal.
    if (!window.confirm('Delete this message for everyone?')) return;
    try {
      await apiFetch(`/api/messages/${messageId}`, { method: 'DELETE' });
      const kek = getCurrentKek();
      if (kek) setMessages(await markCachedMessageDeleted(kek, conversationId, messageId, 'manual'));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not delete that message.');
    }
  }

  async function startRecording() {
    setError(undefined);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : 'audio/webm';
      // Voice doesn't need music-grade bitrate — this keeps a 2-minute note well
      // under the server's size ceiling (packages/types's `MessageEnvelopeUpload`)
      // with comfortable margin, not just relying on that ceiling as the only guard.
      // `audioBitsPerSecond` is a hint, not a guarantee (a browser may ignore it),
      // which is exactly why the server-side cap still exists independently.
      const recorder = new MediaRecorder(stream, { mimeType, audioBitsPerSecond: 32_000 });
      recordedChunksRef.current = [];
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) recordedChunksRef.current.push(e.data);
      };
      recorder.start();
      mediaRecorderRef.current = recorder;
      mediaStreamRef.current = stream;
      setIsRecording(true);
      setRecordingSeconds(0);
      recordingIntervalRef.current = setInterval(() => {
        setRecordingSeconds((s) => {
          if (s + 1 >= MAX_RECORDING_SECONDS) {
            void handleStopAndSendRecording();
          }
          return s + 1;
        });
      }, 1000);
    } catch {
      setError('Microphone access was denied — check your browser permissions to send a voice message.');
    }
  }

  function teardownRecording() {
    if (recordingIntervalRef.current) clearInterval(recordingIntervalRef.current);
    recordingIntervalRef.current = null;
    mediaStreamRef.current?.getTracks().forEach((t) => t.stop());
    mediaStreamRef.current = null;
    mediaRecorderRef.current = null;
    setIsRecording(false);
    setRecordingSeconds(0);
  }

  function stopRecordingInternal(): Promise<Blob | null> {
    return new Promise((resolve) => {
      const recorder = mediaRecorderRef.current;
      if (!recorder || recorder.state === 'inactive') {
        resolve(null);
        return;
      }
      recorder.onstop = () => resolve(new Blob(recordedChunksRef.current, { type: recorder.mimeType }));
      recorder.stop();
    });
  }

  async function handleStopAndSendRecording() {
    const durationSec = recordingSeconds;
    const blob = await stopRecordingInternal();
    teardownRecording();
    if (!blob || blob.size === 0) return;
    const bytes = new Uint8Array(await blob.arrayBuffer());
    await sendEncrypted({ contentTypeHint: 'voice', plaintext: bytes, mediaDurationSec: durationSec });
  }

  function handleCancelRecording() {
    const recorder = mediaRecorderRef.current;
    if (recorder && recorder.state !== 'inactive') {
      recorder.onstop = null;
      recorder.stop();
    }
    teardownRecording();
  }

  function ticksFor(m: CachedMessage): React.JSX.Element | null {
    if (!m.isOwn) return null;
    if (pendingIds.has(m.id)) return <IconClock className="h-3.5 w-3.5 opacity-70" />;
    if (status[m.id]?.read) return <IconCheckDouble className="h-3.5 w-3.5 text-sky-400" />;
    if (status[m.id]?.delivered) return <IconCheckDouble className="h-3.5 w-3.5 opacity-70" />;
    return <IconCheck className="h-3.5 w-3.5 opacity-70" />;
  }

  return (
    <div className="relative flex h-full min-h-0 flex-col bg-muted/20">
      {!searchOpen && (
        <button
          type="button"
          onClick={() => setSearchOpen(true)}
          aria-label="Search in this chat"
          className="absolute right-3 top-2 z-10 flex h-8 w-8 items-center justify-center rounded-full bg-background text-muted-foreground shadow-sm hover:text-foreground"
        >
          <IconSearch className="h-4 w-4" />
        </button>
      )}
      {searchOpen && (
        <div className="flex flex-shrink-0 items-center gap-1 border-b border-border bg-background px-3 py-2">
          <IconSearch className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
          <input
            autoFocus
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') closeSearch();
              if (e.key === 'Enter') setSearchIndex((i) => Math.max(0, i - 1));
            }}
            placeholder="Search in this chat"
            aria-label="Search in this chat"
            className="h-8 min-w-0 flex-1 bg-transparent px-1 text-sm text-foreground outline-none placeholder:text-muted-foreground"
          />
          <span className="flex-shrink-0 text-xs tabular-nums text-muted-foreground">
            {normalizedSearchQuery ? `${searchMatches.length > 0 ? searchIndex + 1 : 0} / ${searchMatches.length}` : ''}
          </span>
          <button
            type="button"
            onClick={() => setSearchIndex((i) => Math.max(0, i - 1))}
            disabled={searchMatches.length === 0}
            aria-label="Previous match (older)"
            className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40"
          >
            <IconChevronUp className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={() => setSearchIndex((i) => Math.min(searchMatches.length - 1, i + 1))}
            disabled={searchMatches.length === 0}
            aria-label="Next match (newer)"
            className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40"
          >
            <IconChevronDown className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={closeSearch}
            aria-label="Close search"
            className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <IconX className="h-4 w-4" />
          </button>
        </div>
      )}
      <div ref={scrollRef} className="min-h-0 flex-1 space-y-0.5 overflow-y-auto py-3 pl-2 pr-3 sm:px-6">
        {!ready && <p className="text-center text-sm text-muted-foreground">Loading…</p>}
        {ready && nextCursor && (
          <div className="flex justify-center pb-2">
            <button
              type="button"
              onClick={() => void handleLoadOlder()}
              disabled={loadingOlder}
              className="flex items-center gap-1 rounded-full bg-background px-3 py-1.5 text-xs font-medium text-muted-foreground shadow-sm hover:text-foreground disabled:opacity-60"
            >
              <IconChevronUp className="h-3.5 w-3.5" />
              {loadingOlder ? 'Loading…' : 'Load earlier messages'}
            </button>
          </div>
        )}
        {ready && visibleMessages.length === 0 && (
          <p className="py-8 text-center text-sm text-muted-foreground">
            No messages yet. Say hello to {otherDisplayName}.
          </p>
        )}
        {visibleMessages.map((m, i) => {
          const prev = visibleMessages[i - 1];
          const showDateSeparator = !prev || !isSameCalendarDay(prev.sentAt, m.sentAt);
          const grouped =
            !showDateSeparator &&
            prev &&
            prev.isOwn === m.isOwn &&
            new Date(m.sentAt).getTime() - new Date(prev.sentAt).getTime() < 5 * 60_000;
          const replySource = m.replyToMessageId ? messages.find((mm) => mm.id === m.replyToMessageId) : undefined;
          const reactions = reactionState.get(m.id)?.summaries ?? [];
          const isActiveSearchMatch = searchOpen && searchMatches[searchIndex] === m.id;

          return (
            <div
              key={m.id}
              ref={(el) => {
                if (el) bubbleRefs.current.set(m.id, el);
                else bubbleRefs.current.delete(m.id);
              }}
            >
              {showDateSeparator && (
                <div className="flex justify-center py-2">
                  <span className="rounded-full bg-background px-3 py-1 text-xs font-medium text-muted-foreground shadow-sm">
                    {formatDateSeparator(m.sentAt)}
                  </span>
                </div>
              )}
              <div className={cn('group flex', m.isOwn ? 'justify-end' : 'justify-start', grouped ? 'mt-0.5' : 'mt-2.5')}>
                <div className={cn('flex min-w-0 max-w-[80%] items-end gap-1 sm:max-w-[70%]', m.isOwn && 'flex-row-reverse')}>
                  <div
                    className={cn(
                      // min-w-0 here is the real fix: without it, this bubble's
                      // automatic minimum width defaults to its content's intrinsic
                      // size — for a voice note (min-w-[10rem]) or file attachment
                      // (min-w-[12rem]), that's wide enough to blow past the row's
                      // own max-w-[85%] cap on a narrow phone, pushing the bubble
                      // off the right edge of the screen entirely. Same root cause,
                      // same fix shape as the message-input min-w-0 fix above.
                      'relative min-w-0 rounded-2xl px-3 py-2 text-sm shadow-sm',
                      m.isOwn ? 'bg-primary text-primary-foreground' : 'bg-background text-foreground',
                      m.isOwn ? (grouped ? 'rounded-tr-md' : 'rounded-tr-sm') : grouped ? 'rounded-tl-md' : 'rounded-tl-sm',
                      isActiveSearchMatch && 'ring-2 ring-yellow-400',
                    )}
                  >
                    {!m.deleted && replySource && (
                      <div
                        className={cn(
                          'mb-1.5 rounded-lg border-l-2 px-2 py-1 text-xs opacity-80',
                          m.isOwn ? 'border-primary-foreground/60 bg-black/10' : 'border-primary bg-muted',
                        )}
                      >
                        <p className="font-medium">{replySource.isOwn ? 'You' : otherDisplayName}</p>
                        <p className="truncate">
                          {replySource.deleted
                            ? deletedPlaceholderText(replySource.contentTypeHint, replySource.deletedReason)
                            : replySource.contentTypeHint === 'voice'
                              ? '🎤 Voice message'
                              : replySource.contentTypeHint === 'image'
                                ? '📷 Photo'
                                : replySource.contentTypeHint === 'media'
                                  ? `📄 ${replySource.attachment?.fileName ?? 'File'}`
                                  : replySource.text}
                        </p>
                      </div>
                    )}

                    {m.deleted ? (
                      <p className="flex items-center gap-1 italic text-muted-foreground">
                        <IconTrash className="h-3.5 w-3.5" /> {deletedPlaceholderText(m.contentTypeHint, m.deletedReason)}
                      </p>
                    ) : m.contentTypeHint === 'voice' && m.mediaBase64 ? (
                      <VoiceBubble base64={m.mediaBase64} durationHint={m.mediaDurationSec} isOwn={m.isOwn} />
                    ) : m.contentTypeHint === 'image' && m.mediaBase64 ? (
                      <ImageBubble base64={m.mediaBase64} />
                    ) : m.contentTypeHint === 'media' && m.attachment ? (
                      <FileBubble attachment={m.attachment} isOwn={m.isOwn} />
                    ) : (
                      <p className="whitespace-pre-wrap break-words">
                        {searchOpen && normalizedSearchQuery
                          ? splitForHighlight(m.text, normalizedSearchQuery).map((seg, segIndex) =>
                              seg.matched ? (
                                <mark key={segIndex} className="rounded bg-yellow-300/80 text-foreground">
                                  {seg.text}
                                </mark>
                              ) : (
                                <span key={segIndex}>{seg.text}</span>
                              ),
                            )
                          : m.text}
                      </p>
                    )}

                    <p
                      className={cn(
                        'mt-0.5 flex items-center justify-end gap-1 text-[10px]',
                        m.isOwn ? 'text-primary-foreground/70' : 'text-muted-foreground',
                      )}
                    >
                      {formatBubbleTime(m.sentAt)}
                      {ticksFor(m)}
                    </p>

                    {reactions.length > 0 && (
                      <div
                        className={cn(
                          'absolute -bottom-3 flex gap-0.5 rounded-full border border-border bg-background px-1 py-0.5 shadow-sm',
                          m.isOwn ? 'right-2' : 'left-2',
                        )}
                      >
                        {reactions.map((r) => (
                          <button
                            key={r.emoji}
                            type="button"
                            onClick={() => void handleReact(m.id, r.emoji)}
                            title={r.mine ? 'Remove your reaction' : `React with ${r.emoji}`}
                            className={cn(
                              'flex items-center gap-0.5 rounded-full px-1.5 text-[11px] leading-5',
                              r.mine ? 'bg-primary/15 text-primary' : 'text-foreground',
                            )}
                          >
                            <span>{r.emoji}</span>
                            {r.count > 1 && <span className="font-medium">{r.count}</span>}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>

                  {!m.deleted && (
                    <div
                      className={cn(
                        'flex items-center gap-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100',
                        reactions.length > 0 && 'self-start',
                      )}
                    >
                      <EmojiPicker
                        onSelect={(emoji) => void handleReact(m.id, emoji)}
                        size="sm"
                        align={m.isOwn ? 'right' : 'left'}
                        ariaLabel="React to message"
                      />
                      <div className="relative">
                        <button
                          type="button"
                          onClick={() => setActiveMenuId((id) => (id === m.id ? null : m.id))}
                          aria-label="Message actions"
                          className="flex h-7 w-7 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground"
                        >
                          <IconMoreVertical className="h-4 w-4" />
                        </button>
                        {activeMenuId === m.id && (
                          <div
                            className={cn(
                              'absolute top-8 z-10 w-40 overflow-hidden rounded-xl border border-border bg-background py-1 shadow-lg',
                              m.isOwn ? 'right-0' : 'left-0',
                            )}
                          >
                            <button
                              type="button"
                              onClick={() => {
                                setReplyingTo(m);
                                setActiveMenuId(null);
                              }}
                              className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-muted"
                            >
                              <IconReply className="h-4 w-4" /> Reply
                            </button>
                            <button
                              type="button"
                              onClick={() => {
                                setForwardingMessage(m);
                                setActiveMenuId(null);
                              }}
                              className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-muted"
                            >
                              <IconForward className="h-4 w-4" /> Forward
                            </button>
                            {m.isOwn && (
                              <button
                                type="button"
                                onClick={() => void handleDelete(m.id)}
                                className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-danger hover:bg-muted"
                              >
                                <IconTrash className="h-4 w-4" /> Delete
                              </button>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </div>
          );
        })}
        {otherTyping && (
          <div className="mt-2.5 flex justify-start">
            <div className="flex items-center gap-1 rounded-2xl rounded-tl-sm bg-background px-3.5 py-3 shadow-sm">
              <span className="h-1.5 w-1.5 animate-typing-dot rounded-full bg-muted-foreground [animation-delay:0ms]" />
              <span className="h-1.5 w-1.5 animate-typing-dot rounded-full bg-muted-foreground [animation-delay:160ms]" />
              <span className="h-1.5 w-1.5 animate-typing-dot rounded-full bg-muted-foreground [animation-delay:320ms]" />
            </div>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {replyingTo && (
        <div className="flex items-center gap-2 border-t border-border bg-muted/50 px-3 py-2">
          <IconReply className="h-4 w-4 flex-shrink-0 text-primary" />
          <div className="min-w-0 flex-1">
            <p className="text-xs font-medium text-primary">Replying to {replyingTo.isOwn ? 'yourself' : otherDisplayName}</p>
            <p className="truncate text-xs text-muted-foreground">
              {replyingTo.deleted
                ? deletedPlaceholderText(replyingTo.contentTypeHint, replyingTo.deletedReason)
                : replyingTo.contentTypeHint === 'voice'
                  ? '🎤 Voice message'
                  : replyingTo.contentTypeHint === 'image'
                    ? '📷 Photo'
                    : replyingTo.contentTypeHint === 'media'
                      ? `📄 ${replyingTo.attachment?.fileName ?? 'File'}`
                      : replyingTo.text}
            </p>
          </div>
          <button
            type="button"
            onClick={() => setReplyingTo(null)}
            aria-label="Cancel reply"
            className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <IconX className="h-4 w-4" />
          </button>
        </div>
      )}

      {error && <p className="border-t border-border px-3 pt-2 text-sm text-danger">{error}</p>}

      <div className="flex-shrink-0 border-t border-border p-2 sm:p-3">
        {isRecording ? (
          <div className="flex items-center gap-2 rounded-full bg-muted px-3 py-1.5">
            <button
              type="button"
              onClick={handleCancelRecording}
              aria-label="Cancel recording"
              className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-background hover:text-danger"
            >
              <IconTrash className="h-5 w-5" />
            </button>
            <span className="h-2.5 w-2.5 flex-shrink-0 animate-pulse rounded-full bg-danger" />
            <span className="flex-1 text-sm font-medium text-foreground">Recording… {formatRecordingTime(recordingSeconds)}</span>
            <button
              type="button"
              onClick={() => void handleStopAndSendRecording()}
              aria-label="Send voice message"
              className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground hover:opacity-90"
            >
              <IconSend className="h-4 w-4" />
            </button>
          </div>
        ) : (
          <form onSubmit={handleSend} className="flex items-end gap-1.5">
            <input
              ref={imageInputRef}
              type="file"
              accept="image/*"
              onChange={(e) => void handleImageSelected(e)}
              className="hidden"
            />
            <button
              type="button"
              onClick={() => imageInputRef.current?.click()}
              disabled={sendingImage}
              title={sendingImage ? 'Sending photo…' : 'Send a photo'}
              aria-label="Attach image"
              className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
            >
              <IconImage className="h-5 w-5" />
            </button>
            <input ref={fileInputRef} type="file" onChange={(e) => void handleFileSelected(e)} className="hidden" />
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={sendingFile}
              title={sendingFile ? 'Sending file…' : 'Attach a file'}
              aria-label="Attach file"
              className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
            >
              <IconPaperclip className="h-5 w-5" />
            </button>
            <EmojiPicker onSelect={(emoji) => setText((t) => t + emoji)} />
            <input
              value={text}
              onChange={(e) => handleInputChange(e.target.value)}
              placeholder="Message"
              aria-label="Message"
              autoComplete="off"
              // min-w-0 is load-bearing, not decoration — a text <input> in a flex row
              // has a browser-default automatic minimum width (its intrinsic content
              // size), unlike a plain <div>; without overriding that to 0, this input
              // refuses to shrink below it once the row's total content (4 icon
              // buttons + input + send button) exceeds a narrow phone's viewport
              // width, pushing the send/mic button off the right edge of the screen
              // entirely — the exact horizontal counterpart of the min-h-0 fix
              // message-thread.tsx's scroll container already needed for the same
              // "flex item won't shrink below its default minimum size" reason.
              className="h-10 min-w-0 flex-1 rounded-full border border-border bg-background px-4 text-sm text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
            />
            {text.trim() ? (
              <button
                type="submit"
                aria-label="Send message"
                className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground transition-transform hover:opacity-90 active:scale-95"
              >
                <IconSend className="h-4 w-4" />
              </button>
            ) : (
              <button
                type="button"
                onClick={() => void startRecording()}
                aria-label="Record voice message"
                className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground transition-transform hover:opacity-90 active:scale-95"
              >
                <IconMic className="h-4 w-4" />
              </button>
            )}
          </form>
        )}
      </div>

      {forwardingMessage && (
        <ForwardDialog
          open
          onClose={() => setForwardingMessage(null)}
          currentUserId={currentUserId}
          content={{
            contentTypeHint: forwardingMessage.contentTypeHint as 'text' | 'voice' | 'image' | 'media',
            text: forwardingMessage.text,
            mediaBase64: forwardingMessage.mediaBase64,
            attachment: forwardingMessage.attachment,
            mediaDurationSec: forwardingMessage.mediaDurationSec,
          }}
        />
      )}
    </div>
  );
}

