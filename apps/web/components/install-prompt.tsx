'use client';

import { useEffect, useState } from 'react';
import { Logo } from './logo';
import { Button } from './ui/button';
import { IconX } from './icons';

const DISMISSED_KEY = 'comm-install-dismissed-at';
const DISMISS_SNOOZE_MS = 14 * 24 * 60 * 60 * 1000; // don't re-nag for 2 weeks

type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
};

function isStandalone(): boolean {
  if (typeof window === 'undefined') return false;
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    // iOS Safari's own (non-standard) flag — no `display-mode` media query support there.
    (navigator as unknown as { standalone?: boolean }).standalone === true
  );
}

function isIos(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /iphone|ipad|ipod/i.test(navigator.userAgent);
}

function recentlyDismissed(): boolean {
  const raw = localStorage.getItem(DISMISSED_KEY);
  if (!raw) return false;
  return Date.now() - Number(raw) < DISMISS_SNOOZE_MS;
}

/**
 * A custom "Add to Home Screen" banner rather than relying on the browser's own
 * (Chrome no longer shows a prominent automatic prompt; iOS Safari has no
 * `beforeinstallprompt` at all — it's a manual Share-sheet action only, so that
 * platform gets its own instructional variant below). Installing just gets the app
 * its own window/home-screen icon; it does NOT mean offline support exists yet
 * (docs/13-roadmap.md's Phase 8) — the copy here doesn't claim otherwise.
 */
export function InstallPrompt(): React.JSX.Element | null {
  const [deferredPrompt, setDeferredPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [showIosHint, setShowIosHint] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    if ('serviceWorker' in navigator) {
      // Installability (and therefore `beforeinstallprompt` firing at all, on
      // Chromium) requires an active service worker — see public/sw.js's own note
      // on why it's deliberately a pass-through, not an offline cache.
      navigator.serviceWorker.register('/sw.js').catch(() => {
        // Registration failing (e.g. unsupported context) just means no install
        // prompt — never worth surfacing as a user-facing error.
      });
    }

    if (isStandalone() || recentlyDismissed()) return;

    function onBeforeInstallPrompt(e: Event) {
      e.preventDefault();
      setDeferredPrompt(e as BeforeInstallPromptEvent);
    }
    window.addEventListener('beforeinstallprompt', onBeforeInstallPrompt);

    if (isIos()) {
      setShowIosHint(true);
    }

    return () => window.removeEventListener('beforeinstallprompt', onBeforeInstallPrompt);
  }, []);

  function dismiss() {
    localStorage.setItem(DISMISSED_KEY, String(Date.now()));
    setDismissed(true);
  }

  async function install() {
    if (!deferredPrompt) return;
    await deferredPrompt.prompt();
    await deferredPrompt.userChoice; // resolved either way — nothing to branch on here
    setDeferredPrompt(null);
  }

  if (dismissed || (!deferredPrompt && !showIosHint)) return null;

  return (
    <div
      role="dialog"
      aria-label="Install Comm"
      className="fixed inset-x-3 bottom-3 z-50 mx-auto flex max-w-sm items-start gap-3 rounded-2xl border border-border bg-background p-3 shadow-lg sm:inset-x-auto sm:right-4 sm:bottom-4"
    >
      <Logo wordmark={false} className="h-9 w-9 flex-shrink-0" />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-foreground">Install Comm</p>
        {deferredPrompt ? (
          <>
            <p className="mt-0.5 text-xs text-muted-foreground">Add it to your home screen for quick, full-screen access.</p>
            <div className="mt-2 flex gap-2">
              <Button onClick={() => void install()} className="h-8 px-3 text-xs">
                Install
              </Button>
              <Button variant="ghost" onClick={dismiss} className="h-8 px-3 text-xs">
                Not now
              </Button>
            </div>
          </>
        ) : (
          <p className="mt-0.5 text-xs text-muted-foreground">
            Tap the Share icon, then &quot;Add to Home Screen&quot;, for quick full-screen access.
          </p>
        )}
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
