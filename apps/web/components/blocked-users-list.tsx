'use client';

import { useState } from 'react';
import type { BlockedUserDto } from '@comm/types';
import { apiFetch, ApiError } from '@/lib/api-client';
import { Avatar } from './chat/avatar';

export function BlockedUsersList({ initialBlocked }: { initialBlocked: BlockedUserDto[] }): React.JSX.Element {
  const [blocked, setBlocked] = useState(initialBlocked);
  const [error, setError] = useState<string | undefined>();

  async function unblock(row: BlockedUserDto) {
    const previous = blocked;
    setBlocked((prev) => prev.filter((b) => b.userId !== row.userId));
    try {
      await apiFetch(`/api/blocked-users/${row.userId}`, { method: 'DELETE' });
    } catch (err) {
      setBlocked(previous);
      setError(err instanceof ApiError ? err.message : 'Could not unblock this user.');
    }
  }

  if (blocked.length === 0) {
    return <p className="text-sm text-muted-foreground">You haven&apos;t blocked anyone.</p>;
  }

  return (
    <div className="space-y-1">
      {error && <p className="text-sm text-danger">{error}</p>}
      {blocked.map((row) => (
        <div key={row.userId} className="flex items-center gap-3 rounded-lg border border-border px-3 py-2">
          <Avatar name={row.displayName} size="sm" />
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium text-foreground">{row.displayName}</p>
            <p className="truncate text-xs text-muted-foreground">@{row.username}</p>
          </div>
          <button
            type="button"
            onClick={() => void unblock(row)}
            className="flex-shrink-0 rounded-full border border-border px-3 py-1.5 text-xs font-medium text-foreground hover:bg-muted"
          >
            Unblock
          </button>
        </div>
      ))}
    </div>
  );
}
