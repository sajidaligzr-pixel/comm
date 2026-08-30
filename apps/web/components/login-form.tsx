'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import type { LoginResponse } from '@comm/types';
import { Button } from './ui/button';
import { Input, Label, FieldError } from './ui/input';
import { apiFetch, ApiError } from '@/lib/api-client';
import { createLocalIdentity, unlockLocalIdentity, hasLocalIdentity } from '@/lib/crypto/identity';
import { completeUnlock } from '@/lib/crypto/complete-unlock';
import { setActiveAccount } from '@/lib/crypto/active-account';
import { ensureHistoryKey } from '@/lib/crypto/history-key';

// Scoped by username, not a single fixed key — a browser signed into more than one
// account (two tabs, two people testing on one machine) must not have the SECOND
// account's login read/overwrite the FIRST account's remembered device id. See
// active-account.ts's docstring for the real bug this (together with that module)
// closes: this alone stops the wrong device id from ever being sent; active-account.ts
// is what stops the wrong IndexedDB identity from being read/overwritten.
function deviceIdStorageKey(username: string): string {
  return `comm_device_id__${username.trim().toLowerCase()}`;
}
// A username is an identifier, not a secret (it's already public — anyone can see it
// on a profile/@mention), so remembering it locally carries none of the risk storing
// a password or key material would; see docs/32-local-data-storage.md's actual rule,
// which is specifically about secrets. Asked for directly ("the user does not need
// to enter his username every time, only the password") — most returning-device
// logins now only need the password retyped. This is a smaller piece of the same gap
// unlock-gate.tsx closes for the *already-has-a-session* case; this half covers
// whenever the full login form genuinely is the right screen (session actually
// expired, explicit sign-out, `unlock-gate.tsx`'s own "sign in again" escape hatch).
const REMEMBERED_USERNAME_KEY = 'comm_username';

export function LoginForm(): React.JSX.Element {
  const router = useRouter();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | undefined>();
  const [submitting, setSubmitting] = useState(false);

  // Reads localStorage in an effect, not a lazy useState initializer — this
  // component is server-rendered for its initial HTML like any Client Component, and
  // the server has no access to the browser's localStorage (would always be empty
  // there); matching that on the client's first render and only filling in the
  // remembered value post-mount avoids a hydration mismatch on the input's value,
  // the same class of bug unlock-gate.tsx's own docstring documents avoiding.
  useEffect(() => {
    const remembered = localStorage.getItem(REMEMBERED_USERNAME_KEY);
    if (remembered) setUsername(remembered);
  }, []);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(undefined);
    setSubmitting(true);
    try {
      // Must run before ANY local identity/device-id storage is touched below — see
      // active-account.ts.
      setActiveAccount(username);
      const knownDeviceId = localStorage.getItem(deviceIdStorageKey(username)) ?? undefined;
      // Local identity persists in IndexedDB independently of the localStorage
      // device-id hint — if the browser still has both, this is a normal return
      // login; if IndexedDB was cleared (private browsing, storage eviction) but the
      // device-id hint survived, we fall back to registering fresh, same as a
      // brand-new device (the server-side deviceId the hint pointed at becomes
      // orphaned but harmless — it just never gets used again).
      const returning = knownDeviceId ? await hasLocalIdentity() : false;

      let newIdentity: Awaited<ReturnType<typeof createLocalIdentity>> | undefined;
      if (!returning) {
        newIdentity = await createLocalIdentity(password);
      }

      const body = returning
        ? { username, password, deviceId: knownDeviceId }
        : {
            username,
            password,
            newDevice: { name: guessDeviceName(), deviceType: 'web' as const, keyBundle: newIdentity!.keyBundle },
          };

      const result = await apiFetch<LoginResponse>('/api/auth/login', { body });

      localStorage.setItem(deviceIdStorageKey(username), result.deviceId);
      localStorage.setItem(REMEMBERED_USERNAME_KEY, username);

      // Unlock (or, for a device just created above, reuse what createLocalIdentity
      // already derived) the local KEK and hold it in memory for this tab's
      // lifetime — see lib/crypto/kek-holder.ts. One Argon2id derivation per login,
      // never repeated within the same page load.
      let kek: Uint8Array;
      if (returning) {
        const unlocked = await unlockLocalIdentity(password);
        if (!unlocked) {
          // Password mismatch between the account and the locally-stored identity
          // wrapper is only possible if the account password was changed elsewhere
          // (docs/07-auth-architecture.md's change-password flow) without this
          // device's local identity being re-wrapped to match. Surfaced as an
          // error rather than silently regenerating a new identity, which would
          // orphan every session built on the old one — a proper "re-wrap local
          // identity after password change" flow is a tracked follow-up, not
          // implemented in this pass.
          throw new ApiError('AUTH_INVALID', 'Could not unlock this device’s local keys with that password.');
        }
        completeUnlock(unlocked.kek, unlocked.identity);
        kek = unlocked.kek;
      } else {
        completeUnlock(newIdentity!.kek, newIdentity!.identity);
        kek = newIdentity!.kek;
      }

      // Multi-device message history sync (docs/07-auth-architecture.md) — this is
      // the one moment this tab genuinely has the plaintext password in memory (not
      // true of a future biometric unlock), so it's the only place a brand-new
      // account-level History Key can ever be bootstrapped. Best-effort: never
      // blocks sign-in on a failure (see ensureHistoryKey's own docstring).
      await ensureHistoryKey(kek, password);

      // The real enforcement is (app)/layout.tsx's server-side redirect
      // (docs/07-auth-architecture.md) — this is just avoiding an extra round trip
      // through /devices first when we already know the answer.
      router.push(result.mustChangePassword ? '/change-password' : '/chats');
      router.refresh();
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.code === 'DEVICE_REVOKED') {
          // The remembered device id is no longer valid (revoked elsewhere) — drop
          // it and let the next attempt register a fresh device instead of looping.
          localStorage.removeItem(deviceIdStorageKey(username));
        }
        setError(err.message);
      } else if (err instanceof Error) {
        // Same fix as message-thread.tsx's send path — `createLocalIdentity`/
        // `unlockLocalIdentity` above do real client-side crypto work before the
        // network call; a fully generic string here would hide exactly which step
        // actually failed.
        setError(err.message);
      } else {
        setError('Something went wrong. Please try again.');
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4" noValidate>
      <div>
        <Label htmlFor="username">Username</Label>
        <Input
          id="username"
          name="username"
          autoComplete="username"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          required
        />
      </div>
      <div>
        <Label htmlFor="password">Password</Label>
        <Input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
        />
      </div>
      <FieldError>{error}</FieldError>
      <Button type="submit" className="w-full" disabled={submitting}>
        {submitting ? 'Signing in…' : 'Sign in'}
      </Button>
    </form>
  );
}

function guessDeviceName(): string {
  if (typeof navigator === 'undefined') return 'Web';
  const ua = navigator.userAgent;
  if (/Android/i.test(ua)) return 'Android browser';
  if (/iPhone|iPad/i.test(ua)) return 'iOS browser';
  if (/Chrome/i.test(ua)) return 'Chrome';
  if (/Firefox/i.test(ua)) return 'Firefox';
  if (/Safari/i.test(ua)) return 'Safari';
  return 'Web';
}
