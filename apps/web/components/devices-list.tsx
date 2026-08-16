'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import type { DeviceSummary } from '@comm/types';
import { Button } from './ui/button';
import { Card } from './ui/card';
import { apiFetch, ApiError } from '@/lib/api-client';

function formatRelative(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const minutes = Math.round(diffMs / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

export function DevicesList({ initialDevices }: { initialDevices: DeviceSummary[] }): React.JSX.Element {
  const router = useRouter();
  const [devices, setDevices] = useState(initialDevices);
  const [revokingId, setRevokingId] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();

  async function revoke(id: string) {
    setError(undefined);
    setRevokingId(id);
    try {
      await apiFetch(`/api/devices/${id}`, { method: 'DELETE' });
      setDevices((prev) => prev.filter((d) => d.id !== id));
      router.refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not revoke that device.');
    } finally {
      setRevokingId(undefined);
    }
  }

  if (devices.length === 0) {
    return <p className="text-sm text-muted-foreground">No linked devices.</p>;
  }

  return (
    <div className="space-y-2">
      {error && <p className="text-sm text-danger">{error}</p>}
      {devices.map((device) => (
        <Card key={device.id} className="flex items-center justify-between p-4">
          <div>
            <p className="text-sm font-medium text-foreground">
              {device.name}
              {device.isCurrentDevice && (
                <span className="ml-2 rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                  Current device
                </span>
              )}
            </p>
            <p className="text-xs text-muted-foreground">Last active: {formatRelative(device.lastActiveAt)}</p>
          </div>
          {!device.isCurrentDevice && (
            <Button variant="danger" onClick={() => revoke(device.id)} disabled={revokingId === device.id}>
              {revokingId === device.id ? 'Revoking…' : 'Revoke'}
            </Button>
          )}
        </Card>
      ))}
    </div>
  );
}
