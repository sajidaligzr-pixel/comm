'use client';

import { Avatar } from '@/components/chat/avatar';
import { formatRecordingTime } from '@/lib/format';
import { IconPhoneOff, IconMic, IconMicOff, IconX } from '@/components/icons';
import type { ActiveGroupCall, GroupCallParticipantTile, GroupCallPhase } from './group-call-provider';
import { useEffect, useState } from 'react';

interface GroupCallOverlayProps {
  phase: GroupCallPhase;
  call: ActiveGroupCall;
  participants: GroupCallParticipantTile[];
  muted: boolean;
  statusText: string;
  micError: string | null;
  onHangUp: () => void;
  onToggleMute: () => void;
  onDismissMicError: () => void;
}

function tileLabel(state: GroupCallParticipantTile['connectionState']): string {
  if (state === 'connected') return 'Connected';
  if (state === 'pending' || state === 'new' || state === 'connecting') return 'Connecting…';
  if (state === 'failed' || state === 'disconnected' || state === 'closed') return 'Disconnected';
  return '';
}

/**
 * Full-screen overlay for an active group call, parallel to `CallOverlay` (1:1)
 * but a tile grid instead of a single remote party — this device's own mesh of
 * up to `GROUP_CALL_MAX_PARTICIPANTS - 1` peer connections, one tile each,
 * rather than one `RTCPeerConnection`/one face. No per-participant mute/volume
 * controls (a real, disclosed simplification, not an oversight) — only this
 * device's own mic.
 */
export function GroupCallOverlay({
  phase,
  call,
  participants,
  muted,
  statusText,
  micError,
  onHangUp,
  onToggleMute,
  onDismissMicError,
}: GroupCallOverlayProps): React.JSX.Element {
  const [durationSec, setDurationSec] = useState(0);
  const anyConnected = participants.some((p) => p.connectionState === 'connected');

  useEffect(() => {
    if (!anyConnected) {
      setDurationSec(0);
      return;
    }
    const interval = setInterval(() => setDurationSec((s) => s + 1), 1000);
    return () => clearInterval(interval);
  }, [anyConnected]);

  return (
    <div className="fixed inset-0 z-50 flex flex-col items-center justify-between bg-background/98 px-6 py-12 backdrop-blur-sm">
      <div className="flex flex-1 flex-col items-center justify-center gap-6">
        <div>
          <p className="text-center text-xl font-medium text-foreground">{call.groupName}</p>
          <p className="text-center text-sm text-muted-foreground">{anyConnected ? formatRecordingTime(durationSec) : statusText}</p>
        </div>

        {participants.length === 0 ? (
          <p className="text-sm text-muted-foreground">Waiting for others to join…</p>
        ) : (
          <div className="grid w-full max-w-sm grid-cols-3 gap-4">
            {participants.map((p) => (
              <div key={`${p.userId}:${p.deviceId}`} className="flex flex-col items-center gap-1.5">
                <div className="relative">
                  <Avatar name={p.displayName} size="md" />
                  {p.connectionState !== 'connected' && (
                    <span className="absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full border-2 border-background bg-amber-400" />
                  )}
                </div>
                <p className="max-w-[5rem] truncate text-center text-xs text-foreground">{p.displayName}</p>
                <p className="text-[10px] text-muted-foreground">{tileLabel(p.connectionState)}</p>
              </div>
            ))}
          </div>
        )}
      </div>

      {micError && (
        <div className="mb-4 flex w-full max-w-sm items-start gap-2 rounded-xl border border-danger/30 bg-danger/10 px-4 py-3 text-sm text-danger">
          <span className="flex-1">{micError}</span>
          <button type="button" onClick={onDismissMicError} aria-label="Dismiss" className="mt-0.5">
            <IconX className="h-4 w-4" />
          </button>
        </div>
      )}

      <div className="flex items-center gap-6">
        <button
          type="button"
          onClick={onToggleMute}
          aria-label={muted ? 'Unmute' : 'Mute'}
          aria-pressed={muted}
          className={`flex h-14 w-14 items-center justify-center rounded-full shadow transition-colors ${
            muted ? 'bg-foreground text-background' : 'bg-muted text-foreground hover:bg-border'
          }`}
        >
          {muted ? <IconMicOff className="h-5 w-5" /> : <IconMic className="h-5 w-5" />}
        </button>
        <button
          type="button"
          onClick={onHangUp}
          aria-label="Leave call"
          disabled={phase === 'ended'}
          className="flex h-16 w-16 items-center justify-center rounded-full bg-danger text-white shadow-lg transition-transform hover:scale-105 disabled:opacity-50"
        >
          <IconPhoneOff className="h-6 w-6" />
        </button>
      </div>
    </div>
  );
}
