'use client';

import { Avatar } from '@/components/chat/avatar';
import { formatRecordingTime } from '@/lib/format';
import { IconPhone, IconPhoneOff, IconMic, IconMicOff, IconVolume, IconVolumeOff, IconX } from '@/components/icons';
import type { ActiveCall, CallPhase } from './call-provider';

interface CallOverlayProps {
  phase: CallPhase;
  call: ActiveCall;
  muted: boolean;
  /** Best-effort label, not a real hardware query — see call-provider.tsx's
   * `speakerOn` state comment. */
  speakerOn: boolean;
  /** Hides the button entirely on browsers with no way to act on it (e.g. Safari) —
   * see call-provider.tsx's SPEAKER_TOGGLE_SUPPORTED docstring. */
  speakerSupported: boolean;
  durationSec: number;
  statusText: string;
  micError: string | null;
  onAccept: () => void;
  onDecline: () => void;
  onHangUp: () => void;
  onToggleMute: () => void;
  onToggleSpeaker: () => void;
  onDismissMicError: () => void;
}

/**
 * Full-screen overlay for every non-idle call phase (docs/13-roadmap.md's Phase 6
 * slice: audio-only 1:1 calling). Deliberately not minimizable to a floating bubble
 * yet — a real, honest simplification, not a corner cut silently: this means you
 * can't browse other chats mid-call today, called out as a known follow-up rather
 * than pretended away.
 */
export function CallOverlay({
  phase,
  call,
  muted,
  speakerOn,
  speakerSupported,
  durationSec,
  statusText,
  micError,
  onAccept,
  onDecline,
  onHangUp,
  onToggleMute,
  onToggleSpeaker,
  onDismissMicError,
}: CallOverlayProps): React.JSX.Element {
  const ringing = phase === 'incoming' || phase === 'outgoing';

  return (
    <div className="fixed inset-0 z-50 flex flex-col items-center justify-between bg-background/98 px-6 py-12 backdrop-blur-sm">
      <div className="flex flex-1 flex-col items-center justify-center gap-4">
        <Avatar name={call.otherDisplayName} size="lg" className="h-28 w-28 text-3xl" />
        <p className="text-xl font-medium text-foreground">{call.otherDisplayName}</p>
        <p className="text-sm text-muted-foreground">
          {phase === 'connected' ? formatRecordingTime(durationSec) : statusText}
        </p>
        {ringing && (
          <span className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
            <IconPhone className="h-3.5 w-3.5" />
            Voice call
          </span>
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
        {phase === 'incoming' ? (
          <>
            <button
              type="button"
              onClick={onDecline}
              aria-label="Decline call"
              className="flex h-16 w-16 items-center justify-center rounded-full bg-danger text-white shadow-lg transition-transform hover:scale-105"
            >
              <IconPhoneOff className="h-6 w-6" />
            </button>
            <button
              type="button"
              onClick={onAccept}
              aria-label="Accept call"
              className="flex h-16 w-16 items-center justify-center rounded-full bg-emerald-500 text-white shadow-lg transition-transform hover:scale-105"
            >
              <IconPhone className="h-6 w-6" />
            </button>
          </>
        ) : (
          <>
            {phase === 'connected' && (
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
            )}
            {phase === 'connected' && speakerSupported && (
              <button
                type="button"
                onClick={onToggleSpeaker}
                aria-label={speakerOn ? 'Switch to earpiece' : 'Switch to speaker'}
                aria-pressed={speakerOn}
                className={`flex h-14 w-14 items-center justify-center rounded-full shadow transition-colors ${
                  speakerOn ? 'bg-foreground text-background' : 'bg-muted text-foreground hover:bg-border'
                }`}
              >
                {speakerOn ? <IconVolume className="h-5 w-5" /> : <IconVolumeOff className="h-5 w-5" />}
              </button>
            )}
            <button
              type="button"
              onClick={onHangUp}
              aria-label="End call"
              disabled={phase === 'ended'}
              className="flex h-16 w-16 items-center justify-center rounded-full bg-danger text-white shadow-lg transition-transform hover:scale-105 disabled:opacity-50"
            >
              <IconPhoneOff className="h-6 w-6" />
            </button>
          </>
        )}
      </div>
    </div>
  );
}
