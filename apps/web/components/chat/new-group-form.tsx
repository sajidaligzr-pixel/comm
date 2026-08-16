'use client';

import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import type { GroupSummary } from '@comm/types';
import { Button } from '../ui/button';
import { Input, Label, FieldError } from '../ui/input';
import { apiFetch, ApiError } from '@/lib/api-client';
import { IconX } from '../icons';

interface PendingMember {
  id: string;
  username: string;
  displayName: string;
}

/** "Create group" — member-adding reuses the existing single-username-lookup
 * endpoint (`GET /api/users/:username`, the same one `NewChatForm` uses to start a
 * 1:1 conversation) rather than a new list-all-users endpoint, so this doesn't open
 * a new enumeration surface (docs/13-roadmap.md's group chat pass). */
export function NewGroupForm({ onDone }: { onDone: () => void }): React.JSX.Element {
  const router = useRouter();
  const [name, setName] = useState('');
  const [usernameInput, setUsernameInput] = useState('');
  const [pending, setPending] = useState<PendingMember[]>([]);
  const [addError, setAddError] = useState<string | undefined>();
  const [submitError, setSubmitError] = useState<string | undefined>();
  const [resolving, setResolving] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  async function handleAddMember(e: FormEvent) {
    e.preventDefault();
    const username = usernameInput.trim().toLowerCase();
    if (!username) return;
    setAddError(undefined);
    if (pending.some((m) => m.username === username)) {
      setAddError('Already added.');
      return;
    }
    setResolving(true);
    try {
      const profile = await apiFetch<{ id: string; username: string; displayName: string }>(`/api/users/${username}`);
      setPending((prev) => [...prev, { id: profile.id, username: profile.username, displayName: profile.displayName }]);
      setUsernameInput('');
    } catch (err) {
      setAddError(err instanceof ApiError ? err.message : 'Could not find that user.');
    } finally {
      setResolving(false);
    }
  }

  function removeMember(id: string) {
    setPending((prev) => prev.filter((m) => m.id !== id));
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!name.trim() || pending.length === 0) return;
    setSubmitError(undefined);
    setSubmitting(true);
    try {
      const group = await apiFetch<GroupSummary>('/api/groups', {
        body: { name: name.trim(), memberUsernames: pending.map((m) => m.username) },
      });
      onDone();
      router.push(`/chats/${group.conversationId}`);
      router.refresh();
    } catch (err) {
      setSubmitError(err instanceof ApiError ? err.message : 'Could not create that group.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div>
        <Label htmlFor="group-name">Group name</Label>
        <Input id="group-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Weekend Trip" autoFocus />
      </div>

      <div>
        <Label htmlFor="group-member">Add members</Label>
        <div className="flex gap-2">
          <Input
            id="group-member"
            value={usernameInput}
            onChange={(e) => setUsernameInput(e.target.value)}
            placeholder="Username"
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                void handleAddMember(e);
              }
            }}
          />
          <Button type="button" variant="secondary" disabled={resolving || !usernameInput.trim()} onClick={(e) => void handleAddMember(e)}>
            {resolving ? 'Adding…' : 'Add'}
          </Button>
        </div>
        <FieldError>{addError}</FieldError>
      </div>

      {pending.length > 0 && (
        <ul className="space-y-1.5">
          {pending.map((m) => (
            <li key={m.id} className="flex items-center justify-between rounded-lg bg-muted px-3 py-2 text-sm">
              <span className="text-foreground">
                {m.displayName} <span className="text-muted-foreground">@{m.username}</span>
              </span>
              <button
                type="button"
                onClick={() => removeMember(m.id)}
                aria-label={`Remove ${m.displayName}`}
                className="flex h-6 w-6 items-center justify-center rounded-full text-muted-foreground hover:bg-background hover:text-foreground"
              >
                <IconX className="h-3.5 w-3.5" />
              </button>
            </li>
          ))}
        </ul>
      )}

      <FieldError>{submitError}</FieldError>
      <Button type="submit" className="w-full" disabled={submitting || !name.trim() || pending.length === 0}>
        {submitting ? 'Creating…' : `Create group${pending.length > 0 ? ` (${pending.length + 1} members)` : ''}`}
      </Button>
    </form>
  );
}
