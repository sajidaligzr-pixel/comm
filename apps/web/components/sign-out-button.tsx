'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from './ui/button';
import { apiFetch } from '@/lib/api-client';
import { clearUnlockedIdentity } from '@/lib/crypto/kek-holder';
import { clearCurrentHistoryKey } from '@/lib/crypto/history-key-holder';

export function SignOutButton(): React.JSX.Element {
  const router = useRouter();
  const [loading, setLoading] = useState(false);

  async function handleClick() {
    setLoading(true);
    try {
      await apiFetch('/api/auth/logout', { method: 'POST' });
    } finally {
      // Clears the in-memory KEK only — the encrypted identity/session data stays in
      // IndexedDB so this device keeps its own key material (and every established
      // ratchet session) for next time, rather than a routine sign-out silently
      // orphaning every conversation. Device *revocation* (a different action —
      // components/devices-list.tsx) is what should ever wipe local storage
      // entirely, not this.
      clearUnlockedIdentity();
      clearCurrentHistoryKey();
      router.push('/login');
      router.refresh();
    }
  }

  return (
    <Button variant="ghost" onClick={handleClick} disabled={loading}>
      {loading ? 'Signing out…' : 'Sign out'}
    </Button>
  );
}
