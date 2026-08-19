'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ConversationSummary, MessageDto, MessageDeletionReason } from '@comm/types';
import { cn } from '@/lib/cn';
import { apiFetch } from '@/lib/api-client';
import { getCurrentKek } from '@/lib/crypto/kek-holder';
import { decryptFromDeviceOnce } from '@/lib/crypto/conversation-crypto';
import { loadCachedMessages, appendCachedMessage, markCachedMessageDeleted, type CachedMessage } from '@/lib/crypto/message-cache';
import { onRealtimeEvent } from '@/lib/realtime-client';
import { decodeMessagePlaintext } from '@/lib/message-content';
import { ConversationList, type ConversationPreview } from './conversation-list';
import { NewChatForm } from './new-chat-form';
import { NewGroupForm } from './new-group-form';
import { IconSearch, IconEdit, IconX, IconArchive, IconChevronUp, IconUsers, IconStar } from '../icons';
import { Input } from '../ui/input';
import { Dialog } from '../ui/dialog';

function extractOpenId(pathname: string): string | null {
  const match = pathname.match(/^\/chats\/([^/]+)$/);
  return match ? match[1]! : null;
}

function toPreview(m: CachedMessage): ConversationPreview {
  return { text: m.text, isOwn: m.isOwn, contentTypeHint: m.contentTypeHint, deleted: !!m.deleted, deletedReason: m.deletedReason };
}

/** The last cached message that's actually preview-worthy — skips `reaction` rows
 * (a reaction to some earlier message is never itself "the last message" for
 * sidebar-preview purposes, same reasoning server/modules/conversations/service.ts's
 * `toSummary` excludes them from `lastMessageAt`/`unreadCount`). Reaction rows still
 * get cached normally by every call site below; this is only about which cached row
 * is *shown*. */
function lastPreviewable(cached: CachedMessage[]): CachedMessage | undefined {
  for (let i = cached.length - 1; i >= 0; i--) {
    if (cached[i]!.contentTypeHint !== 'reaction') return cached[i];
  }
  return undefined;
}

/**
 * The persistent chat frame — sidebar (search + conversation list) on the left,
 * whichever thread/empty-state page is active as `children` on the right, WhatsApp
 * Web-style. Lives in `app/(app)/chats/layout.tsx`, which is why it doesn't remount
 * between `/chats` and `/chats/[id]` (Next.js layouts persist across their own
 * child-route navigations) — that persistence is what lets the sidebar keep a live
 * WebSocket-driven view of every conversation, not just the open one.
 *
 * Decryption safety: this component decrypts an incoming message for sidebar-preview
 * purposes ONLY when that message's conversation is NOT the one currently open —
 * when it IS open, MessageThread's own listener already decrypts and caches it, and
 * Double Ratchet message keys are single-use (docs/05-crypto-architecture.md), so
 * two listeners decrypting the same envelope would corrupt ratchet state. `openIdRef`
 * (kept in sync with the route, not React state, so the WS callback always reads the
 * current value) is the *first* guard, but not sufficient alone: a user can navigate
 * into a thread while this component's own async decrypt for a just-arrived message
 * is still in flight (openIdRef flips before the write lands), letting
 * MessageThread's mount-time catch-up start a second, concurrent decrypt of the same
 * envelope — a real bug found via a live multi-browser test, not hypothetical (see
 * docs/13-roadmap.md). The actual guard against that race is
 * `lib/crypto/conversation-crypto.ts`'s `decryptFromDeviceOnce` (memoizes by message
 * id so a given envelope is only ever decrypted once, no matter how many call sites
 * race to do it) — every decrypt call site in this file and message-thread.tsx goes
 * through it, never `decryptFromDevice` directly.
 */
