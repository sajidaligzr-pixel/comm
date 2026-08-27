'use client';

import { useEffect, useState } from 'react';
import type { PendingDeviceLoginSummary } from '@comm/types';
import { Button } from './ui/button';
import { Card } from './ui/card';
import { apiFetch, ApiError } from '@/lib/api-client';
import { onRealtimeEvent } from '@/lib/realtime-client';

/**
 * "Send a notification to the other device to approve it first" —
 * docs/07-auth-architecture.md's device-approval section. The REST fetch here is
 * the durable source of truth (covers a device that missed the live nudge because
 * it wasn't open); the `login_pending` WS subscription just re-fetches promptly
 * when this tab happens to be open at the moment someone else tries to sign in,
 * same "WS is the fast path, REST is durable" relationship group-key-share catch-up
 * already has.
 */
export function PendingLoginsPanel(): React.JSX.Element | null {
  const [pending, setPending] = useState<PendingDeviceLoginSummary[] | null>(null);
  const [busyId, setBusyId] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();

  async function load() {
    try {
      const rows = await apiFetch<PendingDeviceLoginSummary[]>('/api/devices/pending', { method: 'GET' });
      setPending(rows);
    } catch {
      // Non-critical view — a failed fetch here just means this panel stays
      // hidden rather than blocking the rest of the Devices page.
      setPending([]);
    }
  }

  useEffect(() => {
    void load();
    return onRealtimeEvent('login_pending', () => void load());
  }, []);

  async function respond(id: string, approve: boolean) {
    setError(undefined);
    setBusyId(id);
    try {
      await apiFetch(`/api/devices/pending/${id}`, { body: { approve } });
      setPending((prev) => (prev ?? []).filter((p) => p.id !== id));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not respond to that request.');
    } finally {
      setBusyId(undefined);
    }
  }

  if (!pending || pending.length === 0) return null;

  return (
    <div className="space-y-2">
      <h2 className="text-sm font-medium text-foreground">Sign-in requests</h2>
      {error && <p className="text-sm text-danger">{error}</p>}
      {pending.map((req) => (
        <Card key={req.id} className="flex items-center justify-between gap-3 p-4">
          <div>
            <p className="text-sm font-medium text-foreground">{req.name} wants to sign in</p>
            <p className="text-xs text-muted-foreground">If this wasn&apos;t you, deny it.</p>
          </div>
          <div className="flex gap-2">
            <Button variant="secondary" disabled={busyId === req.id} onClick={() => respond(req.id, false)}>
              Deny
            </Button>
            <Button disabled={busyId === req.id} onClick={() => respond(req.id, true)}>
              {busyId === req.id ? 'Approving…' : 'Approve'}
            </Button>
          </div>
        </Card>
      ))}
    </div>
  );
}
