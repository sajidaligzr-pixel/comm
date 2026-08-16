'use client';

import { useEffect, useState } from 'react';
import { getCurrentKek } from '@/lib/crypto/kek-holder';
import { apiFetch } from '@/lib/api-client';
import { isPlatformAuthenticatorAvailable, isBiometricUnlockEnabled, enableBiometricUnlock } from '@/lib/crypto/biometric-unlock';
import { Button } from './ui/button';
import { IconFingerprint, IconX } from './icons';

const DISMISSED_KEY = 'comm-biometric-dismissed-at';
const DISMISS_SNOOZE_MS = 14 * 24 * 60 * 60 * 1000; // don't re-nag for 2 weeks — same as notification-prompt.tsx

function recentlyDismissed(): boolean {
  const raw = localStorage.getItem(DISMISSED_KEY);
  if (!raw) return false;
  return Date.now() - Number(raw) < DISMISS_SNOOZE_MS;
}

/**
 * Opt-in biometric-unlock prompt — asked for directly ("add a pop up with which user
 * can unlock the biometric"), mirroring notification-prompt.tsx's exact shape (same
 * ask-once/snooze-on-dismiss reasoning) for the app's other one-time setup offer.
 * Until this existed, turning on biometric unlock required already knowing to go find
 * it on the Devices page — which itself had no nav entry point at all until the same
 * live bug report that asked for this ((app)/layout.tsx).
 *
 * Mounted from unlock-gate.tsx's *unlocked* branch specifically, not the app shell's
 * top level the way NotificationPrompt is: enrolling wraps the real KEK
 * (lib/crypto/biometric-unlock.ts#enableBiometricUnlock), which only exists in memory
 * once the device is actually unlocked — showing this any earlier would have nothing
 * to wrap. Positioned bottom instead of NotificationPrompt's top so the two can never
 * visually collide if both happen to be showing on the same first-run screen.
 */
export function BiometricEnrollPrompt(): React.JSX.Element | null {
  const [visible, setVisible] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    void (async () => {
      try {
        if (recentlyDismissed()) return;
        const [available, alreadyEnabled] = await Promise.all([isPlatformAuthenticatorAvailable(), isBiometricUnlockEnabled()]);
        if (available && !alreadyEnabled) setVisible(true);
      } catch {
        // Fail closed, same as every other capability check in this feature — worst
        // case the prompt just never offers itself, never a crash.
      }
    })();
  }, []);

  function dismiss() {
    localStorage.setItem(DISMISSED_KEY, String(Date.now()));
    setVisible(false);
  }

  async function enable() {
    setBusy(true);
    setError(undefined);
    try {
      const kek = getCurrentKek();
      if (!kek) {
        // Shouldn't happen given where this is mounted, but this component makes no
        // assumption about its caller beyond "rendered somewhere" — it checks rather
        // than trusts its own placement.
        setError('This device needs to be unlocked first.');
        return;
      }
      const profile = await apiFetch<{ id: string; username: string }>('/api/users/me');
      const ok = await enableBiometricUnlock(kek, profile.id, profile.username);
      if (!ok) {
        setError('This browser or device doesn’t support biometric unlock.');
        return;
      }
      setVisible(false);
    } catch {
      setError('Could not turn this on right now. You can try again later from Devices.');
    } finally {
      setBusy(false);
    }
  }

  if (!visible) return null;

  return (
    <div
      role="dialog"
      aria-label="Turn on biometric unlock"
      className="fixed inset-x-3 bottom-3 z-50 mx-auto flex max-w-sm items-start gap-3 rounded-2xl border border-border bg-background p-3 shadow-lg sm:inset-x-auto sm:bottom-4 sm:right-4"
    >
      <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
        <IconFingerprint className="h-5 w-5" />
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-foreground">Unlock with your fingerprint?</p>
        <p className="mt-0.5 text-xs text-muted-foreground">
          Skip typing your password on this device from now on. Your account password is never replaced — it still works everywhere
          else.
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
