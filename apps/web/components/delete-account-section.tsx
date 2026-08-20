'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from './ui/button';
import { Card } from './ui/card';
import { Input, Label, FieldError } from './ui/input';
import { Dialog } from './ui/dialog';
import { apiFetch, ApiError } from '@/lib/api-client';
import { clearUnlockedIdentity } from '@/lib/crypto/kek-holder';
import { wipeCryptoDb } from '@/lib/crypto/db';

/**
 * Self-service account deletion — Apple App Store Review Guideline 5.1.1(v) requires
 * this be reachable from inside the app, not just a support/website flow. Placed on
 * the Devices page's "danger zone" rather than a dedicated Settings page, matching
 * how Blocked users already lives here — the closest thing this app has to an
 * account-management hub today.
 *
 * Unlike sign-out-button.tsx, this DOES wipe the local IndexedDB crypto database
 * (`wipeCryptoDb`) — sign-out deliberately preserves it so the same device logging
 * back in stays a "returning device," but there's no "next time" once the account
 * itself is gone. `wipeCryptoDb` previously had no caller anywhere in the app (the
 * one place it was meant for, revoking your own current device, isn't offered in
 * devices-list.tsx's UI) — this is its first real use.
 */
export function DeleteAccountSection(): React.JSX.Element {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | undefined>();
  const [submitting, setSubmitting] = useState(false);

  function close() {
    if (submitting) return;
    setOpen(false);
    setPassword('');
    setError(undefined);
  }

  async function handleDelete() {
    setError(undefined);
    setSubmitting(true);
    try {
      await apiFetch('/api/auth/delete-account', { method: 'POST', body: { password } });
      clearUnlockedIdentity();
      await wipeCryptoDb();
      router.push('/login');
      router.refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not delete your account.');
      setSubmitting(false);
    }
  }

  return (
    <>
      <Card className="border-danger/40 p-4">
        <h2 className="text-sm font-semibold text-danger">Danger zone</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Permanently delete your account. This can&apos;t be undone.
        </p>
        <Button variant="danger" className="mt-3" onClick={() => setOpen(true)}>
          Delete my account
        </Button>
      </Card>

      <Dialog open={open} onClose={close} title="Delete your account?">
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">
            Every device signs out immediately and can&apos;t sign back in. Messages you&apos;ve already sent stay
            with the people you sent them to — the same way they would if you deleted WhatsApp or Signal — but
            your profile, devices, and sessions are gone for good.
          </p>
          <div>
            <Label htmlFor="delete-account-password">Confirm your password</Label>
            <Input
              id="delete-account-password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              disabled={submitting}
              autoFocus
            />
            <FieldError>{error}</FieldError>
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={close} disabled={submitting}>
              Cancel
            </Button>
            <Button variant="danger" onClick={handleDelete} disabled={submitting || password.length === 0}>
              {submitting ? 'Deleting…' : 'Delete my account'}
            </Button>
          </div>
        </div>
      </Dialog>
    </>
  );
}
