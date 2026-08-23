'use client';

/**
 * The group-conversation counterpart to `message-thread.tsx` — kept as a SEPARATE
 * component rather than branching inside `MessageThread` itself: the two encrypt
 * paths are different enough (per-recipient-device 1:1 vs. a shared group ratchet
 * with no single recipient device) that folding them into one component would mean
 * threading a `conversationType` discriminant through nearly every function in an
 * already-large file. Shares what's actually shareable — bubble renderers
 * (`bubbles.tsx`), the local decrypted-message cache (`lib/crypto/message-cache.ts`),
 * the same `hasMediaBytes`/`decodeMessagePlaintext` classification
 * (`lib/message-content.ts`) — everything else genuinely differs.
 *
 * Deliberately scoped down vs. `MessageThread` for this pass (docs/13-roadmap.md):
 * no reply-to, no typing indicator, no read-receipt ticks (per-recipient delivery/read
 * rows are still recorded server-side, just not surfaced as a "seen by N" UI) — all
 * flagged, not silently missing.
 */
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import type { MessageDto, GroupMemberDto, MessageDeletionReason, StarredMessageDto } from '@comm/types';
import { utf8ToBytes, bytesToBase64 } from '@comm/crypto';
import { cn } from '@/lib/cn';
import { formatBubbleTime, formatDateSeparator, isSameCalendarDay } from '@/lib/format';
import { apiFetch, ApiError } from '@/lib/api-client';
import { getCurrentKek } from '@/lib/crypto/kek-holder';
import {
  loadCachedMessages,
  appendCachedMessage,
  prependCachedMessages,
  removeCachedMessage,
  markCachedMessageDeleted,
  type CachedMessage,
} from '@/lib/crypto/message-cache';
import { connectRealtime, onRealtimeEvent } from '@/lib/realtime-client';
import {
  decodeMessagePlaintext,
  deletedPlaceholderText,
  buildReactionState,
  messageMatchesSearch,
  splitForHighlight,
  type ReactionPayload,
} from '@/lib/message-content';
import { encryptAttachment } from '@/lib/crypto/attachment-crypto';
import { uploadAttachmentCiphertext } from '@/lib/media-client';
import { useGroupSession } from '@/components/group/group-session-provider';
import { Avatar } from './avatar';
import { EmojiPicker } from './emoji-picker';
import { ForwardDialog } from './forward-dialog';
import { MessageInfoDialog } from './message-info-dialog';
import { VoiceBubble, ImageBubble, FileBubble, MediaImageBubble, MediaVideoBubble } from './bubbles';
import {
  IconSend,
  IconTrash,
  IconMic,
  IconImage,
  IconPaperclip,
  IconMoreVertical,
  IconForward,
  IconSearch,
  IconChevronUp,
  IconChevronDown,
  IconX,
  IconStar,
  IconCheckDouble,
} from '../icons';

const MAX_RECORDING_SECONDS = 120;
const MAX_IMAGE_BYTES = 2.5 * 1024 * 1024;
const MAX_IMAGE_DIMENSION = 1600;

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
      if (blob.size <= MAX_IMAGE_BYTES) return new Uint8Array(await blob.arrayBuffer());
    }
    throw new Error('This photo is too large to send even after compression.');
  } finally {
    bitmap.close();
  }
}

