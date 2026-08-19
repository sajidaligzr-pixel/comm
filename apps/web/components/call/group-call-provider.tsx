'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { onRealtimeEvent, sendRealtimeEvent } from '@/lib/realtime-client';
import { apiFetch } from '@/lib/api-client';
import type { IceServersResponse, IceServer, CallSessionDescription, CallIceCandidateInit } from '@comm/types';
import { getActiveCallKind, setActiveCallKind } from '@/lib/call-coordination';
import { GroupCallOverlay } from './group-call-overlay';

/**
 * Group (mesh) audio calling (docs/13-roadmap.md) — a SEPARATE provider from
 * `CallProvider` (1:1), not an extension of it. Every participant opens a direct
 * `RTCPeerConnection` to every OTHER participant (N-1 connections each, capped
 * at `GROUP_CALL_MAX_PARTICIPANTS`) instead of 1:1's single peer connection —
 * see `packages/types/src/calls.ts`'s own module docstring for the full
 * mesh-vs-SFU reasoning. Kept as its own file/context/overlay entirely so the
 * already-shipped, delicate 1:1 calling code (`call-provider.tsx`) needed zero
 * changes beyond the small cross-provider busy-coordination hook in
 * `lib/call-coordination.ts`.
 *
 * Mounted once in `(app)/layout.tsx`, same as `CallProvider` — an invite has to
 * be able to arrive no matter which page is open.
 */

export type GroupCallPhase = 'idle' | 'active' | 'ended';

export interface ActiveGroupCall {
  callId: string;
  conversationId: string;
  groupName: string;
}

export interface GroupCallInvite {
  callId: string;
  conversationId: string;
  fromUserId: string;
  fromDisplayName: string;
  groupName: string;
}

export interface GroupCallParticipantTile {
  userId: string;
  deviceId: string;
  displayName: string;
  /** 'pending' = known (from the roster snapshot or a participant-joined event)
   * but no peer connection has reached a real RTCPeerConnectionState yet. */
  connectionState: RTCPeerConnectionState | 'pending';
}

interface GroupCallContextValue {
  startGroupCall: (conversationId: string, groupName: string) => void;
  invite: GroupCallInvite | null;
  acceptInvite: () => void;
  declineInvite: () => void;
  busy: boolean;
}

const GroupCallContext = createContext<GroupCallContextValue | null>(null);

export function useGroupCall(): GroupCallContextValue {
  const ctx = useContext(GroupCallContext);
  if (!ctx) throw new Error('useGroupCall must be used within GroupCallProvider');
  return ctx;
}

/** Same explicit constraints 1:1 calling asks for — see call-provider.tsx's own
 * AUDIO_CONSTRAINTS comment for why this isn't left as a bare `audio: true`. */
const AUDIO_CONSTRAINTS: MediaTrackConstraints = {
  echoCancellation: { ideal: true },
  noiseSuppression: { ideal: true },
  autoGainControl: { ideal: true },
  channelCount: { ideal: 1 },
  sampleRate: { ideal: 48000 },
};

function deviceKey(userId: string, deviceId: string): string {
  return `${userId}:${deviceId}`;
}

