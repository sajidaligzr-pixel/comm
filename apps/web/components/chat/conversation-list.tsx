'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import type { ConversationSummary, MessageDeletionReason } from '@comm/types';
import { cn } from '@/lib/cn';
import { formatConversationTimestamp } from '@/lib/format';
import { deletedPlaceholderText } from '@/lib/message-content';
import { Avatar } from './avatar';
import { IconArchive, IconPin, IconTrash } from '../icons';

/**
 * A real hydration mismatch found live (and now fixed): `formatConversationTimestamp`
 * calls `toLocaleTimeString`/`toLocaleDateString` with an empty locale array, which
 * resolves to whatever locale *and timezone* the current runtime defaults to — the
 * server (Node.js, generally UTC or the host machine's own configured locale) has no
 * way to know the browser's actual locale/timezone, so SSR and the client's first
 * render produced genuinely different text for the exact same `lastMessageAt` value
 * ("12:32 AM" server-side vs "0:32" client-side was the actual observed case). There
 * is no way to make the *server* render the browser's own timezone correctly — it
 * doesn't know it yet — so this renders a stable, empty placeholder for the very
 * first paint (identical on server and client, no mismatch possible) and fills in
 * the real, locale/timezone-correct value in an effect immediately after mount, the
 * same "client-only values belong in an effect, never a lazy initializer" pattern
 * already used in `unlock-gate.tsx` and `login-form.tsx`'s remembered-username fix.
 */
function ConversationTimestamp({ iso }: { iso: string | null }): React.JSX.Element {
  const [label, setLabel] = useState('');
  useEffect(() => {
    setLabel(formatConversationTimestamp(iso));
  }, [iso]);
  return <>{label}</>;
}

/** The sidebar's "last message" line — sourced from the LOCAL decrypted cache only
 * (chats-shell.tsx), never from the server: the server never has plaintext to give
 * us (docs/05-crypto-architecture.md). A conversation this device hasn't opened yet
 * simply has no preview. */
export interface ConversationPreview {
  text: string;
  isOwn: boolean;
  contentTypeHint: string;
  deleted: boolean;
  deletedReason?: MessageDeletionReason;
}

function previewLabel(preview: ConversationPreview | undefined): string {
  if (!preview) return 'Tap to view messages';
  const prefix = preview.isOwn ? 'You: ' : '';
  if (preview.deleted) return `${prefix}${deletedPlaceholderText(preview.contentTypeHint, preview.deletedReason)}`;
  if (preview.contentTypeHint === 'voice') return `${prefix}🎤 Voice message`;
  if (preview.contentTypeHint === 'image') return `${prefix}📷 Photo`;
  if (preview.contentTypeHint === 'media') return `${prefix}📄 File`;
  return `${prefix}${preview.text}`;
}

/** The one place that resolves "what name/avatar represents this row" for either
 * conversation shape (docs/13-roadmap.md's group chat pass) — every other place that
 * used to assume `c.otherUser` goes through this instead of re-deriving the branch.
 * Exported for forward-dialog.tsx's conversation picker, which needs the identical
 * resolution rather than a second copy that could quietly drift from this one. */
export function titleFor(c: ConversationSummary): string {
  return c.type === 'group' ? c.group.name : c.otherUser.displayName;
}

export function ConversationList({
  conversations,
  previews,
  openId,
  onToggleArchive,
  onTogglePin,
  onDeleteChat,
}: {
  conversations: ConversationSummary[];
  previews: Record<string, ConversationPreview | undefined>;
  openId: string | null;
  /** Archiving is a per-caller view preference (WhatsApp's "Archive chat") — see
   * `ConversationSummary.archived`'s docstring in packages/types. */
  onToggleArchive: (conversationId: string, archived: boolean) => void;
  /** Same per-caller-view-preference shape as archiving — see
   * `ConversationSummary.pinned`'s docstring. Callers are expected to have
   * already sorted `conversations` pinned-first (chats-shell.tsx) — this
   * component only renders the toggle and the "is pinned" indicator, it
   * doesn't re-sort its own input. */
  onTogglePin: (conversationId: string, pinned: boolean) => void;
  /** Local-only wipe of this device's cached history + hides the row — see
   * `lib/crypto/message-cache.ts`'s `clearCachedMessages`/
   * `markConversationLocallyDeleted` docstrings for the exact WhatsApp-parity
   * scope (never touches the other side, comes back if they message again). */
  onDeleteChat: (conversationId: string) => void;
}): React.JSX.Element {
  if (conversations.length === 0) {
    return (
      <p className="py-10 text-center text-sm text-muted-foreground">
        No conversations yet. Tap the pencil above to start one.
      </p>
    );
  }

  return (
    <div>
      {conversations.map((c) => {
        const isOpen = c.id === openId;
        const unread = isOpen ? 0 : c.unreadCount;
        return (
          <Link
            key={c.id}
            href={`/chats/${c.id}`}
            className={cn(
              'group flex items-center gap-3 border-b border-border/60 px-3 py-3 transition-colors hover:bg-muted',
              isOpen && 'bg-muted',
            )}
          >
            <Avatar name={titleFor(c)} />
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline justify-between gap-2">
                <p className="flex min-w-0 items-center gap-1 truncate text-[15px] font-medium text-foreground">
                  <span className="truncate">{titleFor(c)}</span>
                  {c.pinned && <IconPin className="h-3 w-3 flex-shrink-0 fill-current text-muted-foreground" />}
                </p>
                <span className={cn('flex-shrink-0 text-xs', unread > 0 ? 'font-semibold text-primary' : 'text-muted-foreground')}>
                  <ConversationTimestamp iso={c.lastMessageAt} />
                </span>
              </div>
              <div className="flex items-center justify-between gap-2">
                <p
                  className={cn(
                    'truncate text-sm',
                    unread > 0 ? 'font-medium text-foreground' : 'text-muted-foreground',
                  )}
                >
                  {previewLabel(previews[c.id])}
                </p>
                {unread > 0 && (
                  <span className="flex h-5 min-w-5 flex-shrink-0 items-center justify-center rounded-full bg-primary px-1.5 text-[11px] font-semibold text-primary-foreground">
                    {unread > 99 ? '99+' : unread}
                  </span>
                )}
              </div>
            </div>
            <button
              type="button"
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                onTogglePin(c.id, !c.pinned);
              }}
              title={c.pinned ? 'Unpin chat' : 'Pin chat'}
              aria-label={c.pinned ? 'Unpin chat' : 'Pin chat'}
              className={cn(
                'flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full transition-opacity hover:bg-background hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100',
                c.pinned ? 'text-primary opacity-100' : 'text-muted-foreground opacity-0',
              )}
            >
              <IconPin className={cn('h-4 w-4', c.pinned && 'fill-current')} />
            </button>
            <button
              type="button"
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                onToggleArchive(c.id, !c.archived);
              }}
              title={c.archived ? 'Unarchive chat' : 'Archive chat'}
              aria-label={c.archived ? 'Unarchive chat' : 'Archive chat'}
              className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full text-muted-foreground opacity-0 transition-opacity hover:bg-background hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100"
            >
              <IconArchive className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                onDeleteChat(c.id);
              }}
              title="Delete chat"
              aria-label={`Delete chat with ${titleFor(c)}`}
              className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full text-muted-foreground opacity-0 transition-opacity hover:bg-background hover:text-danger focus-visible:opacity-100 group-hover:opacity-100"
            >
              <IconTrash className="h-4 w-4" />
            </button>
          </Link>
        );
      })}
    </div>
  );
}
