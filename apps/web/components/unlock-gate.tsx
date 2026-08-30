'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { apiFetch } from '@/lib/api-client';
import { getCurrentKek } from '@/lib/crypto/kek-holder';
import { completeUnlock } from '@/lib/crypto/complete-unlock';
import { unlockLocalIdentity } from '@/lib/crypto/identity';
import { setActiveAccount } from '@/lib/crypto/active-account';
import { isBiometricUnlockEnabled, isPlatformAuthenticatorAvailable, unlockWithBiometrics } from '@/lib/crypto/biometric-unlock';
import { ensureHistoryKey } from '@/lib/crypto/history-key';
import { BiometricEnrollPrompt } from './biometric-enroll-prompt';
import { Button } from './ui/button';
import { Input, Label, FieldError } from './ui/input';
import { Card } from './ui/card';
import { Logo } from './logo';
import { IconFingerprint } from './icons';

/**
 * Gates the authenticated app's content behind the local KEK actually being present
 * in memory — asked for directly ("the user does not need to login so many times").
 *
 * kek-holder.ts's KEK is deliberately in-memory-only, wiped on every page reload
 * (docs/05-crypto-architecture.md's local-key-storage design) — a real, intentional
 * security tradeoff, not something this weakens. What WAS a real gap: the only
 * documented way back from "no KEK" was the full `/login` page — re-entering a
 * username the still-valid server session already knows, and running the whole
 * login round trip again — even though the actual missing piece (the KEK) can be
 * re-derived entirely client-side from this browser's already-stored local identity
 * with just the password, no server round trip at all. `unlockLocalIdentity` is the
 * exact function `login-form.tsx`'s own "returning device" branch already uses for
 * this; this reaches it directly instead of forcing a full re-login through it.
 *
 * Mounted once around `(app)/layout.tsx`'s `children`. Every kek-dependent component
 * downstream (`message-thread.tsx`, `group-session-provider.tsx`, etc.) already has
 * its own inline "This device is locked" fallback for the case where a KEK truly
 * never arrives — gating here just means that fallback stops being the *normal*
 * experience on every single reload.
 *
 * Starts "locked" unconditionally, corrected in an effect rather than a lazy
 * `useState` initializer reading `getCurrentKek()` directly — this component is
 * server-rendered for the initial HTML like any Client Component, and the server has
 * no concept of a browser tab's in-memory KEK (it's always `null` there); matching
 * that on the client's first render and only flipping state in a post-mount effect
 * avoids a hydration mismatch, the same class of bug already found and fixed once
 * this session in conversation-list.tsx's timestamp rendering.
 */