export function GroupMessageThread({
  conversationId,
  groupId,
  currentUserId,
  members,
  disappearingTimerMs,
}: {
  conversationId: string;
  groupId: string;
  currentUserId: string;
  members: GroupMemberDto[];
  disappearingTimerMs: number | null;
}): React.JSX.Element {
  const { encryptForGroup, decryptGroupMessageOnce, ensureGroupKeysUpToDate, registerGroupMembership } = useGroupSession();

  const [messages, setMessages] = useState<CachedMessage[]>([]);
  const [text, setText] = useState('');
  const [error, setError] = useState<string | undefined>();
  const [ready, setReady] = useState(false);
  const [activeMenuId, setActiveMenuId] = useState<string | null>(null);
  const [forwardingMessage, setForwardingMessage] = useState<CachedMessage | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [recordingSeconds, setRecordingSeconds] = useState(0);
  const [sendingImage, setSendingImage] = useState(false);
  const [sendingFile, setSendingFile] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchIndex, setSearchIndex] = useState(0);
  const [starredIds, setStarredIds] = useState<Set<string>>(new Set());
  const [infoMessageId, setInfoMessageId] = useState<string | null>(null);

  const scrollRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const bubbleRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const recordedChunksRef = useRef<Blob[]>([]);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const recordingIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const skipNextAutoScrollRef = useRef(false);

  const memberNames = new Map(members.map((m) => [m.userId, m.displayName]));
  function nameFor(userId: string): string {
    return memberNames.get(userId) ?? 'Former member';
  }

  const messagesRef = useRef(messages);
  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  // See message-thread.tsx's identical pair — `reaction` rows ride the same shared
  // group-ratchet envelope as any other content type (no server or crypto changes
  // needed at all) but are filtered out of the rendered bubble list and folded into
  // per-message pill state instead.
  const visibleMessages = messages.filter((m) => m.contentTypeHint !== 'reaction');
  const reactionState = useMemo(() => buildReactionState(messages, currentUserId), [messages, currentUserId]);

  // See message-thread.tsx's identical block for the full reasoning.
  const normalizedSearchQuery = searchQuery.trim().toLowerCase();
  const searchMatches = useMemo(
    () => visibleMessages.filter((m) => messageMatchesSearch(m, normalizedSearchQuery)).map((m) => m.id),
    [visibleMessages, normalizedSearchQuery],
  );
  useEffect(() => {
    setSearchIndex(searchMatches.length > 0 ? searchMatches.length - 1 : 0);
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

  // Local, immediate enforcement of the disappearing-message timer — same as
  // message-thread.tsx's identical effect. apps/worker's hourly sweep (which
  // doesn't distinguish direct from group conversations) is what actually erases
  // ciphertext server-side; this just makes it feel instant on an open thread.
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

  /** Tries to decrypt once; if there's no inbound session yet for this sender, syncs
   * pending key shares and tries exactly once more before giving up (skipped, not
   * shown as an error — same posture message-thread.tsx's catch-up loops take).
   * Always goes through `decryptGroupMessageOnce` (memoized by messageId) — never
   * call the group ratchet decrypt directly, see that function's docstring for why
   * (a real bug: React StrictMode's dev-mode double-effect-invocation double-decrypted
   * the same message here before this memoization existed). */
  async function decryptWithRetry(
    messageId: string,
    senderUserId: string,
    envelope: { header: string; ciphertext: string },
  ): Promise<Uint8Array> {
    try {
      return await decryptGroupMessageOnce(messageId, groupId, senderUserId, envelope);
    } catch {
      await ensureGroupKeysUpToDate(groupId);
      return decryptGroupMessageOnce(messageId, groupId, senderUserId, envelope);
    }
  }

  // See message-thread.tsx's identical effect — independent of the big load()
  // effect below so a starred-ids miss/failure never blocks message history.
  useEffect(() => {
    let cancelled = false;
    apiFetch<StarredMessageDto[]>('/api/messages/starred')
      .then((rows) => {
        if (!cancelled) setStarredIds(new Set(rows.map((r) => r.messageId)));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleToggleStar(messageId: string) {
    setActiveMenuId(null);
    const wasStarred = starredIds.has(messageId);
    setStarredIds((prev) => {
      const next = new Set(prev);
      if (wasStarred) next.delete(messageId);
      else next.add(messageId);
      return next;
    });
    try {
      await apiFetch(`/api/messages/${messageId}/star`, { method: wasStarred ? 'DELETE' : 'POST' });
    } catch {
      setStarredIds((prev) => {
        const next = new Set(prev);
        if (wasStarred) next.add(messageId);
        else next.delete(messageId);
        return next;
      });
    }
  }

  useEffect(() => {
    let cancelled = false;

    async function load() {
      const kek = getCurrentKek();
      if (!kek) {
        setError('This device is locked. Please sign in again.');
        return;
      }

      await registerGroupMembership(groupId);
      await ensureGroupKeysUpToDate(groupId);

      const cached = await loadCachedMessages(kek, conversationId);
      if (!cancelled) setMessages(cached);

      const page = await apiFetch<{ items: MessageDto[]; nextCursor: string | null }>(
        `/api/conversations/${conversationId}/messages?limit=50`,
      );
      const cachedIds = new Set(cached.map((m) => m.id));
      let latest = cached;
      for (const item of page.items) {
        if (cachedIds.has(item.id)) continue;
        if (item.senderUserId === currentUserId) continue; // our own — already durably cached when sent
        try {
          const plaintext = await decryptWithRetry(item.id, item.senderUserId, item.envelope);
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
          // Genuinely undecryptable (e.g. sent before this device joined, or the
          // key-share hasn't arrived even after a sync attempt) — skipped, not shown
          // as an error, same as the 1:1 thread's own catch-up loop.
        }
      }
      if (!cancelled) {
        setMessages(latest);
        setNextCursor(page.nextCursor);
        setReady(true);
      }

      // Same fix as the 1:1 thread's catch-up loop (message-thread.tsx) — record
      // delivery/read for whatever's newest even though no UI surfaces "seen by" for
      // groups yet (docs/05-crypto-architecture.md's "what shipped doesn't cover
      // yet"). Without this, the underlying per-recipient rows a future receipt-list
      // UI would read from stay permanently unset for anyone who opens a group
      // thread after being offline rather than while a message arrives live.
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
          const plaintext = await decryptWithRetry(message.id, message.senderUserId, message.envelope);
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
          // REST, not sendRealtimeEvent — same reasoning as message-thread.tsx's 1:1
          // equivalent: no retry if the socket happens to not be open a few `await`s
          // after this handler started, and the REST route publishes the identical
          // live WS event to everyone else either way.
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

    const offDeleted = onRealtimeEvent('deleted', (payload) => {
      if (payload.conversationId !== conversationId) return;
      void (async () => {
        const kek = getCurrentKek();
        if (!kek) return;
        const reason = payload.reason as MessageDeletionReason | undefined;
        setMessages(await markCachedMessageDeleted(kek, conversationId, payload.messageId as string, reason));
      })();
    });

    return () => {
      cancelled = true;
      offNew();
      offDeleted();
    };
    // Deliberately keyed on conversationId/groupId alone — currentUserId and the
    // GroupSessionProvider functions are stable for the lifetime of a mounted
    // thread, same reasoning as message-thread.tsx's identical effect.
  }, [conversationId, groupId]);

  useEffect(() => {
    if (skipNextAutoScrollRef.current) {
      skipNextAutoScrollRef.current = false;
      return;
    }
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length]);

  useEffect(() => {
    return () => {
      mediaStreamRef.current?.getTracks().forEach((t) => t.stop());
      if (recordingIntervalRef.current) clearInterval(recordingIntervalRef.current);
    };
  }, []);

  async function sendEncrypted(opts: {
    contentTypeHint: 'text' | 'voice' | 'image' | 'media' | 'reaction';
    plaintext: Uint8Array;
    draftText?: string;
    mediaDurationSec?: number;
    attachment?: { objectKey: string; encryptedSizeBytes: number };
  }) {
    setError(undefined);
    const kek = getCurrentKek();
    if (!kek) {
      setError('This device is locked. Please sign in again.');
      return;
    }

    const messageId = crypto.randomUUID();
    try {
      const envelope = await encryptForGroup(groupId, opts.plaintext);
      const sentAt = new Date().toISOString();

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
        replyToMessageId: null,
      };
      setMessages(await appendCachedMessage(kek, optimistic));

      await apiFetch(`/api/conversations/${conversationId}/messages`, {
        method: 'POST',
        body: {
          messageId,
          envelopeType: 'megolm_group',
          envelope,
          x3dhInit: null,
          contentTypeHint: opts.contentTypeHint,
          replyToMessageId: null,
          sentAt,
          attachment: opts.attachment,
        },
      });
    } catch (err) {
      const kek2 = getCurrentKek();
      if (kek2) setMessages(await removeCachedMessage(kek2, conversationId, messageId));
      setError(err instanceof ApiError ? err.message : err instanceof Error ? err.message : 'Could not send that message.');
      if (opts.draftText !== undefined) setText(opts.draftText);
    }
  }

  async function handleSend(e: FormEvent) {
    e.preventDefault();
    const trimmed = text.trim();
    if (!trimmed || isRecording) return;
    setText('');
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
          const plaintext = await decryptWithRetry(item.id, item.senderUserId, item.envelope);
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
    e.target.value = '';
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
      const descriptor = {
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

  /** See message-thread.tsx's identical function — same one-reaction-per-person
   * toggle semantics, sent through the group's shared ratchet envelope instead of
   * per-device ones, but otherwise unchanged. */
  async function handleReact(targetMessageId: string, emoji: string) {
    setActiveMenuId(null);
    const mine = reactionState.get(targetMessageId)?.mine ?? null;
    const next = mine === emoji ? null : emoji;
    const payload: ReactionPayload = { targetMessageId, emoji: next };
    await sendEncrypted({ contentTypeHint: 'reaction', plaintext: utf8ToBytes(JSON.stringify(payload)) });
  }

  async function handleDelete(messageId: string) {
    setActiveMenuId(null);
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
          if (s + 1 >= MAX_RECORDING_SECONDS) void handleStopAndSendRecording();
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
              className="rounded-full bg-background px-3 py-1.5 text-xs font-medium text-muted-foreground shadow-sm hover:text-foreground disabled:opacity-60"
            >
              {loadingOlder ? 'Loading…' : 'Load earlier messages'}
            </button>
          </div>
        )}
        {ready && visibleMessages.length === 0 && (
          <p className="py-8 text-center text-sm text-muted-foreground">No messages yet. Say hello to the group.</p>
        )}
        {visibleMessages.map((m, i) => {
          const prev = visibleMessages[i - 1];
          const showDateSeparator = !prev || !isSameCalendarDay(prev.sentAt, m.sentAt);
          const showSenderName = !m.isOwn && (!prev || prev.senderUserId !== m.senderUserId || showDateSeparator);
          const grouped = !showDateSeparator && prev && prev.senderUserId === m.senderUserId && !showSenderName;
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
              <div className={cn('group flex items-end gap-2', m.isOwn ? 'justify-end' : 'justify-start', grouped ? 'mt-0.5' : 'mt-2.5')}>
                {!m.isOwn && (
                  <div className="w-7 flex-shrink-0">{!grouped && <Avatar name={nameFor(m.senderUserId)} size="sm" />}</div>
                )}
                <div className={cn('flex min-w-0 max-w-[80%] items-end gap-1 sm:max-w-[70%]', m.isOwn && 'flex-row-reverse')}>
                  <div
                    className={cn(
                      // See message-thread.tsx's identical fix — min-w-0 lets this
                      // shrink below a voice/file bubble's own intrinsic min-width,
                      // which otherwise pushes it off narrow phone screens.
                      'relative min-w-0 rounded-2xl px-3 py-2 text-sm shadow-sm',
                      m.isOwn ? 'bg-primary text-primary-foreground' : 'bg-background text-foreground',
                      m.isOwn ? (grouped ? 'rounded-tr-md' : 'rounded-tr-sm') : grouped ? 'rounded-tl-md' : 'rounded-tl-sm',
                      isActiveSearchMatch && 'ring-2 ring-yellow-400',
                    )}
                  >
                    {showSenderName && (
                      <p className="mb-0.5 text-xs font-semibold" style={{ color: 'inherit' }}>
                        {nameFor(m.senderUserId)}
                      </p>
                    )}
                    {m.deleted ? (
                      <p className="flex items-center gap-1 italic text-muted-foreground">
                        <IconTrash className="h-3.5 w-3.5" /> {deletedPlaceholderText(m.contentTypeHint, m.deletedReason)}
                      </p>
                    ) : m.contentTypeHint === 'voice' && m.mediaBase64 ? (
                      <VoiceBubble base64={m.mediaBase64} durationHint={m.mediaDurationSec} isOwn={m.isOwn} />
                    ) : m.contentTypeHint === 'image' && m.mediaBase64 ? (
                      <ImageBubble base64={m.mediaBase64} />
                    ) : m.contentTypeHint === 'view_once' && m.mediaBase64 ? (
                      // View-once is a 1:1-only feature this pass (see deleteMessage's
                      // own docstring on why per-recipient tracking makes group
                      // view-once a separate, harder problem) — a photo that started
                      // as view-once but got forwarded into a group just renders as a
                      // normal photo here, an honest simplification rather than a
                      // broken/blank bubble.
                      <ImageBubble base64={m.mediaBase64} />
                    ) : m.contentTypeHint === 'media' && m.attachment?.mimeType.startsWith('image/') ? (
                      <MediaImageBubble attachment={m.attachment} isOwn={m.isOwn} />
                    ) : m.contentTypeHint === 'media' && m.attachment?.mimeType.startsWith('video/') ? (
                      <MediaVideoBubble attachment={m.attachment} isOwn={m.isOwn} />
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
                      {starredIds.has(m.id) && <IconStar className="h-2.5 w-2.5" filled />}
                      {formatBubbleTime(m.sentAt)}
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

                  {/* Reacting is open to every member (not just `m.isOwn` — unlike
                      Delete, which stays sender-only just below), so this wrapper
                      is no longer gated on ownership the way the old delete-only
                      menu was. */}
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
                                setForwardingMessage(m);
                                setActiveMenuId(null);
                              }}
                              className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-muted"
                            >
                              <IconForward className="h-4 w-4" /> Forward
                            </button>
                            <button
                              type="button"
                              onClick={() => void handleToggleStar(m.id)}
                              className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-muted"
                            >
                              <IconStar className="h-4 w-4" filled={starredIds.has(m.id)} />
                              {starredIds.has(m.id) ? 'Unstar' : 'Star'}
                            </button>
                            {m.isOwn && (
                              <button
                                type="button"
                                onClick={() => {
                                  setInfoMessageId(m.id);
                                  setActiveMenuId(null);
                                }}
                                className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-muted"
                              >
                                <IconCheckDouble className="h-4 w-4" /> Info
                              </button>
                            )}
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
        <div ref={bottomRef} />
      </div>

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
            <span className="flex-1 text-sm font-medium text-foreground">Recording… {recordingSeconds}s</span>
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
            <input ref={imageInputRef} type="file" accept="image/*" onChange={(e) => void handleImageSelected(e)} className="hidden" />
            <button
              type="button"
              onClick={() => imageInputRef.current?.click()}
              disabled={sendingImage}
              title={sendingImage ? 'Sending photo…' : 'Send a photo'}
              aria-label="Attach image"
              className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
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
              className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
            >
              <IconPaperclip className="h-5 w-5" />
            </button>
            <EmojiPicker onSelect={(emoji) => setText((t) => t + emoji)} />
            <input
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="Message"
              aria-label="Message"
              autoComplete="off"
              // See message-thread.tsx's identical fix — min-w-0 overrides a text
              // <input>'s browser-default minimum width, which otherwise refuses to
              // shrink and pushes the send button off narrow phone screens.
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

      <MessageInfoDialog
        open={infoMessageId !== null}
        onClose={() => setInfoMessageId(null)}
        messageId={infoMessageId}
        members={members}
        currentUserId={currentUserId}
      />
    </div>
  );
}
