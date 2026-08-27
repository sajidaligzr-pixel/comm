'use client';

import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from './ui/button';
import { Input, Label, FieldError } from './ui/input';
import { apiFetch, ApiError } from '@/lib/api-client';
import { createLocalIdentity } from '@/lib/crypto/identity';
import { setUnlockedIdentity } from '@/lib/crypto/kek-holder';
import { setActiveAccount } from '@/lib/crypto/active-account';
import { ensureHistoryKey } from '@/lib/crypto/history-key';

// Scoped by username — see login-form.tsx's identical helper and active-account.ts's
// docstring for why.
function deviceIdStorageKey(username: string): string {
  return `comm_device_id__${username.trim().toLowerCase()}`;
}

export function LinkDeviceCompleteForm({ token, username }: { token: string; username: string }): React.JSX.Element {
  const router = useRouter();
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | undefined>();
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(undefined);
    setSubmitting(true);
    try {
      // This device has no session yet — the linking token authorizes the account
      // action, but local key storage still needs its own password-derived KEK
      // (docs/05-crypto-architecture.md#local-key-storage), so the account password
      // is asked for here too rather than skipped. Never sent anywhere: it's used
      // client-side only, to wrap this device's own freshly-generated keys.
      // Must run before createLocalIdentity's IndexedDB writes below — see
      // active-account.ts.
      setActiveAccount(username);
      const { keyBundle, kek, identity } = await createLocalIdentity(password);

      const result = await apiFetch<{ userId: string; deviceId: string }>('/api/devices/link/complete', {
        body: {
          linkingToken: token,
          device: { name: name || 'New device', deviceType: 'web' as const, keyBundle },
        },
      });
      localStorage.setItem(deviceIdStorageKey(username), result.deviceId);
      setUnlockedIdentity(kek, identity);
      // This device typed the real account password above (see this form's own
      // note on why, for local key wrapping) — same bootstrap every other
      // password-based path uses (history-key.ts's own docstring).
      await ensureHistoryKey(kek, password);
      router.push('/chats');
      router.refresh();
    } catch (err) {
      // Was unconditionally "This link is no longer valid." for any non-ApiError
      // failure — actively misleading when the real cause is `createLocalIdentity`
      // above failing (a genuine client-side crypto/storage problem, not an expired
      // token), telling the user to go get a new link instead of the real issue.
      // Same fix as message-thread.tsx's send path: show the real message when
      // there is one.
      setError(err instanceof ApiError ? err.message : err instanceof Error ? err.message : 'This link is no longer valid.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4" noValidate>
      <div>
        <Label htmlFor="name">What should we call this device?</Label>
        <Input id="name" placeholder="e.g. Work laptop" value={name} onChange={(e) => setName(e.target.value)} />
      </div>
      <div>
        <Label htmlFor="password">Your account password</Label>
        <Input
          id="password"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
        />
        <p className="mt-1.5 text-xs text-muted-foreground">
          Used only on this device, to protect its local message keys — never sent anywhere.
        </p>
      </div>
      <FieldError>{error}</FieldError>
      <Button type="submit" className="w-full" disabled={submitting}>
        {submitting ? 'Linking…' : 'Link this device'}
      </Button>
    </form>
  );
}
