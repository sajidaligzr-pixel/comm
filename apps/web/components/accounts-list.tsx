'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from './ui/button';
import { Card } from './ui/card';
import { Dialog } from './ui/dialog';
import { apiFetch, ApiError } from '@/lib/api-client';

export interface AccountSummary {
  id: string;
  username: string;
  displayName: string;
  status: string;
  createdAt: string;
}

/**
 * Admin's "All accounts" list — was a static, action-less list before this
 * (admin/page.tsx), since suspend (DELETE /api/admin/users/:id/suspend) never got
 * a client to call it either. This adds the one action asked for directly:
 * permanently deleting an account. See adminDeleteUser's own docstring
 * (server/modules/admin/service.ts) for exactly what that does beyond the account
 * row itself — every direct conversation this user was part of is gone entirely,
 * and their own messages inside any group they belonged to are tombstoned.
 * Confirmed via a dialog, not a bare button — this is meaningfully more
 * destructive/irreversible than revoking a device.
 */
export function AccountsList({ initialUsers }: { initialUsers: AccountSummary[] }): React.JSX.Element {
  const router = useRouter();
  const [users, setUsers] = useState(initialUsers);
  const [target, setTarget] = useState<AccountSummary | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [deleting, setDeleting] = useState(false);

  function close() {
    if (deleting) return;
    setTarget(undefined);
    setError(undefined);
  }

  async function confirmDelete() {
    if (!target) return;
    setError(undefined);
    setDeleting(true);
    try {
      await apiFetch(`/api/admin/users/${target.id}`, { method: 'DELETE' });
      setUsers((prev) => prev.filter((u) => u.id !== target.id));
      setTarget(undefined);
      router.refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not delete that account.');
    } finally {
      setDeleting(false);
    }
  }

  if (users.length === 0) {
    return <p className="text-sm text-muted-foreground">No accounts yet.</p>;
  }

  return (
    <>
      <div className="space-y-2">
        {users.map((u) => (
          <Card key={u.id} className="flex items-center justify-between p-3">
            <div>
              <p className="text-sm font-medium text-foreground">
                {u.displayName} <span className="text-muted-foreground">@{u.username}</span>
              </p>
              <p className="text-xs text-muted-foreground">
                {u.status} · created {new Date(u.createdAt).toLocaleDateString()}
              </p>
            </div>
            {u.status !== 'deleted' && (
              <Button variant="danger" onClick={() => setTarget(u)}>
                Delete
              </Button>
            )}
          </Card>
        ))}
      </div>

      <Dialog open={target !== undefined} onClose={close} title="Delete this account?">
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">
            This permanently deletes <strong>@{target?.username}</strong>&apos;s account. Every direct
            conversation they&apos;re part of is deleted entirely for everyone in it, and their own messages
            inside any group they belong to are removed too. Groups themselves, and other members&apos; own
            messages in them, are left alone. This can&apos;t be undone.
          </p>
          {error && <p className="text-sm text-danger">{error}</p>}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={close} disabled={deleting}>
              Cancel
            </Button>
            <Button variant="danger" onClick={confirmDelete} disabled={deleting}>
              {deleting ? 'Deleting…' : 'Delete account'}
            </Button>
          </div>
        </div>
      </Dialog>
    </>
  );
}
