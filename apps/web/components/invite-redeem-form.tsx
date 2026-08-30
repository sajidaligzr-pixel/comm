'use client';

import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from './ui/button';
import { Input, Label, FieldError } from './ui/input';
import { apiFetch, ApiError } from '@/lib/api-client';
import { createLocalIdentity } from '@/lib/crypto/identity';
import { completeUnlock } from '@/lib/crypto/complete-unlock';
import { setActiveAccount } from '@/lib/crypto/active-account';
import { ensureHistoryKey } from '@/lib/crypto/history-key';

// Scoped by username — see login-form.tsx's identical helper and active-account.ts's
// docstring for why: a browser that already has a different account's identity
// stored (this same machine, a different tab) must never read or overwrite it while
// setting up this new account.
function deviceIdStorageKey(username: string): string {
  return `comm_device_id__${username.trim().toLowerCase()}`;
}

export function InviteRedeemForm({ token, username }: { token: string; username: string }): React.JSX.Element {
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
      // Must run before createLocalIdentity's IndexedDB writes below — see
      // active-account.ts.
      setActiveAccount(username);
      const { keyBundle, kek, identity } = await createLocalIdentity(password);
      const result = await apiFetch<{ userId: string; deviceId: string }>('/api/auth/invite/redeem', {
        body: {
          token,
          password,
          device: { name: 'This device', deviceType: 'web' as const, keyBundle },
        },
      });
      localStorage.setItem(deviceIdStorageKey(username), result.deviceId);
      completeUnlock(kek, identity);
      // This account's very first device — bootstraps its History Key too, same
      // as any other password-based login (see history-key.ts's own docstring).
      await ensureHistoryKey(kek, password);
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
