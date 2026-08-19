'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import type { GroupInvitePeekDto, GroupSummary } from '@comm/types';
import { apiFetch, ApiError } from '@/lib/api-client';
import { Avatar } from '../chat/avatar';

export function JoinGroupCard({ token, info }: { token: string; info: GroupInvitePeekDto }): React.JSX.Element {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  async function join() {
    setBusy(true);
    setError(undefined);
    try {
      const group = await apiFetch<GroupSummary>(`/api/groups/invite/${token}/join`, { method: 'POST' });
      router.push(`/chats/${group.conversationId}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not join this group.');
      setBusy(false);
    }
  }

  return (
    <div className="w-full max-w-sm rounded-2xl border border-border bg-background p-6 text-center shadow-sm">
      <div className="flex flex-col items-center gap-3">
        <Avatar name={info.groupName} size="lg" />
        <div>
          <h1 className="text-lg font-semibold text-foreground">{info.groupName}</h1>
          <p className="mt-0.5 text-sm text-muted-foreground">
            {info.memberCount} member{info.memberCount === 1 ? '' : 's'}
          </p>
        </div>
      </div>
      {error && <p className="mt-4 text-sm text-danger">{error}</p>}
      <button
        type="button"
        onClick={() => (info.alreadyMember ? router.push(`/chats/${info.conversationId}`) : void join())}
        disabled={busy}
        className="mt-6 w-full rounded-full bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground disabled:opacity-60"
      >
        {info.alreadyMember ? 'Open chat' : busy ? 'Joining…' : `Join ${info.groupName}`}
      </button>
    </div>
  );
}
