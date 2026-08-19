'use client';

/**
 * Block/unblock the other participant of a direct conversation (docs/13-roadmap.md's
 * blocked-users pass) — see blocking/service.ts's own docstring for exactly what
 * this does and doesn't enforce. Mirrors disappearing-timer-menu.tsx's own
 * optimistic-update-then-`router.refresh()` shape.
 */
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { apiFetch, ApiError } from '@/lib/api-client';
import { cn } from '@/lib/cn';
import { IconBlock } from '../icons';

export function BlockUserButton({
  username,
  displayName,
  initiallyBlocked,
}: {
  username: string;
  displayName: string;
  initiallyBlocked: boolean;
}): React.JSX.Element {
  const router = useRouter();
  const [blocked, setBlocked] = useState(initiallyBlocked);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  async function toggle() {
    const next = !blocked;
    const confirmed = window.confirm(
      next
        ? `Block ${displayName}? They won't be able to message or call you, and you won't be able to message or call them.`
        : `Unblock ${displayName}?`,
    );
    if (!confirmed) return;

    setBusy(true);
    setError(undefined);
    try {
      if (next) {
        await apiFetch('/api/blocked-users', { method: 'POST', body: { username } });
      } else {
        // The block list only ever has one row per (caller, target) pair, and
        // this button already knows the target's username, not their id — the
        // route takes an id (blocked-users.tsx's list view is what has that),
        // so resolve it via the same list fetch rather than adding a second
        // by-username unblock route for what's otherwise a one-line query.
        const list = await apiFetch<Array<{ userId: string; username: string }>>('/api/blocked-users');
        const row = list.find((r) => r.username === username);
        if (row) await apiFetch(`/api/blocked-users/${row.userId}`, { method: 'DELETE' });
      }
      setBlocked(next);
      router.refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not update this setting.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => void toggle()}
        disabled={busy}
        aria-label={blocked ? `Unblock ${displayName}` : `Block ${displayName}`}
        title={blocked ? `Unblock ${displayName}` : `Block ${displayName}`}
        className={cn(
          'flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50',
          blocked && 'text-danger',
        )}
      >
        <IconBlock className="h-5 w-5" />
      </button>
      {error && <p className="absolute right-0 top-10 z-20 w-48 rounded-lg border border-border bg-background p-2 text-xs text-danger shadow-lg">{error}</p>}
    </div>
  );
}
