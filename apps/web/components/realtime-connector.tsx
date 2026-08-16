'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { connectRealtime, disconnectRealtime, onRealtimeEvent } from '@/lib/realtime-client';

/**
 * Establishes the realtime connection for the whole authenticated app shell, not
 * just while a chat thread happens to be open — this is what makes
 * docs/06-device-architecture.md's "revocation force-closes the live connection"
 * claim actually true from more than one page, and lets deviceEvent-driven UI
 * (a future "you were signed out on this device" toast) hook in centrally later.
 * Renders nothing; lives once in `(app)/layout.tsx`.
 */
export function RealtimeConnector(): null {
  const router = useRouter();

  useEffect(() => {
    connectRealtime();
    const off = onRealtimeEvent('connection.close', (payload) => {
      if (payload.code === 4001) {
        // This device was revoked elsewhere — the server already force-closed the
        // socket (server/realtime/ws-server.ts); bounce to login rather than
        // leaving a dead session sitting in the UI.
        router.push('/login');
        router.refresh();
      }
    });
    return () => {
      off();
      disconnectRealtime();
    };
  }, [router]);

  return null;
}
