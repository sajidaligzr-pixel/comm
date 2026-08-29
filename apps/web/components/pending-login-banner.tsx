'use client';

import { useEffect, useState } from 'react';
import { usePathname } from 'next/navigation';
import type { PendingDeviceLoginSummary } from '@comm/types';
import { Button } from './ui/button';
import { apiFetch, ApiError } from '@/lib/api-client';
import { onRealtimeEvent } from '@/lib/realtime-client';

/**
 * Surfaces a pending new-device sign-in request (docs/07-auth-architecture.md's
 * device-approval section) as a full-width bar under the header, on every (app)
 * page — not just something you'd only see by opening Devices. A sign-in request
 * needs a fast response (someone is actively waiting on the other end), and there
 * was no nav link pointing at Devices at all before this, so "go check Devices"
 * wasn't a reliable path. This is the in-app, can't-miss equivalent of the push
 * notification `apps/worker` already sends for the same event — same
 * fetch-on-mount + live-WS-refresh relationship `PendingLoginsPanel` (rendered
 * inline on the Devices page itself) already uses, just promoted to the app shell.
 * Hidden on /devices, where that panel already covers the identical request
 * inline — showing both at once would just be a duplicate.
 */
export function PendingLoginBanner(): React.JSX.Element | null {
  const pathname = usePathname();
  const [pending, setPending] = useState<PendingDeviceLoginSummary[]>([]);
  const [busyId, setBusyId] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();

  async function load() {
    try {
      const rows = await apiFetch<PendingDeviceLoginSummary[]>('/api/devices/pending', { method: 'GET' });
      setPending(rows);
    } catch {
      // Convenience surface only — the Devices page's own panel is the durable
      // source of truth if this fetch happens to fail.
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
      setPending((prev) => prev.filter((p) => p.id !== id));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not respond to that request.');
    } finally {
      setBusyId(undefined);
    }
  }

  if (pathname?.startsWith('/devices') || pending.length === 0) return null;

  return (
    <div className="flex flex-shrink-0 flex-col gap-2 border-b border-amber-300 bg-amber-50 px-4 py-3 dark:border-amber-800 dark:bg-amber-950/40">
      {error && <p className="text-sm text-danger">{error}</p>}
      {pending.map((req) => (
        <div key={req.id} className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-foreground">
            <span className="font-medium">{req.name}</span> wants to sign in. If this wasn&apos;t you, deny it.
          </p>
          <div className="flex gap-2">
            <Button
              variant="secondary"
              disabled={busyId === req.id}
              onClick={() => respond(req.id, false)}
              className="h-8 px-3 text-xs"
            >
              Deny
            </Button>
            <Button disabled={busyId === req.id} onClick={() => respond(req.id, true)} className="h-8 px-3 text-xs">
              {busyId === req.id ? 'Approving…' : 'Approve'}
            </Button>
          </div>
        </div>
      ))}
    </div>
  );
}
