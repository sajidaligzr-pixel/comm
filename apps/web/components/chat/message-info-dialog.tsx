'use client';

/**
 * "Seen by" for a group message (docs/13-roadmap.md) — WhatsApp's own "Message
 * info" screen, scoped to groups (a 1:1 conversation already shows this as a
 * single/double/blue tick, never a per-person breakdown). The data itself
 * (`MessageRecipient.deliveredAt`/`readAt`) has been recorded for every group
 * member since the group-chat pass shipped; this is purely a new read surface
 * over it — see `getMessageReceipts`'s own docstring (server/modules/messages/
 * service.ts) for the one-row-per-member collapsing rule.
 */
import { useEffect, useState } from 'react';
import type { GroupMemberDto, MessageReceiptDto } from '@comm/types';
import { apiFetch, ApiError } from '@/lib/api-client';
import { formatBubbleTime, formatDateSeparator } from '@/lib/format';
import { Dialog } from '../ui/dialog';
import { Avatar } from './avatar';
import { IconCheckDouble } from '../icons';

function timestampLabel(iso: string): string {
  return `${formatDateSeparator(iso)}, ${formatBubbleTime(iso)}`;
}

export function MessageInfoDialog({
  open,
  onClose,
  messageId,
  members,
  currentUserId,
}: {
  open: boolean;
  onClose: () => void;
  messageId: string | null;
  members: GroupMemberDto[];
  currentUserId: string;
}): React.JSX.Element | null {
  const [receipts, setReceipts] = useState<MessageReceiptDto[] | null>(null);
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    if (!open || !messageId) return;
    setReceipts(null);
    setError(undefined);
    apiFetch<MessageReceiptDto[]>(`/api/messages/${messageId}/receipts`)
      .then(setReceipts)
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Could not load message info.'));
  }, [open, messageId]);

  if (!open) return null;

  const others = members.filter((m) => m.userId !== currentUserId);
  const byUser = new Map(receipts?.map((r) => [r.userId, r]));
  const readBy = others.filter((m) => byUser.get(m.userId)?.readAt);
  const deliveredOnly = others.filter((m) => byUser.get(m.userId)?.deliveredAt && !byUser.get(m.userId)?.readAt);
  const notYet = others.filter((m) => !byUser.get(m.userId)?.deliveredAt);

  function row(member: GroupMemberDto, sub?: string) {
    return (
      <div key={member.userId} className="flex items-center gap-3 py-2">
        <Avatar name={member.displayName} size="sm" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm text-foreground">{member.displayName}</p>
          {sub && <p className="text-xs text-muted-foreground">{sub}</p>}
        </div>
      </div>
    );
  }

  return (
    <Dialog open={open} onClose={onClose} title="Message info">
      {error && <p className="text-sm text-danger">{error}</p>}
      {!error && receipts === null && <p className="py-6 text-center text-sm text-muted-foreground">Loading…</p>}
      {!error && receipts !== null && (
        <div className="space-y-4">
          <div>
            <p className="mb-1 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              <IconCheckDouble className="h-3.5 w-3.5 text-sky-400" /> Read by {readBy.length}
            </p>
            {readBy.length === 0 ? (
              <p className="py-1 text-sm text-muted-foreground">No one yet.</p>
            ) : (
              readBy.map((m) => row(m, byUser.get(m.userId)?.readAt ? timestampLabel(byUser.get(m.userId)!.readAt!) : undefined))
            )}
          </div>
          <div>
            <p className="mb-1 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              <IconCheckDouble className="h-3.5 w-3.5" /> Delivered to {deliveredOnly.length}
            </p>
            {deliveredOnly.length === 0 ? (
              <p className="py-1 text-sm text-muted-foreground">No one yet.</p>
            ) : (
              deliveredOnly.map((m) =>
                row(m, byUser.get(m.userId)?.deliveredAt ? timestampLabel(byUser.get(m.userId)!.deliveredAt!) : undefined),
              )
            )}
          </div>
          {notYet.length > 0 && (
            <div>
              <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Not delivered yet</p>
              {notYet.map((m) => row(m))}
            </div>
          )}
        </div>
      )}
    </Dialog>
  );
}
