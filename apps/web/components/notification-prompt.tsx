'use client';

import { useEffect, useState } from 'react';
import { apiFetch } from '@/lib/api-client';
import { Button } from './ui/button';
import { IconBell, IconX } from './icons';

const DISMISSED_KEY = 'comm-notifications-dismissed-at';
const DISMISS_SNOOZE_MS = 14 * 24 * 60 * 60 * 1000; // don't re-nag for 2 weeks

function recentlyDismissed(): boolean {
  const raw = localStorage.getItem(DISMISSED_KEY);
  if (!raw) return false;
  return Date.now() - Number(raw) < DISMISS_SNOOZE_MS;
}

// Web Push wants the VAPID key as a raw Uint8Array; it's distributed/configured as a
// base64url string (.env.example's NEXT_PUBLIC_VAPID_PUBLIC_KEY).
function urlBase64ToUint8Array(base64Url: string): Uint8Array {
  const padding = '='.repeat((4 - (base64Url.length % 4)) % 4);
  const base64 = (base64Url + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

/**
 * Opt-in Web Push prompt (docs/13-roadmap.md's push notification pass) — never
 * auto-requested: `Notification.requestPermission()` needs a real user gesture to
 * not be silently auto-denied by the browser anyway, so the explicit click-through
 * here is both a privacy courtesy and a technical requirement. Positioned top-right
 * (unlike `InstallPrompt`'s bottom-right) so the two banners can never visually
 * collide if both happen to be showing on the same authenticated page. Mounted in
 * `(app)/layout.tsx`, not the root layout — notifications are meaningless before
 * sign-in, and asking on the login page would be a strange, premature ask.
 */
export function NotificationPrompt(): React.JSX.Element | null {
  const [visible, setVisible] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (!('Notification' in window) || !('serviceWorker' in navigator) || !('PushManager' in window)) return;
    if (!process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY) return; // no coturn-style "not configured yet" — nothing to offer
    if (Notification.permission !== 'default' || recentlyDismissed()) return;
    setVisible(true);
  }, []);

  function dismiss() {
    localStorage.setItem(DISMISSED_KEY, String(Date.now()));
    setVisible(false);
  }

  async function enable() {
    setBusy(true);
    setError(undefined);
    try {
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') {
        // A denial is final in every major browser (no re-prompt possible from
        // script) — hiding the banner rather than leaving a dead "Enable" button.
        setVisible(false);
        return;
      }
      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        // The DOM lib's `BufferSource` type is parameterized over plain
        // `ArrayBuffer` only; a `Uint8Array` is always backed by a real
        // (never-shared) buffer here, this satisfies the runtime contract exactly
        // as-is, just not the generic's strict parameterization.
        applicationServerKey: urlBase64ToUint8Array(process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY!) as BufferSource,
      });
      const json = subscription.toJSON();
      await apiFetch('/api/push/subscribe', {
        method: 'POST',
        body: { endpoint: json.endpoint, keys: json.keys },
      });
      setVisible(false);
    } catch {
      setError('Could not turn on notifications. You can try again later.');
    } finally {
      setBusy(false);
    }
  }

  if (!visible) return null;

  return (
    <div
      role="dialog"
      aria-label="Turn on notifications"
      className="fixed inset-x-3 top-3 z-50 mx-auto flex max-w-sm items-start gap-3 rounded-2xl border border-border bg-background p-3 shadow-lg sm:inset-x-auto sm:right-4 sm:top-4"
    >
      <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
        <IconBell className="h-5 w-5" />
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-foreground">Turn on notifications?</p>
        <p className="mt-0.5 text-xs text-muted-foreground">
          Get notified when a new message arrives. The notification never shows the message itself — this app can&apos;t read it either.
        </p>
        {error && <p className="mt-1 text-xs text-danger">{error}</p>}
        <div className="mt-2 flex gap-2">
          <Button onClick={() => void enable()} disabled={busy} className="h-8 px-3 text-xs">
            {busy ? 'Enabling…' : 'Enable'}
          </Button>
          <Button variant="ghost" onClick={dismiss} disabled={busy} className="h-8 px-3 text-xs">
            Not now
          </Button>
        </div>
      </div>
      <button
        type="button"
        onClick={dismiss}
        aria-label="Dismiss"
        className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground"
      >
        <IconX className="h-4 w-4" />
      </button>
    </div>
  );
}
