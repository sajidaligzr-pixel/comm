'use client';

import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import type { LocationViewerDto } from '@comm/types';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input, Label, FieldError } from '@/components/ui/input';
import { apiFetch, ApiError } from '@/lib/api-client';

/**
 * Admin-only grant/revoke management for the `LocationViewer` privilege
 * (docs/09-trust-boundaries.md's "Live location sharing" exception) — mirrors
 * `ProvisionUserForm`'s grant-by-username form shape and `DevicesList`'s
 * revoke-list shape exactly, since this is the same "small admin management list"
 * pattern applied to a new privilege.
 */
export function LocationViewersList({ initialViewers }: { initialViewers: LocationViewerDto[] }): React.JSX.Element {
  const router = useRouter();
  const [viewers, setViewers] = useState(initialViewers);
  const [username, setUsername] = useState('');
  const [granting, setGranting] = useState(false);
  const [grantError, setGrantError] = useState<string | undefined>();
  const [revokingId, setRevokingId] = useState<string | undefined>();
  const [revokeError, setRevokeError] = useState<string | undefined>();

  async function handleGrant(e: FormEvent) {
    e.preventDefault();
    setGrantError(undefined);
    setGranting(true);
    try {
      const viewer = await apiFetch<LocationViewerDto>('/api/locations/viewers', { body: { username } });
      setViewers((prev) => [viewer, ...prev.filter((v) => v.userId !== viewer.userId)]);
      setUsername('');
      router.refresh();
    } catch (err) {
      setGrantError(err instanceof ApiError ? err.message : 'Could not grant location access.');
    } finally {
      setGranting(false);
    }
  }

  async function revoke(userId: string) {
    setRevokeError(undefined);
    setRevokingId(userId);
    try {
      await apiFetch(`/api/locations/viewers/${userId}`, { method: 'DELETE' });
      setViewers((prev) => prev.filter((v) => v.userId !== userId));
      router.refresh();
    } catch (err) {
      setRevokeError(err instanceof ApiError ? err.message : 'Could not revoke that access.');
    } finally {
      setRevokingId(undefined);
    }
  }

  return (
    <div className="space-y-4">
      <Card className="p-4">
        <h2 className="text-sm font-semibold text-foreground">Grant location access</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Every admin can already see everyone&apos;s live location. Granting this to an ordinary user lets them
          see it too, without giving them any other admin power.
        </p>
        <form onSubmit={handleGrant} className="mt-3 flex items-end gap-2" noValidate>
          <div className="flex-1">
            <Label htmlFor="grant-username">Username</Label>
            <Input
              id="grant-username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="jane"
              required
            />
          </div>
          <Button type="submit" disabled={granting}>
            {granting ? 'Granting…' : 'Grant'}
          </Button>
        </form>
        <FieldError>{grantError}</FieldError>
      </Card>

      <div>
        <h2 className="text-sm font-semibold text-foreground">Granted viewers</h2>
        {revokeError && <p className="mt-1 text-sm text-danger">{revokeError}</p>}
        {viewers.length === 0 ? (
          <p className="mt-2 text-sm text-muted-foreground">No one has been granted location access yet.</p>
        ) : (
          <div className="mt-2 space-y-2">
            {viewers.map((viewer) => (
              <Card key={viewer.userId} className="flex items-center justify-between p-3">
                <div>
                  <p className="text-sm font-medium text-foreground">
                    {viewer.displayName} <span className="text-muted-foreground">@{viewer.username}</span>
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Granted {new Date(viewer.grantedAt).toLocaleDateString()}
                  </p>
                </div>
                <Button variant="danger" onClick={() => revoke(viewer.userId)} disabled={revokingId === viewer.userId}>
                  {revokingId === viewer.userId ? 'Revoking…' : 'Revoke'}
                </Button>
              </Card>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
