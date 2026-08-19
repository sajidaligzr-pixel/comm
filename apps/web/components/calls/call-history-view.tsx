'use client';

import type { CallHistoryEntry } from '@comm/types';
import { Avatar } from '@/components/chat/avatar';
import { useCall } from '@/components/call/call-provider';
import { useGroupCall } from '@/components/call/group-call-provider';
import { formatConversationTimestamp } from '@/lib/format';
import { cn } from '@/lib/cn';
import { IconCallIncoming, IconCallOutgoing, IconPhone } from '@/components/icons';

/** apps/mobile's Calls-tab equivalent for web (docs/13-roadmap.md) — same source
 * data (`listCallHistory`), same row shape (name, direction, outcome, duration,
 * relative time), same "tap to call again" affordance. Group-call rows (`groupName`
 * set instead of `otherUser`) re-place a group call via `useGroupCall` rather than
 * `useCall` — the two are genuinely separate signaling paths (see
 * group-call-provider.tsx's own docstring), same split call_history_screen.dart's
 * dart port of this needed. */
export function CallHistoryView({ initialCalls }: { initialCalls: CallHistoryEntry[] }): React.JSX.Element {
  const { startCall } = useCall();
  const { startGroupCall } = useGroupCall();

  if (initialCalls.length === 0) {
    return (
      <div className="flex flex-col items-center gap-2 py-16 text-center text-muted-foreground">
        <IconPhone className="h-8 w-8" />
        <p className="text-sm">No calls yet — calls you make or receive will show up here.</p>
      </div>
    );
  }

  function callAgain(entry: CallHistoryEntry) {
    if (entry.groupName !== null) {
      startGroupCall(entry.conversationId, entry.groupName);
    } else if (entry.otherUser) {
      startCall(entry.conversationId, entry.otherUser.id, entry.otherUser.displayName);
    }
  }

  return (
    <div className="divide-y divide-border rounded-xl border border-border">
      {initialCalls.map((entry) => {
        const name = entry.groupName ?? entry.otherUser?.displayName ?? 'Unknown';
        const isIncoming = entry.direction === 'incoming';
        const missedOrDeclined = entry.status !== 'answered';
        // Same WhatsApp convention call_history_screen.dart's `_CallRow` follows:
        // red is reserved for a missed/declined call on the RECEIVING end — an
        // unanswered outgoing call is unremarkable, a missed incoming one isn't.
        const flagged = isIncoming && missedOrDeclined;

        return (
          <button
            key={entry.id}
            type="button"
            onClick={() => callAgain(entry)}
            className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-muted"
          >
            <Avatar name={name} size="md" />
            <div className="min-w-0 flex-1">
              <p className={cn('truncate text-sm font-medium', flagged ? 'text-danger' : 'text-foreground')}>{name}</p>
              <div className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
                {isIncoming ? (
                  <IconCallIncoming className={cn('h-3.5 w-3.5', flagged ? 'text-danger' : 'text-primary')} />
                ) : (
                  <IconCallOutgoing className="h-3.5 w-3.5 text-primary" />
                )}
                <span>{subtitleFor(entry)}</span>
              </div>
            </div>
            <span className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full text-primary hover:bg-primary/10" title="Call again">
              <IconPhone className="h-4 w-4" />
            </span>
          </button>
        );
      })}
    </div>
  );
}

function subtitleFor(entry: CallHistoryEntry): string {
  const isIncoming = entry.direction === 'incoming';
  const outcome =
    entry.status === 'missed'
      ? isIncoming
        ? 'Missed'
        : 'No answer'
      : entry.status === 'declined'
        ? 'Declined'
        : isIncoming
          ? 'Incoming'
          : 'Outgoing';
  const duration = callDuration(entry);
  const time = formatConversationTimestamp(entry.createdAt);
  return duration ? `${outcome} · ${formatDuration(duration)} · ${time}` : `${outcome} · ${time}`;
}

/** Null when the call was never answered (nothing to measure) or, defensively, if
 * either timestamp is somehow missing/malformed despite `status === 'answered'` —
 * same guard call_history_screen.dart's `callDuration()` applies. */
function callDuration(entry: CallHistoryEntry): number | null {
  if (entry.status !== 'answered' || !entry.startedAt || !entry.endedAt) return null;
  const start = new Date(entry.startedAt).getTime();
  const end = new Date(entry.endedAt).getTime();
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) return null;
  return Math.round((end - start) / 1000);
}

function formatDuration(totalSeconds: number): string {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60)
    .toString()
    .padStart(2, '0');
  const s = Math.floor(totalSeconds % 60)
    .toString()
    .padStart(2, '0');
  return h > 0 ? `${h}:${m}:${s}` : `${m}:${s}`;
}