export function UnlockGate({ children }: { children: React.ReactNode }): React.JSX.Element {
  const [unlocked, setUnlocked] = useState(false);
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | undefined>();
  const [submitting, setSubmitting] = useState(false);
  const [biometricAvailable, setBiometricAvailable] = useState(false);
  const [biometricBusy, setBiometricBusy] = useState(false);

  // Which account's local IndexedDB (identity, sessions, biometric wrap) this tab
  // should be reading/writing — unlike login-form.tsx, this component never has a
  // username typed into it (the server session already knows who's signed in), so it
  // has to ask. Cached as a shared in-flight promise so the mount effect and the two
  // submit handlers below all resolve to the exact same account no matter which
  // order/timing they run in, and so a fast click right after mount still waits for
  // the real answer instead of racing ahead un-scoped. See active-account.ts for why
  // this has to happen before ANY of identity.ts/biometric-unlock.ts's calls below.
  const accountReadyRef = useRef<Promise<void> | null>(null);
  function ensureAccountScoped(): Promise<void> {
    if (!accountReadyRef.current) {
      accountReadyRef.current = apiFetch<{ username: string }>('/api/users/me').then((profile) => {
        setActiveAccount(profile.username);
      });
    }
    return accountReadyRef.current;
  }

  useEffect(() => {
    if (getCurrentKek()) {
      setUnlocked(true);
      return;
    }
    void (async () => {
      try {
        await ensureAccountScoped();
        // Both checks are local/cheap (no OS prompt fires until the button is
        // actually tapped — see handleBiometricUnlock) — safe to run unconditionally
        // on mount, now that the right account's storage is in scope.
        const [enabled, platformAvailable] = await Promise.all([isBiometricUnlockEnabled(), isPlatformAuthenticatorAvailable()]);
        setBiometricAvailable(enabled && platformAvailable);
      } catch (err) {
        // Same reasoning as biometric-unlock-toggle.tsx's identical guard — fail
        // closed to "no biometric button," never leave this thrown silently.
        console.error('[biometric-unlock] capability check failed', err);
      }
    })();
  }, []);

  if (unlocked)
    return (
      <>
        {children}
        <BiometricEnrollPrompt />
      </>
    );

  async function handleBiometricUnlock() {
    setError(undefined);
    setBiometricBusy(true);
    try {
      await ensureAccountScoped();
      const result = await unlockWithBiometrics();
      if (!result) {
        // Never a thrown error (see biometric-unlock.ts) — could be a cancelled OS
        // prompt, a no-longer-valid enrollment (e.g. after a password change
        // elsewhere), or anything else; the password field right below is always
        // the real fallback, so this stays low-key rather than alarming.
        setError('Biometric unlock didn’t work — use your password below.');
        return;
      }
      completeUnlock(result.kek, result.identity);
      // No password available on this path — ensureHistoryKey falls back to
      // whatever's already cached locally from an earlier password unlock (see
      // its own docstring); never blocks getting into the app.
      void ensureHistoryKey(result.kek, null);
      setUnlocked(true);
    } finally {
      setBiometricBusy(false);
    }
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(undefined);
    setSubmitting(true);
    try {
      await ensureAccountScoped();
      const result = await unlockLocalIdentity(password);
      if (!result) {
        // Either a wrong password, or this browser has no local identity to unlock
        // at all (storage cleared, a genuinely new browser) — either way there's
        // nothing more to try client-side; the link below is the honest next step,
        // not a dead end.
        setError('Incorrect password, or this device needs to sign in again.');
        return;
      }
      completeUnlock(result.kek, result.identity);
      await ensureHistoryKey(result.kek, password);
      setUnlocked(true);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex flex-1 items-center justify-center p-6">
      <Card className="w-full max-w-sm">
        <div className="mb-5 flex flex-col items-center gap-2 text-center">
          <Logo className="h-8 w-auto" />
          <h1 className="text-lg font-semibold text-foreground">Unlock this device</h1>
          <p className="text-sm text-muted-foreground">
            You&rsquo;re still signed in — enter your password to decrypt your local message history on this
            device.
          </p>
        </div>
        {biometricAvailable && (
          <div className="mb-5">
            <Button
              type="button"
              variant="secondary"
              className="w-full gap-2"
              onClick={() => void handleBiometricUnlock()}
              disabled={biometricBusy}
            >
              <IconFingerprint className="h-4 w-4" />
              {biometricBusy ? 'Waiting…' : 'Unlock with biometrics'}
            </Button>
            <div className="my-4 flex items-center gap-3 text-xs text-muted-foreground">
              <span className="h-px flex-1 bg-border" />
              or use your password
              <span className="h-px flex-1 bg-border" />
            </div>
          </div>
        )}
        <form onSubmit={handleSubmit} className="space-y-4" noValidate>
          <div>
            <Label htmlFor="unlock-password">Password</Label>
            <Input
              id="unlock-password"
              name="password"
              type="password"
              autoComplete="current-password"
              autoFocus={!biometricAvailable}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </div>
          <FieldError>{error}</FieldError>
          <Button type="submit" className="w-full" disabled={submitting || !password}>
            {submitting ? 'Unlocking…' : 'Unlock'}
          </Button>
        </form>
        <a href="/login" className="mt-4 block text-center text-xs text-muted-foreground hover:text-foreground">
          Not you, or password changed elsewhere? Sign in again
        </a>
      </Card>
    </div>
  );
}
