'use client';

import { useState } from 'react';
import { Button } from './ui/button';
import { Card } from './ui/card';
import { apiFetch, ApiError } from '@/lib/api-client';

interface LinkStartResult {
  linkingToken: string;
  expiresAt: string;
}

export function LinkDevicePanel(): React.JSX.Element {
  const [result, setResult] = useState<LinkStartResult | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);

  async function start() {
    setError(undefined);
    setLoading(true);
    try {
      const res = await apiFetch<LinkStartResult>('/api/devices/link/start', { method: 'POST' });
      setResult(res);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : err instanceof Error ? err.message : 'Could not start device linking.');
    } finally {
      setLoading(false);
    }
  }

  const link = result && typeof window !== 'undefined' ? `${window.location.origin}/link-device/${result.linkingToken}` : undefined;

  return (
    <Card className="p-4">
      <h2 className="text-sm font-semibold text-foreground">Link a new device</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        Generates a one-time link, valid for 5 minutes. Open it on the device you want to add — a QR-code
        scanning flow lands with the mobile client; for now, share this link the same way you&apos;d show a QR
        code (over a trusted channel, not publicly).
      </p>

      {!result ? (
        <Button className="mt-3" onClick={start} disabled={loading}>
          {loading ? 'Generating…' : 'Generate linking link'}
        </Button>
      ) : (
        <div className="mt-3 space-y-2">
          <code className="block break-all rounded-lg bg-muted p-3 text-xs text-foreground">{link}</code>
          <div className="flex gap-2">
            <Button
              variant="secondary"
              onClick={async () => {
                if (link) await navigator.clipboard.writeText(link);
                setCopied(true);
                setTimeout(() => setCopied(false), 2000);
              }}
            >
              {copied ? 'Copied' : 'Copy link'}
            </Button>
            <Button variant="ghost" onClick={() => setResult(undefined)}>
              Done
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">Expires at {new Date(result.expiresAt).toLocaleTimeString()}.</p>
        </div>
      )}

      {error && <p className="mt-2 text-sm text-danger">{error}</p>}
    </Card>
  );
}
