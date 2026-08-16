'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { DisappearingTimer } from '@comm/types';
import { cn } from '@/lib/cn';
import { apiFetch, ApiError } from '@/lib/api-client';
import { IconCheck, IconClock } from '../icons';

const OPTIONS: { value: DisappearingTimer; label: string }[] = [
  { value: 'off', label: 'Off' },
  { value: 'h24', label: '24 hours' },
  { value: 'd7', label: '7 days' },
  { value: 'd30', label: '30 days' },
];

/**
 * Either participant can change this — a shared conversation setting, not owned by
 * whoever turned it on (server/modules/conversations/service.ts's
 * `updateDisappearingTimer`). Enforcement is `apps/worker`'s hourly sweep
 * (jobs/cleanup.ts) plus this device's own local pruning
 * (message-thread.tsx's `disappearingTimerMs` prop) for a more immediate feel.
 */
export function DisappearingTimerMenu({
  conversationId,
  initialTimer,
}: {
  conversationId: string;
  initialTimer: DisappearingTimer;
}): React.JSX.Element {
  const router = useRouter();
  const [timer, setTimer] = useState(initialTimer);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onClickOutside);
    return () => document.removeEventListener('mousedown', onClickOutside);
  }, [open]);

  async function choose(value: DisappearingTimer) {
    if (value === timer) {
      setOpen(false);
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      await apiFetch(`/api/conversations/${conversationId}`, { method: 'PATCH', body: { disappearingTimer: value } });
      setTimer(value);
      setOpen(false);
      router.refresh(); // re-fetches the server-rendered subtitle text below the name
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not update this setting.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label="Disappearing messages settings"
        aria-expanded={open}
        title="Disappearing messages"
        className={cn(
          'flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground',
          timer !== 'off' && 'text-primary',
        )}
      >
        <IconClock className="h-5 w-5" />
      </button>
      {open && (
        <div className="absolute right-0 top-10 z-20 w-56 overflow-hidden rounded-xl border border-border bg-background py-1 shadow-lg">
          <p className="px-3 pb-1.5 pt-2 text-xs font-medium text-muted-foreground">Disappearing messages</p>
          {OPTIONS.map((opt) => (
            <button
              key={opt.value}
              type="button"
              disabled={busy}
              onClick={() => void choose(opt.value)}
              className="flex w-full items-center justify-between px-3 py-2 text-left text-sm hover:bg-muted disabled:opacity-50"
            >
              {opt.label}
              {timer === opt.value && <IconCheck className="h-4 w-4 text-primary" />}
            </button>
          ))}
          {error && <p className="px-3 pt-1 text-xs text-danger">{error}</p>}
        </div>
      )}
    </div>
  );
}
