'use client';

import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from './ui/button';
import { Input, Label, FieldError } from './ui/input';
import { apiFetch, ApiError } from '@/lib/api-client';
import { createLocalIdentity } from '@/lib/crypto/identity';
import { setUnlockedIdentity } from '@/lib/crypto/kek-holder';

const DEVICE_ID_STORAGE_KEY = 'comm_device_id';

export function LinkDeviceCompleteForm({ token }: { token: string }): React.JSX.Element {
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
      const { keyBundle, kek, identity } = await createLocalIdentity(password);

      const result = await apiFetch<{ userId: string; deviceId: string }>('/api/devices/link/complete', {
        body: {
          linkingToken: token,
          device: { name: name || 'New device', deviceType: 'web' as const, keyBundle },
        },
      });
      localStorage.setItem(DEVICE_ID_STORAGE_KEY, result.deviceId);
      setUnlockedIdentity(kek, identity);
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
