'use client';

import { useState } from 'react';
import type { GroupSummary, GroupMemberDto } from '@comm/types';
import { apiFetch, ApiError } from '@/lib/api-client';
import { Avatar } from '../chat/avatar';
import { Dialog } from '../ui/dialog';
import { IconTrash, IconUsers } from '../icons';

/**
 * Group info — asked for as a home for the "only admins can message" toggle
 * (docs/13-roadmap.md's Groups "Remaining" note: the field and its server-side
 * enforcement, `PATCH /api/groups/:id`, both already existed — see
 * server/modules/groups/service.ts's `updateGroup` — there was just no client UI
 * anywhere to flip it). Mirrors apps/mobile's `group_info_screen.dart` feature set
 * (member list, add/remove member) rather than a full-page route: this app has no
 * "info" full-page pattern for anything (message info, blocked users aside — those
 * ARE pages, but this needs to open from mid-conversation, same reasoning
 * ForwardDialog/MessageInfoDialog in group-message-thread.tsx already use a modal
 * instead of navigating away from the open thread).
 *
 * Wraps the header's avatar+name block AS the open trigger (tap the group name to
 * see its info) rather than adding a separate icon button next to
 * `GroupCallButton` — one obvious, discoverable target instead of a second small
 * icon crowding an already-busy header row.
 */
export function GroupInfoTrigger({
  group: initialGroup,
  timerLabel,
}: {
  group: GroupSummary;
  timerLabel: string | null;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [group, setGroup] = useState(initialGroup);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex min-w-0 flex-1 items-center gap-2 rounded-lg py-1 text-left hover:bg-muted"
      >
        <Avatar name={group.name} size="sm" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-foreground">{group.name}</p>
          <p className="truncate text-xs text-muted-foreground">
            {timerLabel ?? `${group.members.length} member${group.members.length === 1 ? '' : 's'}`}
          </p>
        </div>
      </button>
      <Dialog open={open} onClose={() => setOpen(false)} title="Group info">
        <GroupInfoBody group={group} onGroupChange={setGroup} />
      </Dialog>
    </>
  );
}

function GroupInfoBody({
  group,
  onGroupChange,
}: {
  group: GroupSummary;
  onGroupChange: (group: GroupSummary) => void;
}): React.JSX.Element {
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const isAdmin = group.callerRole === 'admin';

  async function toggleOnlyAdminsCanMessage(next: boolean) {
    setBusy(true);
    setError(undefined);
    try {
      const updated = await apiFetch<GroupSummary>(`/api/groups/${group.id}`, {
        method: 'PATCH',
        body: { onlyAdminsCanMessage: next },
      });
      onGroupChange(updated);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not change that setting.');
    } finally {
      setBusy(false);
    }
  }

  async function addMember() {
    const username = window.prompt('Username to add:');
    if (!username || !username.trim()) return;
    setBusy(true);
    setError(undefined);
    try {
      const updated = await apiFetch<GroupSummary>(`/api/groups/${group.id}/members`, {
        method: 'POST',
        body: { username: username.trim() },
      });
      onGroupChange(updated);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not add that member.');
    } finally {
      setBusy(false);
    }
  }

  async function removeMember(member: GroupMemberDto) {
    if (!window.confirm(`Remove ${member.displayName} from ${group.name}?`)) return;
    setBusy(true);
    setError(undefined);
    try {
      const updated = await apiFetch<GroupSummary>(`/api/groups/${group.id}/members/${member.userId}`, {
        method: 'DELETE',
      });
      onGroupChange(updated);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not remove that member.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-col items-center gap-2 text-center">
        <Avatar name={group.name} size="lg" />
        <p className="text-base font-semibold text-foreground">{group.name}</p>
        {group.description && <p className="text-sm text-muted-foreground">{group.description}</p>}
      </div>

      {isAdmin && (
        <label className="flex items-center justify-between gap-3 rounded-lg border border-border px-3 py-2.5">
          <span className="min-w-0">
            <span className="block text-sm font-medium text-foreground">Only admins can message</span>
            <span className="block text-xs text-muted-foreground">Other members can still read, react, and call.</span>
          </span>
          <input
            type="checkbox"
            checked={group.onlyAdminsCanMessage}
            disabled={busy}
            onChange={(e) => void toggleOnlyAdminsCanMessage(e.target.checked)}
            className="h-5 w-5 flex-shrink-0 accent-primary"
          />
        </label>
      )}

      {error && <p className="text-sm text-danger">{error}</p>}

      <div>
        <div className="mb-1.5 flex items-center justify-between">
          <p className="text-sm font-semibold text-foreground">{group.members.length} members</p>
          <button
            type="button"
            onClick={() => void addMember()}
            disabled={busy}
            className="flex items-center gap-1 text-xs font-medium text-primary hover:underline disabled:opacity-50"
          >
            <IconUsers className="h-3.5 w-3.5" /> Add
          </button>
        </div>
        <div className="space-y-0.5">
          {group.members.map((m) => (
            <div key={m.userId} className="flex items-center gap-3 rounded-lg px-2 py-1.5 hover:bg-muted">
              <Avatar name={m.displayName} size="sm" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm text-foreground">{m.displayName}</p>
                <p className="truncate text-xs text-muted-foreground">
                  @{m.username}
                  {m.role === 'admin' ? ' · Admin' : ''}
                </p>
              </div>
              {isAdmin && m.role !== 'admin' && (
                <button
                  type="button"
                  onClick={() => void removeMember(m)}
                  disabled={busy}
                  aria-label={`Remove ${m.displayName}`}
                  title={`Remove ${m.displayName}`}
                  className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-danger/10 hover:text-danger disabled:opacity-50"
                >
                  <IconTrash className="h-4 w-4" />
                </button>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
