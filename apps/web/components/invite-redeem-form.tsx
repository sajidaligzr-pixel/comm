'use client';

import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from './ui/button';
import { Input, Label, FieldError } from './ui/input';
import { apiFetch, ApiError } from '@/lib/api-client';
import { createLocalIdentity } from '@/lib/crypto/identity';
import { setUnlockedIdentity } from '@/lib/crypto/kek-holder';

const DEVICE_ID_STORAGE_KEY = 'comm_device_id';

export function InviteRedeemForm({ token }: { token: string }): React.JSX.Element {
  const router = useRouter();
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState<string | undefined>();
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(undefined);

    if (password !== confirmPassword) {
      setError('Passwords do not match.');
      return;
    }
    if (password.length < 12) {
      setError('Password must be at least 12 characters.');
      return;
    }

    setSubmitting(true);
    try {
      const { keyBundle, kek, identity } = await createLocalIdentity(password);
      const result = await apiFetch<{ userId: string; deviceId: string }>('/api/auth/invite/redeem', {
        body: {
          token,
          password,
          device: { name: 'This device', deviceType: 'web' as const, keyBundle },
        },
      });
      localStorage.setItem(DEVICE_ID_STORAGE_KEY, result.deviceId);
      setUnlockedIdentity(kek, identity);
      router.push('/chats');
      router.refresh();
    } catch (err) {
      // Same fix as message-thread.tsx's send path — `createLocalIdentity` above
      // does real client-side crypto work (Argon2id, key generation, IndexedDB
      // writes) before the network call even happens; a generic string for every
      // non-ApiError failure would hide exactly which of those actually failed.
      setError(err instanceof ApiError ? err.message : err instanceof Error ? err.message : 'Something went wrong. Please try again.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4" noValidate>
      <div>
        <Label htmlFor="password">Choose a password</Label>
        <Input
          id="password"
          type="password"
          autoComplete="new-password"
          minLength={12}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
        />
        <p className="mt-1.5 text-xs text-muted-foreground">
          At least 12 characters. Only you will ever know this password — not your admin.
        </p>
      </div>
      <div>
        <Label htmlFor="confirmPassword">Confirm password</Label>
        <Input
          id="confirmPassword"
          type="password"
          autoComplete="new-password"
          value={confirmPassword}
          onChange={(e) => setConfirmPassword(e.target.value)}
          required
        />
      </div>
      <FieldError>{error}</FieldError>
      <Button type="submit" className="w-full" disabled={submitting}>
        {submitting ? 'Setting up your account…' : 'Create account'}
      </Button>
    </form>
  );
}
