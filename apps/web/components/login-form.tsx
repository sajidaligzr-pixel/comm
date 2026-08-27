'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import type { LoginResponse, PendingLoginPollResponse } from '@comm/types';
import { Button } from './ui/button';
import { Input, Label, FieldError } from './ui/input';
import { apiFetch, ApiError } from '@/lib/api-client';
import { createLocalIdentity, unlockLocalIdentity, hasLocalIdentity } from '@/lib/crypto/identity';
import { setUnlockedIdentity } from '@/lib/crypto/kek-holder';
import { setActiveAccount } from '@/lib/crypto/active-account';

// New-device login approval (docs/07-auth-architecture.md's device-approval
// section) — a second (or later) device no longer completes on submit alone; the
// server holds it as `pending_approval` until an already-signed-in device approves
// it. Polled on a short, fixed interval (no exponential backoff — this only ever
// runs for the few minutes a request stays pending, and a person watching a
// waiting screen wants it to resolve promptly, not slowly) until it stops
// returning `pending`.
const POLL_INTERVAL_MS = 2000;

async function pollPendingLogin(pendingLoginId: string): Promise<PendingLoginPollResponse> {
  return apiFetch<PendingLoginPollResponse>(`/api/auth/login/pending/${pendingLoginId}`, { method: 'GET' });
}

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
  const [pendingLoginId, setPendingLoginId] = useState<string | undefined>();
  const cancelledRef = useRef(false);

  useEffect(() => {
    return () => {
      cancelledRef.current = true;
    };
  }, []);

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

  /** Shared by both the immediate-success path and the "waited for approval, it
   * came through" path below — unlocks (or adopts a just-created) local identity
   * and redirects, exactly what this used to do inline before pending_approval
   * existed. */
  async function finishLogin(
    result: { deviceId: string; mustChangePassword: boolean },
    returning: boolean,
    newIdentity: Awaited<ReturnType<typeof createLocalIdentity>> | undefined,
  ) {
    localStorage.setItem(deviceIdStorageKey(username), result.deviceId);
    localStorage.setItem(REMEMBERED_USERNAME_KEY, username);

    // Unlock (or, for a device just created above, reuse what createLocalIdentity
    // already derived) the local KEK and hold it in memory for this tab's
    // lifetime — see lib/crypto/kek-holder.ts. One Argon2id derivation per login,
    // never repeated within the same page load.
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
      setUnlockedIdentity(unlocked.kek, unlocked.identity);
    } else {
      setUnlockedIdentity(newIdentity!.kek, newIdentity!.identity);
    }

    // The real enforcement is (app)/layout.tsx's server-side redirect
    // (docs/07-auth-architecture.md) — this is just avoiding an extra round trip
    // through /devices first when we already know the answer.
    router.push(result.mustChangePassword ? '/change-password' : '/chats');
    router.refresh();
  }

  /** New-device login approval (docs/07-auth-architecture.md) — polls until an
   * already-signed-in device approves/denies this request, or it expires. Runs
   * entirely client-side (no server push possible — this browser has no session
   * yet to receive one on), same reasoning PendingDeviceLogin's own doc comment
   * gives for why the waiting side has to be a poll. */
  async function waitForApproval(
    pendingLoginId: string,
    returning: boolean,
    newIdentity: Awaited<ReturnType<typeof createLocalIdentity>> | undefined,
  ) {
    setPendingLoginId(pendingLoginId);
    try {
      for (;;) {
        if (cancelledRef.current) return;
        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
        if (cancelledRef.current) return;
        const poll = await pollPendingLogin(pendingLoginId);
        if (poll.status === 'pending') continue;
        if (poll.status === 'denied') {
          setError('That sign-in request was denied or expired. Please try again.');
          return;
        }
        await finishLogin(poll, returning, newIdentity);
        return;
      }
    } finally {
      if (!cancelledRef.current) setPendingLoginId(undefined);
    }
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(undefined);
    setSubmitting(true);
    cancelledRef.current = false; // reset in case a previous attempt was cancelled
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

      const response = await apiFetch<LoginResponse>('/api/auth/login', { body });

      if (response.status === 'pending_approval') {
        // New-device login approval (docs/07-auth-architecture.md) — this device
        // isn't signed in yet; wait for another of the account's devices to
        // approve it. `submitting` stays true for the whole wait (see the
        // pendingLoginId-gated render below) rather than flipping back to an
        // idle-looking form.
        await waitForApproval(response.pendingLoginId, returning, newIdentity);
        return;
      }

      await finishLogin(response, returning, newIdentity);
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

  if (pendingLoginId) {
    // New-device login approval (docs/07-auth-architecture.md) — this device sent
    // its credentials but can't finish signing in until an already-signed-in
    // device approves it. "Cancel" just stops polling; the request itself simply
    // expires server-side after PENDING_LOGIN_TTL_SECONDS if nobody responds.
    return (
      <div className="space-y-4 text-center">
        <p className="text-sm text-foreground">
          Check your other device — approve this sign-in from your <strong>Devices</strong> screen to continue.
        </p>
        <p className="text-xs text-muted-foreground">This request expires in a few minutes if nobody responds.</p>
        <Button
          type="button"
          variant="secondary"
          onClick={() => {
            cancelledRef.current = true;
            setPendingLoginId(undefined);
            setSubmitting(false);
          }}
        >
          Cancel
        </Button>
      </div>
    );
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
