'use client';

import { useCall } from '@/components/call/call-provider';
import { IconPhone } from '@/components/icons';

export function CallButton({
  conversationId,
  otherUserId,
  otherDisplayName,
}: {
  conversationId: string;
  otherUserId: string;
  otherDisplayName: string;
}): React.JSX.Element {
  const { startCall, busy } = useCall();

  return (
    <button
      type="button"
      onClick={() => startCall(conversationId, otherUserId, otherDisplayName)}
      disabled={busy}
      title={busy ? 'Already on a call' : `Call ${otherDisplayName}`}
      aria-label={`Voice call ${otherDisplayName}`}
      className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
    >
      <IconPhone className="h-5 w-5" />
    </button>
  );
}