export function ChatsShell({
  initialConversations,
  children,
}: {
  initialConversations: ConversationSummary[];
  currentUserId: string;
  children: React.ReactNode;
}): React.JSX.Element {
  const pathname = usePathname();
  const openId = extractOpenId(pathname);
  const openIdRef = useRef(openId);
  const previousOpenIdRef = useRef<string | null>(null);
  const [conversations, setConversations] = useState(initialConversations);
  const conversationsRef = useRef(conversations);
  const [previews, setPreviews] = useState<Record<string, ConversationPreview | undefined>>({});
  const [search, setSearch] = useState('');
  const [composeOpen, setComposeOpen] = useState(false);
  const [archivedOpen, setArchivedOpen] = useState(false);
  const [groupDialogOpen, setGroupDialogOpen] = useState(false);

  useEffect(() => {
    openIdRef.current = openId;
  }, [openId]);

  // Real bug found live: conversation-list.tsx's badge zeroes itself only *while*
  // this conversation is the open route (`isOpen ? 0 : c.unreadCount`) — nothing
  // ever reset the underlying `unreadCount` field in `conversations` state itself,
  // so the moment you navigated back to the list after reading a thread, the stale
  // pre-read count reappeared. The "new"-event handler below only ever increments
  // it; this is the corresponding decrement, run whenever the route settles on a
  // conversation that still has one.
  useEffect(() => {
    if (!openId) return;
    setConversations((prev) =>
      prev.map((c) => (c.id === openId && c.unreadCount > 0 ? { ...c, unreadCount: 0 } : c)),
    );
  }, [openId]);

  useEffect(() => {
    conversationsRef.current = conversations;
  }, [conversations]);

  // Reconcile with the server after anything that calls router.refresh() (e.g.
  // starting a new chat) — see chats-shell.tsx's own note on why a plain useState
  // seed isn't enough for a persistent layout component.
  useEffect(() => {
    setConversations(initialConversations);
  }, [initialConversations]);

  // Hydrate sidebar previews from the LOCAL decrypted cache only (never decrypts
  // here) — on first mount, for every conversation; after that, just for whichever
  // conversation the user navigated away from, since opening a thread is the main
  // way its cache gains new entries.
  useEffect(() => {
    const kek = getCurrentKek();
    if (!kek) return;
    let cancelled = false;

    async function hydrate(ids: string[]) {
      for (const id of ids) {
        const cached = await loadCachedMessages(kek!, id);
        const last = lastPreviewable(cached);
        if (!cancelled && last) {
          setPreviews((prev) => ({ ...prev, [id]: toPreview(last) }));
        }
      }
    }

    if (previousOpenIdRef.current === null) {
      void hydrate(conversationsRef.current.map((c) => c.id));
    } else if (previousOpenIdRef.current !== openId) {
      void hydrate([previousOpenIdRef.current]);
    }
    previousOpenIdRef.current = openId;

    return () => {
      cancelled = true;
    };
  }, [openId]);

  useEffect(() => {
    const offNew = onRealtimeEvent('new', (payload) => {
      const message = payload.message as MessageDto;
      const isOpen = message.conversationId === openIdRef.current;

      // A real bug found live: "delivered" (the sender's second grey tick) only ever
      // got sent from message-thread.tsx's open-thread listener, bundled together
      // with `message.read` — so a message that arrived while this device was online
      // but that specific thread wasn't the open one (sidebar-only, or a different
      // thread open) never got acked as delivered at all, leaving the sender stuck on
      // a single tick indefinitely even though the message plainly did reach this
      // device (it's sitting right there in the sidebar preview). Delivered and read
      // are different facts — "reached this device" vs. "the user looked at it" — and
      // this component (mounted once, for the whole app, independent of which thread
      // is open) is the right place to report the first one unconditionally, the
      // instant any message actually arrives. `message.read` correctly stays gated to
      // the thread being open (message-thread.tsx's own listener); acking delivery
      // twice for a message whose thread happens to be open too is harmless —
      // `acknowledgeDelivered` only ever writes `deliveredAt` once
      // (`where: { deliveredAt: null }`). REST, not sendRealtimeEvent — this send
      // itself is safe-by-construction the instant this handler runs (the event
      // it's replying to only just arrived over this exact socket, so it's
      // definitely open right now), but using the same durable route as every other
      // ack/read call site keeps this from being the one place that quietly regains
      // the fragile-WS-only gap already found and fixed everywhere else.
      apiFetch(`/api/messages/${message.id}/delivered`, { method: 'POST' }).catch(() => undefined);

      // A reaction is a control message, not content — see `lastPreviewable`'s
      // docstring above. Skipping this block entirely for one means it neither
      // bumps the conversation to the top of the list nor increments its unread
      // badge, matching what `toSummary` already does server-side for the exact
      // same reason.
      if (message.contentTypeHint !== 'reaction') {
        setConversations((prev) => {
          const idx = prev.findIndex((c) => c.id === message.conversationId);
          if (idx === -1) return prev;
          const current = prev[idx]!;
          const updated: ConversationSummary = {
            ...current,
            lastMessageAt: message.sentAt,
            unreadCount: isOpen ? current.unreadCount : current.unreadCount + 1,
          };
          return [updated, ...prev.slice(0, idx), ...prev.slice(idx + 1)];
        });
      }

      void (async () => {
        if (!conversationsRef.current.some((c) => c.id === message.conversationId)) {
          // A message on a conversation we don't know about yet — most likely
          // someone messaging us for the first time. No realtime
          // "conversation created" push exists yet, so this is the fallback: a
          // fresh list fetch picks up the new conversation row.
          try {
            const fresh = await apiFetch<ConversationSummary[]>('/api/conversations');
            setConversations(fresh);
          } catch {
            return;
          }
        }
        if (isOpen) return; // MessageThread's own listener owns decryption for the open thread
        const kek = getCurrentKek();
        if (!kek) return;
        try {
          const plaintext = await decryptFromDeviceOnce(message.id, message.senderDeviceId, message.envelope, message.x3dhInit);
          const cached: CachedMessage = {
            id: message.id,
            conversationId: message.conversationId,
            senderUserId: message.senderUserId,
            isOwn: false,
            contentTypeHint: message.contentTypeHint,
            ...decodeMessagePlaintext(message.contentTypeHint, plaintext),
            sentAt: message.sentAt,
            replyToMessageId: message.replyToMessageId,
          };
          await appendCachedMessage(kek, cached);
          // Still cached above (so it's there once the thread is opened and
          // reaction pills get computed from the full cache), just never shown
          // as the sidebar preview itself.
          if (cached.contentTypeHint !== 'reaction') {
            setPreviews((prev) => ({ ...prev, [message.conversationId]: toPreview(cached) }));
          }
        } catch {
          // Undecryptable on this device — the same honest limitation
          // message-thread.tsx's catch-up loop documents.
        }
      })();
    });

    const offDeleted = onRealtimeEvent('deleted', (payload) => {
      const conversationId = payload.conversationId as string;
      const messageId = payload.messageId as string;
      const reason = payload.reason as MessageDeletionReason | undefined;
      // A pure cache overwrite, no decryption involved — safe to run unconditionally
      // even if the thread is also open and does the same thing.
      void (async () => {
        const kek = getCurrentKek();
        if (!kek) return;
        const updated = await markCachedMessageDeleted(kek, conversationId, messageId, reason);
        const last = lastPreviewable(updated);
        setPreviews((prev) => ({ ...prev, [conversationId]: last ? toPreview(last) : prev[conversationId] }));
      })();
    });

    return () => {
      offNew();
      offDeleted();
    };
  }, []);

  /** Optimistic — same reasoning as every other sidebar update here: the server is
   * the source of truth, but reflecting the change immediately reads as instant,
   * matching WhatsApp's own "Archive chat" swipe action. Reverted on failure. */
  async function handleToggleArchive(conversationId: string, archived: boolean) {
    const previous = conversations;
    setConversations((prev) => prev.map((c) => (c.id === conversationId ? { ...c, archived } : c)));
    try {
      await apiFetch(`/api/conversations/${conversationId}`, { method: 'PATCH', body: { archived } });
    } catch {
      setConversations(previous);
    }
  }

  /** Same optimistic-then-revert shape as `handleToggleArchive` above. */
  async function handleTogglePin(conversationId: string, pinned: boolean) {
    const previous = conversations;
    setConversations((prev) => prev.map((c) => (c.id === conversationId ? { ...c, pinned } : c)));
    try {
      await apiFetch(`/api/conversations/${conversationId}`, { method: 'PATCH', body: { pinned } });
    } catch {
      setConversations(previous);
    }
  }

  const isThreadOpen = openId !== null;
  const query = search.trim().toLowerCase();
  const matchesQuery = (c: ConversationSummary) => {
    if (!query) return true;
    if (c.type === 'group') return c.group.name.toLowerCase().includes(query);
    return c.otherUser.displayName.toLowerCase().includes(query) || c.otherUser.username.toLowerCase().includes(query);
  };
  // Pinned-first, same as WhatsApp's own chat list — a plain stable sort (Array#sort
  // is stable in every JS engine this app targets) keeps everything else in whatever
  // order it already was (most-recent-first, from listConversations/toSummary).
  const activeFiltered = conversations
    .filter((c) => !c.archived && matchesQuery(c))
    .sort((a, b) => Number(b.pinned) - Number(a.pinned));
  const archivedFiltered = conversations.filter((c) => c.archived && matchesQuery(c));

  return (
    <div className="flex h-full">
      <aside
        className={cn(
          'w-full flex-col border-r border-border md:flex md:w-[380px] md:flex-shrink-0',
          isThreadOpen ? 'hidden' : 'flex',
        )}
      >
        <div className="flex flex-shrink-0 items-center justify-between gap-2 px-4 py-3">
          <h1 className="text-xl font-semibold text-foreground">Chats</h1>
          <div className="flex items-center gap-1">
            <Link
              href="/starred"
              aria-label="Starred messages"
              title="Starred messages"
              className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <IconStar className="h-5 w-5" />
            </Link>
            <button
              type="button"
              onClick={() => setComposeOpen((v) => !v)}
              aria-label={composeOpen ? 'Close new chat' : 'New chat'}
              aria-expanded={composeOpen}
              className={cn(
                'flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground',
                composeOpen && 'bg-muted text-foreground',
              )}
            >
              {composeOpen ? <IconX className="h-5 w-5" /> : <IconEdit className="h-5 w-5" />}
            </button>
          </div>
        </div>

        {composeOpen && (
          <div className="flex-shrink-0 space-y-2 border-b border-border px-4 pb-3">
            <NewChatForm onStarted={() => setComposeOpen(false)} />
            <button
              type="button"
              onClick={() => setGroupDialogOpen(true)}
              className="flex items-center gap-1.5 text-xs font-medium text-primary hover:underline"
            >
              <IconUsers className="h-3.5 w-3.5" /> Create a group instead
            </button>
          </div>
        )}

        <Dialog open={groupDialogOpen} onClose={() => setGroupDialogOpen(false)} title="New group">
          <NewGroupForm onDone={() => { setGroupDialogOpen(false); setComposeOpen(false); }} />
        </Dialog>

        <div className="flex-shrink-0 px-3 pb-2">
          <div className="relative">
            <IconSearch className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search chats"
              aria-label="Search chats"
              className="h-10 rounded-full bg-muted pl-10"
            />
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {archivedFiltered.length > 0 && (
            <button
              type="button"
              onClick={() => setArchivedOpen((v) => !v)}
              aria-expanded={archivedOpen}
              className="flex w-full items-center gap-3 border-b border-border/60 px-3 py-3 text-left hover:bg-muted"
            >
              <span className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
                <IconArchive className="h-4 w-4" />
              </span>
              <span className="flex-1 text-sm font-medium text-foreground">Archived ({archivedFiltered.length})</span>
              <IconChevronUp className={cn('h-4 w-4 flex-shrink-0 text-muted-foreground transition-transform', !archivedOpen && 'rotate-180')} />
            </button>
          )}
          {archivedOpen && archivedFiltered.length > 0 && (
            <ConversationList
              conversations={archivedFiltered}
              previews={previews}
              openId={openId}
              onToggleArchive={(id, archived) => void handleToggleArchive(id, archived)}
              onTogglePin={(id, pinned) => void handleTogglePin(id, pinned)}
            />
          )}
          <ConversationList
            conversations={activeFiltered}
            previews={previews}
            openId={openId}
            onToggleArchive={(id, archived) => void handleToggleArchive(id, archived)}
            onTogglePin={(id, pinned) => void handleTogglePin(id, pinned)}
          />
        </div>
      </aside>

      <div className={cn('min-h-0 flex-1 flex-col', isThreadOpen ? 'flex' : 'hidden md:flex')}>{children}</div>
    </div>
  );
}
