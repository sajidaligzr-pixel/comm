'use client';

import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from './ui/button';
import { Input, Label, FieldError } from './ui/input';
import { apiFetch, ApiError } from '@/lib/api-client';
import { disableBiometricUnlock } from '@/lib/crypto/biometric-unlock';

export function ChangePasswordForm({ forced }: { forced: boolean }): React.JSX.Element {
  const router = useRouter();
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState<string | undefined>();
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(undefined);

    if (newPassword !== confirmPassword) {
      setError('New passwords do not match.');
      return;
    }
    if (newPassword.length < 12) {
      setError('New password must be at least 12 characters.');
      return;
    }
    if (newPassword === currentPassword) {
      setError('New password must be different from your current password.');
      return;
    }

    setSubmitting(true);
    try {
      await apiFetch('/api/auth/change-password', { body: { currentPassword, newPassword } });
      // A biometric enrollment (lib/crypto/biometric-unlock.ts) wraps the KEK
      // derived from the *old* password — the same "local identity/session data
      // doesn't get re-wrapped after a password change" gap login-form.tsx's own
      // docstring already flags, applied to this new local blob too. Rather than
      // leave a biometric unlock button that's silently guaranteed to fail from
      // this point on, it's cleared here — re-enabling it (Devices page) after
      // logging back in with the new password takes a few seconds.
      await disableBiometricUnlock();
      router.push('/chats');
      router.refresh();
    } catch (err) {
      // Same fix as message-thread.tsx's send path: a generic string for every
      // non-ApiError failure hid the real cause (there, a local encryption error
      // that turned out to be genuinely diagnosable — see that file's history).
      // `err.message` for a plain Error is still user-readable, just specific.
      setError(err instanceof ApiError ? err.message : err instanceof Error ? err.message : 'Something went wrong. Please try again.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4" noValidate>
      <div>
        <Label htmlFor="currentPassword">Current password</Label>
        <Input
          id="currentPassword"
          type="password"
          autoComplete="current-password"
          value={currentPassword}
          onChange={(e) => setCurrentPassword(e.target.value)}
          required
        />
      </div>
      <div>
        <Label htmlFor="newPassword">New password</Label>
        <Input
          id="newPassword"
          type="password"
          autoComplete="new-password"
          minLength={12}
          value={newPassword}
          onChange={(e) => setNewPassword(e.target.value)}
          required
        />
        <p className="mt-1.5 text-xs text-muted-foreground">At least 12 characters.</p>
      </div>
      <div>
        <Label htmlFor="confirmPassword">Confirm new password</Label>
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
        {submitting ? 'Updating…' : 'Update password'}
      </Button>
      {!forced && (
        <Button type="button" variant="ghost" className="w-full" onClick={() => router.back()}>
          Cancel
        </Button>
      )}
    </form>
  );
}
