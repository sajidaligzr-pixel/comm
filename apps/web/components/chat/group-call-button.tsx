'use client';

import { useGroupCall } from '@/components/call/group-call-provider';
import { IconPhone } from '@/components/icons';

export function GroupCallButton({ conversationId, groupName }: { conversationId: string; groupName: string }): React.JSX.Element {
  const { startGroupCall, busy } = useGroupCall();

  return (
    <button
      type="button"
      onClick={() => startGroupCall(conversationId, groupName)}
      disabled={busy}
      title={busy ? 'Already on a call' : `Start a group call in ${groupName}`}
      aria-label={`Start group call in ${groupName}`}
      className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
    >
      <IconPhone className="h-5 w-5" />
    </button>
  );
}