export function GroupCallProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  const [phase, setPhase] = useState<GroupCallPhase>('idle');
  const [call, setCall] = useState<ActiveGroupCall | null>(null);
  const [invite, setInvite] = useState<GroupCallInvite | null>(null);
  const [participants, setParticipants] = useState<GroupCallParticipantTile[]>([]);
  const [muted, setMuted] = useState(false);
  const [statusText, setStatusText] = useState('');
  const [micError, setMicError] = useState<string | null>(null);

  const phaseRef = useRef<GroupCallPhase>('idle');
  const callRef = useRef<ActiveGroupCall | null>(null);
  const inviteRef = useRef<GroupCallInvite | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const pcMapRef = useRef<Map<string, RTCPeerConnection>>(new Map());
  const pendingCandidatesRef = useRef<Map<string, CallIceCandidateInit[]>>(new Map());
  const remoteDescSetRef = useRef<Map<string, boolean>>(new Map());
  // Not rendered into JSX — a fresh peer can join at any moment mid-call, and
  // waiting on a React re-render to mount a per-tile <audio> element before
  // `ontrack` has anywhere to attach is a real race; `new Audio()` played
  // un-attached to the DOM works the same way call-provider.tsx's single hidden
  // <audio> sink does, just one instance per remote peer instead of one total.
  const audioElsRef = useRef<Map<string, HTMLAudioElement>>(new Map());

  const closePeer = useCallback((key: string) => {
    pcMapRef.current.get(key)?.close();
    pcMapRef.current.delete(key);
    pendingCandidatesRef.current.delete(key);
    remoteDescSetRef.current.delete(key);
    const audio = audioElsRef.current.get(key);
    if (audio) {
      audio.pause();
      audio.srcObject = null;
      audioElsRef.current.delete(key);
    }
  }, []);

  const teardownAll = useCallback(
    (finalStatus: string) => {
      setActiveCallKind(null);
      for (const key of Array.from(pcMapRef.current.keys())) closePeer(key);
      localStreamRef.current?.getTracks().forEach((t) => t.stop());
      localStreamRef.current = null;

      phaseRef.current = 'ended';
      setStatusText(finalStatus);
      setPhase('ended');
      setParticipants([]);
      setMuted(false);

      setTimeout(() => {
        if (phaseRef.current === 'ended') {
          phaseRef.current = 'idle';
          setPhase('idle');
        }
        callRef.current = null;
        setCall(null);
      }, 2000);
    },
    [closePeer],
  );

  const fetchIceServers = useCallback(async (): Promise<IceServer[]> => {
    try {
      const res = await apiFetch<IceServersResponse>('/api/calls/turn-credentials', { method: 'POST' });
      return res.iceServers;
    } catch {
      return [];
    }
  }, []);

  /** One direction of one pairwise connection — used both by the offering side
   * (existing participants reacting to `group-call.participant-joined`) and the
   * answering side (a joiner reacting to `group-call.offer`); which one actually
   * calls `createOffer` is decided entirely by the caller, this just wires up
   * the shared plumbing (ICE relay, remote track playback, tile status). */
  const getOrCreatePeerConnection = useCallback(
    (
      targetUserId: string,
      targetDeviceId: string,
      iceServers: IceServer[],
      conversationId: string,
      callId: string,
    ): RTCPeerConnection => {
      const key = deviceKey(targetUserId, targetDeviceId);
      const existing = pcMapRef.current.get(key);
      if (existing) return existing;

      const pc = new RTCPeerConnection({ iceServers });
      pcMapRef.current.set(key, pc);

      pc.onicecandidate = (e) => {
        if (e.candidate) {
          sendRealtimeEvent({
            type: 'group-call.ice-candidate',
            conversationId,
            callId,
            targetUserId,
            targetDeviceId,
            candidate: e.candidate.toJSON(),
          });
        }
      };

      pc.ontrack = (e) => {
        let audio = audioElsRef.current.get(key);
        if (!audio) {
          audio = new Audio();
          audio.autoplay = true;
          audioElsRef.current.set(key, audio);
        }
        audio.srcObject = e.streams[0] ?? null;
        void audio.play().catch(() => {});
      };

      pc.onconnectionstatechange = () => {
        setParticipants((prev) =>
          prev.map((p) => (p.userId === targetUserId && p.deviceId === targetDeviceId ? { ...p, connectionState: pc.connectionState } : p)),
        );
      };

      const localStream = localStreamRef.current;
      if (localStream) {
        localStream.getTracks().forEach((t) => pc.addTrack(t, localStream));
      }

      return pc;
    },
    [],
  );

  /**
   * `displayName` is optional and, when omitted, never clobbers an already-known
   * name — `group-call.offer`/`group-call.answer`/`group-call.ice-candidate`
   * carry no displayName field at all (only `fromUserId`/`fromDeviceId`), so a
   * peer's tile is normally created first from `group-call.roster` or
   * `group-call.participant-joined` (both of which DO carry it) and only ever
   * has its connection state touched after that.
   */
  const upsertTile = useCallback((userId: string, deviceId: string, connectionState: RTCPeerConnectionState | 'pending', displayName?: string) => {
    setParticipants((prev) => {
      const idx = prev.findIndex((p) => p.userId === userId && p.deviceId === deviceId);
      if (idx === -1) {
        return [...prev, { userId, deviceId, displayName: displayName ?? 'Participant', connectionState }];
      }
      const copy = prev.slice();
      copy[idx] = { ...copy[idx]!, connectionState, displayName: displayName ?? copy[idx]!.displayName };
      return copy;
    });
  }, []);

  const removeTile = useCallback((userId: string, deviceId: string) => {
    setParticipants((prev) => prev.filter((p) => !(p.userId === userId && p.deviceId === deviceId)));
  }, []);

  const enterCall = useCallback(async (next: ActiveGroupCall, statusWhileWaiting: string): Promise<boolean> => {
    setMicError(null);
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: AUDIO_CONSTRAINTS, video: false });
    } catch {
      setMicError('Microphone access is needed to join a call.');
      return false;
    }
    localStreamRef.current = stream;
    setActiveCallKind('group');
    callRef.current = next;
    phaseRef.current = 'active';
    setCall(next);
    setPhase('active');
    setParticipants([]);
    setStatusText(statusWhileWaiting);
    return true;
  }, []);

  const startGroupCall = useCallback(
    (conversationId: string, groupName: string) => {
      if (phaseRef.current !== 'idle' || getActiveCallKind()) return;
      void (async () => {
        const callId = crypto.randomUUID();
        const ok = await enterCall({ callId, conversationId, groupName }, 'Waiting for others to join…');
        if (!ok) return;
        sendRealtimeEvent({ type: 'group-call.start', conversationId, callId });
      })();
    },
    [enterCall],
  );

  const acceptInvite = useCallback(() => {
    const inv = inviteRef.current;
    if (!inv || phaseRef.current !== 'idle' || getActiveCallKind()) return;
    void (async () => {
      const ok = await enterCall({ callId: inv.callId, conversationId: inv.conversationId, groupName: inv.groupName }, 'Connecting…');
      inviteRef.current = null;
      setInvite(null);
      if (!ok) return;
      sendRealtimeEvent({ type: 'group-call.join', conversationId: inv.conversationId, callId: inv.callId });
    })();
  }, [enterCall]);

  const declineInvite = useCallback(() => {
    // No signal sent back — a group call has no per-invitee "ringing" state the
    // way 1:1 does (see call-coordination.ts's docstring on this asymmetry);
    // declining is simply not joining, which the room's other participants have
    // no need to be told about individually.
    inviteRef.current = null;
    setInvite(null);
  }, []);

  const hangUp = useCallback(() => {
    const active = callRef.current;
    if (active) {
      sendRealtimeEvent({ type: 'group-call.leave', conversationId: active.conversationId, callId: active.callId });
    }
    teardownAll('Call ended');
  }, [teardownAll]);

  const toggleMute = useCallback(() => {
    setMuted((m) => {
      const next = !m;
      localStreamRef.current?.getAudioTracks().forEach((t) => {
        t.enabled = !next;
      });
      return next;
    });
  }, []);

  useEffect(() => {
    const offInvited = onRealtimeEvent('group-call.invited', (payload) => {
      const p = payload as unknown as GroupCallInvite;
      if (phaseRef.current !== 'idle' || getActiveCallKind()) return; // already on a call — no per-invitee reject to send, see declineInvite's comment
      inviteRef.current = p;
      setInvite(p);
    });

    const offRoster = onRealtimeEvent('group-call.roster', (payload) => {
      const p = payload as unknown as { callId: string; participants: { userId: string; deviceId: string; displayName: string }[] };
      if (callRef.current?.callId !== p.callId) return;
      // Informational only — renders a tile per already-there participant right
      // away. This device does NOT open connections from this event; existing
      // participants initiate offers TO the joiner (see group-call.offer below),
      // never the other way, avoiding SDP glare. See GroupCallEvent's own
      // docstring (packages/types/src/realtime.ts) for the full convention.
      for (const participant of p.participants) {
        upsertTile(participant.userId, participant.deviceId, 'pending', participant.displayName);
      }
    });

    const offJoined = onRealtimeEvent('group-call.participant-joined', (payload) => {
      const p = payload as unknown as { callId: string; conversationId: string; participant: { userId: string; deviceId: string; displayName: string } };
      const active = callRef.current;
      if (!active || active.callId !== p.callId) return;
      upsertTile(p.participant.userId, p.participant.deviceId, 'pending', p.participant.displayName);

      void (async () => {
        const iceServers = await fetchIceServers();
        const pc = getOrCreatePeerConnection(p.participant.userId, p.participant.deviceId, iceServers, active.conversationId, active.callId);
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        sendRealtimeEvent({
          type: 'group-call.offer',
          conversationId: active.conversationId,
          callId: active.callId,
          targetUserId: p.participant.userId,
          targetDeviceId: p.participant.deviceId,
          sdp: { type: 'offer', sdp: offer.sdp ?? '' },
        });
      })();
    });

    const offOffer = onRealtimeEvent('group-call.offer', (payload) => {
      const p = payload as unknown as { callId: string; conversationId: string; fromUserId: string; fromDeviceId: string; sdp: CallSessionDescription };
      const active = callRef.current;
      if (!active || active.callId !== p.callId) return;
      // No displayName arg — this tile should already exist (from roster/joined,
      // both above), and if it somehow doesn't, upsertTile's own fallback ('Participant')
      // beats showing a raw UUID.
      upsertTile(p.fromUserId, p.fromDeviceId, 'pending');

      void (async () => {
        const iceServers = await fetchIceServers();
        const key = deviceKey(p.fromUserId, p.fromDeviceId);
        const pc = getOrCreatePeerConnection(p.fromUserId, p.fromDeviceId, iceServers, active.conversationId, active.callId);
        await pc.setRemoteDescription(p.sdp);
        remoteDescSetRef.current.set(key, true);
        const buffered = pendingCandidatesRef.current.get(key) ?? [];
        for (const c of buffered) {
          try {
            await pc.addIceCandidate(c);
          } catch {
            // One stale/malformed buffered candidate isn't fatal — same reasoning
            // as call-provider.tsx's identical buffered-candidate catches.
          }
        }
        pendingCandidatesRef.current.delete(key);

        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        sendRealtimeEvent({
          type: 'group-call.answer',
          conversationId: active.conversationId,
          callId: active.callId,
          targetUserId: p.fromUserId,
          targetDeviceId: p.fromDeviceId,
          sdp: { type: 'answer', sdp: answer.sdp ?? '' },
        });
      })();
    });

    const offAnswer = onRealtimeEvent('group-call.answer', (payload) => {
      const p = payload as unknown as { callId: string; fromUserId: string; fromDeviceId: string; sdp: CallSessionDescription };
      const active = callRef.current;
      if (!active || active.callId !== p.callId) return;
      const key = deviceKey(p.fromUserId, p.fromDeviceId);
      const pc = pcMapRef.current.get(key);
      if (!pc) return;
      void (async () => {
        await pc.setRemoteDescription(p.sdp);
        remoteDescSetRef.current.set(key, true);
        const buffered = pendingCandidatesRef.current.get(key) ?? [];
        for (const c of buffered) {
          try {
            await pc.addIceCandidate(c);
          } catch {
            // Same "one stale candidate isn't fatal" reasoning as above.
          }
        }
        pendingCandidatesRef.current.delete(key);
      })();
    });

    const offIce = onRealtimeEvent('group-call.ice-candidate', (payload) => {
      const p = payload as unknown as { callId: string; fromUserId: string; fromDeviceId: string; candidate: CallIceCandidateInit };
      const active = callRef.current;
      if (!active || active.callId !== p.callId) return;
      const key = deviceKey(p.fromUserId, p.fromDeviceId);
      const pc = pcMapRef.current.get(key);
      if (pc && remoteDescSetRef.current.get(key)) {
        pc.addIceCandidate(p.candidate).catch(() => undefined);
      } else {
        const list = pendingCandidatesRef.current.get(key) ?? [];
        list.push(p.candidate);
        pendingCandidatesRef.current.set(key, list);
      }
    });

    const offLeft = onRealtimeEvent('group-call.participant-left', (payload) => {
      const p = payload as unknown as { callId: string; userId: string; deviceId: string };
      if (callRef.current?.callId !== p.callId) return;
      closePeer(deviceKey(p.userId, p.deviceId));
      removeTile(p.userId, p.deviceId);
    });

    const offEnded = onRealtimeEvent('group-call.ended', (payload) => {
      const p = payload as unknown as { callId: string };
      if (callRef.current?.callId !== p.callId) return;
      teardownAll('Call ended');
    });

    return () => {
      offInvited();
      offRoster();
      offJoined();
      offOffer();
      offAnswer();
      offIce();
      offLeft();
      offEnded();
    };
  }, [closePeer, fetchIceServers, getOrCreatePeerConnection, removeTile, teardownAll, upsertTile]);

  const value = useMemo<GroupCallContextValue>(
    () => ({ startGroupCall, invite, acceptInvite, declineInvite, busy: phase !== 'idle' || invite !== null }),
    [startGroupCall, invite, acceptInvite, declineInvite, phase],
  );

  return (
    <GroupCallContext.Provider value={value}>
      {children}
      {phase !== 'idle' && call && (
        <GroupCallOverlay
          phase={phase}
          call={call}
          participants={participants}
          muted={muted}
          statusText={statusText}
          micError={micError}
          onHangUp={hangUp}
          onToggleMute={toggleMute}
          onDismissMicError={() => setMicError(null)}
        />
      )}
      {phase === 'idle' && invite && (
        <div className="fixed inset-x-0 top-0 z-50 flex justify-center px-4 pt-4">
          <div className="flex w-full max-w-sm items-center gap-3 rounded-2xl border border-border bg-surface px-4 py-3 shadow-lg">
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium text-foreground">{invite.fromDisplayName} started a group call</p>
              <p className="truncate text-xs text-muted-foreground">{invite.groupName}</p>
            </div>
            <button
              type="button"
              onClick={declineInvite}
              className="rounded-full px-3 py-1.5 text-xs font-medium text-muted-foreground hover:bg-muted"
            >
              Dismiss
            </button>
            <button
              type="button"
              onClick={acceptInvite}
              className="rounded-full bg-emerald-500 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-600"
            >
              Join
            </button>
          </div>
        </div>
      )}
    </GroupCallContext.Provider>
  );
}
