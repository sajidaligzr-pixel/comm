'use client';

import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from './ui/button';
import { Input, Label, FieldError } from './ui/input';
import { Card } from './ui/card';
import { apiFetch, ApiError } from '@/lib/api-client';

interface ProvisionResult {
  username: string;
  inviteUrl: string;
  expiresAt: string;
}

export function ProvisionUserForm(): React.JSX.Element {
  const router = useRouter();
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [error, setError] = useState<string | undefined>();
  const [result, setResult] = useState<ProvisionResult | undefined>();
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(undefined);
    setSubmitting(true);
    try {
      const res = await apiFetch<ProvisionResult>('/api/admin/users', { body: { username, displayName } });
      setResult(res);
      setUsername('');
      setDisplayName('');
      router.refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : err instanceof Error ? err.message : 'Could not create that user.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Card className="p-4">
      <h2 className="text-sm font-semibold text-foreground">Create a user</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        You set the username and name only — the invitee chooses their own password when they redeem the
        invite link, so it&apos;s never known to you or stored anywhere in plaintext.
      </p>
      <form onSubmit={handleSubmit} className="mt-3 space-y-3" noValidate>
        <div>
          <Label htmlFor="new-username">Username</Label>
          <Input
            id="new-username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="jane"
            required
          />
        </div>
        <div>
          <Label htmlFor="new-display-name">Display name</Label>
          <Input
            id="new-display-name"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder="Jane Doe"
            required
          />
        </div>
        <FieldError>{error}</FieldError>
        <Button type="submit" disabled={submitting}>
          {submitting ? 'Creating…' : 'Create invite'}
        </Button>
      </form>

      {result && (
        <div className="mt-4 rounded-lg bg-muted p-3">
          <p className="text-sm text-foreground">
            Invite for <span className="font-medium">@{result.username}</span> — share this link with them:
          </p>
          <code className="mt-1 block break-all text-xs text-foreground">{result.inviteUrl}</code>
          <p className="mt-1 text-xs text-muted-foreground">
            Expires {new Date(result.expiresAt).toLocaleString()}.
          </p>
        </div>
      )}
    </Card>
  );
}
