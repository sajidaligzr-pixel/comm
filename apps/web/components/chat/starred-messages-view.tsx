'use client';

/**
 * Cross-conversation "Starred messages" (docs/13-roadmap.md's pinned/starred
 * pass) — the server only ever returns WHICH message ids are starred, in WHICH
 * conversations (StarredMessageDto's own docstring: it has no plaintext to give
 * back, this app is E2E end to end). This view resolves each entry against this
 * device's own local decrypted cache, one `loadCachedMessages` per distinct
 * conversation rather than per message, since several stars commonly land in the
 * same chat. An entry this device never decrypted (starred from a different
 * device, or aged out of the local cache) renders as "not available on this
 * device" — the same honest limitation every other view in this app already has,
 * not a bug specific to starring.
 */
import { useEffect, useState } from 'react';
import Link from 'next/link';
import type { ConversationSummary, StarredMessageDto } from '@comm/types';
import { apiFetch, ApiError } from '@/lib/api-client';
import { getCurrentKek } from '@/lib/crypto/kek-holder';
import { loadCachedMessages, type CachedMessage } from '@/lib/crypto/message-cache';
import { deletedPlaceholderText } from '@/lib/message-content';
import { titleFor } from './conversation-list';
import { Avatar } from './avatar';
import { IconArrowLeft, IconStar } from '../icons';

interface ResolvedStar {
  entry: StarredMessageDto;
  conversationTitle: string;
  message: CachedMessage | undefined;
}

function previewFor(m: CachedMessage): string {
  if (m.deleted) return deletedPlaceholderText(m.contentTypeHint, m.deletedReason);
  if (m.contentTypeHint === 'voice') return '🎤 Voice message';
  if (m.contentTypeHint === 'image') return '📷 Photo';
  if (m.contentTypeHint === 'media') return `📄 ${m.attachment?.fileName ?? 'File'}`;
  return m.text;
}

export function StarredMessagesView(): React.JSX.Element {
  const [resolved, setResolved] = useState<ResolvedStar[] | null>(null);
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    let cancelled = false;

    async function load() {
      const kek = getCurrentKek();
      if (!kek) {
        setError('This device is locked. Please sign in again.');
        return;
      }
      try {
        const [starred, conversations] = await Promise.all([
          apiFetch<StarredMessageDto[]>('/api/messages/starred'),
          apiFetch<ConversationSummary[]>('/api/conversations'),
        ]);
        const titleByConversation = new Map(conversations.map((c) => [c.id, titleFor(c)]));

        const cacheByConversation = new Map<string, CachedMessage[]>();
        for (const conversationId of new Set(starred.map((s) => s.conversationId))) {
          cacheByConversation.set(conversationId, await loadCachedMessages(kek, conversationId));
        }

        const results: ResolvedStar[] = starred.map((entry) => ({
          entry,
          conversationTitle: titleByConversation.get(entry.conversationId) ?? 'Unknown chat',
          message: cacheByConversation.get(entry.conversationId)?.find((m) => m.id === entry.messageId),
        }));
        if (!cancelled) setResolved(results);
      } catch (err) {
        if (!cancelled) setError(err instanceof ApiError ? err.message : 'Could not load starred messages.');
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleUnstar(messageId: string) {
    const previous = resolved;
    setResolved((prev) => (prev ? prev.filter((r) => r.entry.messageId !== messageId) : prev));
    try {
      await apiFetch(`/api/messages/${messageId}/star`, { method: 'DELETE' });
    } catch {
      setResolved(previous);
    }
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-shrink-0 items-center gap-2 border-b border-border px-3 py-2">
        <Link
          href="/chats"
          aria-label="Back to chats"
          className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <IconArrowLeft className="h-5 w-5" />
        </Link>
        <h1 className="text-base font-semibold text-foreground">Starred messages</h1>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {error && <p className="p-4 text-sm text-danger">{error}</p>}
        {!error && resolved === null && <p className="p-8 text-center text-sm text-muted-foreground">Loading…</p>}
        {!error && resolved !== null && resolved.length === 0 && (
          <p className="p-8 text-center text-sm text-muted-foreground">
            No starred messages yet — long-press (or the "⋯" menu) on any message, then Star.
          </p>
        )}
        {resolved?.map(({ entry, conversationTitle, message }) => (
          <Link
            key={entry.messageId}
            href={`/chats/${entry.conversationId}`}
            className="group flex items-center gap-3 border-b border-border/60 px-3 py-3 hover:bg-muted"
          >
            <Avatar name={conversationTitle} size="sm" />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium text-foreground">{conversationTitle}</p>
              <p className="truncate text-sm text-muted-foreground">
                {message ? previewFor(message) : 'Not available on this device'}
              </p>
            </div>
            <button
              type="button"
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                void handleUnstar(entry.messageId);
              }}
              title="Unstar"
              aria-label="Unstar"
              className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full text-primary opacity-0 transition-opacity hover:bg-background focus-visible:opacity-100 group-hover:opacity-100"
            >
              <IconStar className="h-4 w-4" filled />
            </button>
          </Link>
        ))}
      </div>
    </div>
  );
}
