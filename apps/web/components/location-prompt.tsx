'use client';

import { useEffect, useRef, useState } from 'react';
import { apiFetch } from '@/lib/api-client';
import { Button } from './ui/button';
import { IconMapPin, IconX } from './icons';

/**
 * Opt-in live-location-sharing prompt (docs/09-trust-boundaries.md's "Live
 * location sharing" exception) — the web counterpart to mobile's
 * `permissions_prompt.dart` location request. Every signed-in device (this one
 * included) may share its own location; no special privilege is needed to
 * *share*, only to *view* (`/admin/map`, gated separately). Mirrors
 * `NotificationPrompt`'s exact shape: gate on browser support, snooze on
 * dismiss, explicit user-gesture request (the browser silently auto-denies
 * `getCurrentPosition` without one anyway).
 *
 * Real, honest platform limit, not a bug: a browser tab can only report
 * location while it's actually open — there is no background/killed-tab
 * equivalent of mobile's foreground service. Reporting here is a simple
 * foreground poll (matching mobile's own foregrounded cadence) for as long as
 * this tab stays open and permission remains granted.
 *
 * Positioned bottom-left — the one corner neither `NotificationPrompt`
 * (top-right) nor `InstallPrompt` (bottom-right) uses, so all three can never
 * visually collide even if more than one shows on the same first session.
 */
const DISMISSED_KEY = 'comm-location-dismissed-at';
const ENABLED_KEY = 'comm-location-enabled';
const DISMISS_SNOOZE_MS = 14 * 24 * 60 * 60 * 1000; // don't re-nag for 2 weeks
const REPORT_INTERVAL_MS = 30_000;

function recentlyDismissed(): boolean {
  const raw = localStorage.getItem(DISMISSED_KEY);
  if (!raw) return false;
  return Date.now() - Number(raw) < DISMISS_SNOOZE_MS;
}

async function reportOnce(): Promise<void> {
  const position = await new Promise<GeolocationPosition>((resolve, reject) => {
    navigator.geolocation.getCurrentPosition(resolve, reject, { enableHighAccuracy: true, timeout: 20_000 });
  });
  await apiFetch('/api/locations', {
    method: 'POST',
    body: {
      latitude: position.coords.latitude,
      longitude: position.coords.longitude,
      accuracyM: position.coords.accuracy,
      headingDeg: position.coords.heading,
      speedMps: position.coords.speed,
      recordedAt: new Date(position.timestamp).toISOString(),
    },
  });
}

export function LocationPrompt(): React.JSX.Element | null {
  const [visible, setVisible] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  function startReporting() {
    if (intervalRef.current) return;
    void reportOnce().catch(() => undefined);
    intervalRef.current = setInterval(() => void reportOnce().catch(() => undefined), REPORT_INTERVAL_MS);
  }

  useEffect(() => {
    if (typeof window === 'undefined' || !('geolocation' in navigator)) return;
    if (localStorage.getItem(ENABLED_KEY) === 'true') {
      // Already granted in a previous session on this browser — re-arm silently
      // on every load rather than asking again, mirroring
      // LocationServiceHooks.ensureStarted's "re-arm on every launch" behavior.
      startReporting();
      return;
    }
    if (recentlyDismissed()) return;
    setVisible(true);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, []);

  function dismiss() {
    localStorage.setItem(DISMISSED_KEY, String(Date.now()));
    setVisible(false);
  }

  async function enable() {
    setBusy(true);
    setError(undefined);
    try {
      await reportOnce();
      localStorage.setItem(ENABLED_KEY, 'true');
      startReporting();
      setVisible(false);
    } catch {
      // A denial (or any other failure) just hides the banner rather than
      // leaving a dead "Enable" button — same as NotificationPrompt's own
      // "denial is final" handling.
      setError('Could not turn on location sharing. You can try again later.');
      setVisible(false);
    } finally {
      setBusy(false);
    }
  }

  if (!visible) return null;

  return (
    <div
      role="dialog"
      aria-label="Share your live location"
      // Bottom-left — deliberately the one corner neither NotificationPrompt
      // (top-right) nor InstallPrompt (bottom-right) uses, so this can never
      // visually collide with either even if more than one shows at once.
      className="fixed inset-x-3 bottom-3 z-50 mx-auto flex max-w-sm items-start gap-3 rounded-2xl border border-border bg-background p-3 shadow-lg sm:inset-x-auto sm:bottom-4 sm:left-4"
    >
      <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
        <IconMapPin className="h-5 w-5" />
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-foreground">Share your live location?</p>
        <p className="mt-0.5 text-xs text-muted-foreground">
          Shares your location with this app&apos;s admins (and anyone they grant access to) for as long as this
          tab stays open.
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
