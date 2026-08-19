'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { onRealtimeEvent, sendRealtimeEvent } from '@/lib/realtime-client';
import { apiFetch } from '@/lib/api-client';
import type { IceServersResponse, IceServer, CallSessionDescription, CallIceCandidateInit, CallRejectReason } from '@comm/types';
import { getActiveCallKind, setActiveCallKind } from '@/lib/call-coordination';
import { CallOverlay } from './call-overlay';

/**
 * 1:1 audio calling (docs/04-websocket-realtime.md's "Call signaling"). Mounted once
 * in `(app)/layout.tsx`, same as `RealtimeConnector` — an incoming call has to ring
 * no matter which page is open, not just while a specific chat thread is mounted.
 *
 * State lives in refs, not just React state: every handler here can fire from a WS
 * event (`onRealtimeEvent`) whose closure was created once at mount, so reading
 * `useState` values directly would see whatever `phase`/`call` was at mount time, not
 * the latest — the exact staleness problem `components/chat/chats-shell.tsx` solves
 * with `openIdRef`. Refs are the source of truth; `useState` mirrors them purely so
 * the UI re-renders, always written together at the same call site.
 */

export type CallPhase = 'idle' | 'outgoing' | 'incoming' | 'connected' | 'ended';

export interface ActiveCall {
  callId: string;
  conversationId: string;
  otherUserId: string;
  otherDisplayName: string;
  direction: 'outgoing' | 'incoming';
}

interface CallContextValue {
  startCall: (conversationId: string, otherUserId: string, otherDisplayName: string) => void;
  busy: boolean;
}

const CallContext = createContext<CallContextValue | null>(null);

export function useCall(): CallContextValue {
  const ctx = useContext(CallContext);
  if (!ctx) throw new Error('useCall must be used within CallProvider');
  return ctx;
}

const RING_TIMEOUT_MS = 45_000;

/**
 * Whether this browser can even attempt to choose an audio OUTPUT device at all.
 * Found live from a real report ("the voice is coming from the speaker when
 * calling") — a plain `<audio>` element playing a WebRTC stream has no notion of
 * "this is a phone call, use the earpiece": that's a native-app-only concept
 * (AudioManager/AVAudioSession), and browsers route it as ordinary media audio,
 * which Android defaults to the loudspeaker. There is no way to fix the *default*
 * from here — `setSinkId` (the one relevant Web API) can only select a DIFFERENT
 * already-enumerated output device, checked once at module scope since it's a
 * fixed browser capability, not something that changes per call. Support is
 * genuinely inconsistent (Safari doesn't implement it at all as of this writing) —
 * every caller below fails closed to "toggle button doesn't render" rather than
 * offering a control that silently does nothing, the same "no PRF support, no
 * button" shape lib/crypto/biometric-unlock.ts already uses for the identical
 * "OS-level capability, not guaranteed" situation.
 */
const SPEAKER_TOGGLE_SUPPORTED =
  typeof window !== 'undefined' && typeof HTMLMediaElement !== 'undefined' && 'setSinkId' in HTMLMediaElement.prototype;

/**
 * Explicit audio constraints for both legs of a call (startCall's outgoing capture
 * and acceptCall's answering capture) — asked for directly ("make sure the audio
 * quality is good"). Plain `audio: true` already gets browser-default echo
 * cancellation/noise suppression/auto-gain in every evergreen browser, but leaving it
 * implicit means this app's call quality rides on whatever a given browser happens to
 * default to rather than what it actually wants — spelling it out is the same "don't
 * lean on an implicit default for something that matters" reasoning already applied
 * elsewhere (e.g. ws-server.ts's explicit Origin check on top of `SameSite=Strict`).
 * `ideal` throughout: requests, not guarantees — the browser/mic picks the closest it
 * can actually do, never a hard failure if unsupported.
 */
const AUDIO_CONSTRAINTS: MediaTrackConstraints = {
  echoCancellation: { ideal: true },
  noiseSuppression: { ideal: true },
  autoGainControl: { ideal: true },
  channelCount: { ideal: 1 },
  sampleRate: { ideal: 48000 },
};

/**
 * Raises the Opus encoder's bitrate ceiling for this call's own outgoing audio — the
 * other half of "make sure the audio quality is good." Browsers default Opus to a
 * fairly conservative bitrate (commonly capped well under 32kbps, tuned for
 * bandwidth-constrained mobile networks generally, not for two people on ordinary
 * broadband/wifi). There's no `RTCRtpSender` parameter for this — audio bitrate is
 * only controllable via the documented SDP-munging approach: editing the `a=fmtp`
 * line for the opus payload type before `setLocalDescription`. Applied to each side's
 * own offer/answer — the SDP direction that describes what THAT side will encode and
 * send, never the remote description — so both legs of the call independently ask for
 * better audio rather than one side's munge depending on the other's cooperation.
 * `useinbandfec=1` additionally turns on Opus's built-in forward error correction: a
 * real quality win specifically under the packet loss a self-hosted, single-region
 * deployment (no anycast/CDN network smoothing the path) is more likely to see than a
 * big provider's calling infrastructure.
 */
function boostOpusAudio(sdp: string): string {
  const rtpmapMatch = sdp.match(/a=rtpmap:(\d+) opus\/48000/);
  if (!rtpmapMatch) return sdp; // opus wasn't offered/negotiated — leave untouched rather than guess
  const payloadType = rtpmapMatch[1];
  const fmtpLineRegex = new RegExp(`a=fmtp:${payloadType} .*`);
  const extraParams = 'maxaveragebitrate=32000;useinbandfec=1';
  if (fmtpLineRegex.test(sdp)) {
    return sdp.replace(fmtpLineRegex, (line) => `${line};${extraParams}`);
  }
  // No existing fmtp line for this payload type (uncommon, but not invalid SDP) — add
  // one right after its rtpmap line rather than assume one is always present.
  return sdp.replace(rtpmapMatch[0], `${rtpmapMatch[0]}\r\na=fmtp:${payloadType} ${extraParams}`);
}

export function CallProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  const [phase, setPhase] = useState<CallPhase>('idle');
  const [call, setCall] = useState<ActiveCall | null>(null);
  const [muted, setMuted] = useState(false);
  // Directly asked for ("by default it should not be on speaker") — a call now
  // actively routes to the earpiece the moment audio starts (see `routeCallAudio` in
  // `createPeerConnection`'s `ontrack`) instead of just offering a manual toggle
  // starting on whatever the browser's own default happened to be. This flag is
  // still only a best-effort LABEL, not a query of the real hardware route (no Web
  // API exposes that) — it starts `false` to match what `routeCallAudio` is about to
  // attempt, and only flips to `true` if that attempt genuinely fails (see
  // `routeCallAudio`'s own comment on why that fallback exists).
  const [speakerOn, setSpeakerOn] = useState(false);
  const [durationSec, setDurationSec] = useState(0);
  const [statusText, setStatusText] = useState('');
  const [micError, setMicError] = useState<string | null>(null);

  const phaseRef = useRef<CallPhase>('idle');
  const callRef = useRef<ActiveCall | null>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const remoteAudioRef = useRef<HTMLAudioElement | null>(null);
  const pendingCandidatesRef = useRef<CallIceCandidateInit[]>([]);
  const remoteDescSetRef = useRef(false);
  const pendingOfferRef = useRef<CallSessionDescription | null>(null);
  const ringTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const durationIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const teardown = useCallback((finalStatus: string) => {
    const idAtTeardown = callRef.current?.callId ?? null;
    // Cleared immediately, not deferred to the 'ended' cooldown's setTimeout below
    // — a fresh incoming call (1:1 or group) arriving during that ~2.5s window is
    // meant to preempt it (see that setTimeout's own comment), so this must stop
    // blocking the other provider the instant this call actually ends, not after.
    setActiveCallKind(null);

    if (ringTimeoutRef.current) {
      clearTimeout(ringTimeoutRef.current);
      ringTimeoutRef.current = null;
    }
    if (durationIntervalRef.current) {
      clearInterval(durationIntervalRef.current);
      durationIntervalRef.current = null;
    }
    pcRef.current?.getSenders().forEach((s) => s.track?.stop());
    pcRef.current?.close();
    pcRef.current = null;
    localStreamRef.current?.getTracks().forEach((t) => t.stop());
    localStreamRef.current = null;
    pendingCandidatesRef.current = [];
    remoteDescSetRef.current = false;
    pendingOfferRef.current = null;
    if (remoteAudioRef.current) remoteAudioRef.current.srcObject = null;

    phaseRef.current = 'ended';
    setStatusText(finalStatus);
    setPhase('ended');
    setDurationSec(0);
    setMuted(false);
    setSpeakerOn(false); // matches what the next call will attempt by default — see its useState's own comment

    // Left up briefly so the user sees why the call stopped, rather than the UI just
    // vanishing. Guarded on both reads below in case a NEW call (an incoming ring)
    // arrives during this window — it must win, not get clobbered back to idle.
    setTimeout(() => {
      if (phaseRef.current === 'ended') {
        phaseRef.current = 'idle';
        setPhase('idle');
      }
      if (callRef.current?.callId === idAtTeardown) {
        callRef.current = null;
        setCall(null);
      }
    }, 2500);
  }, []);

  /**
   * Attempts to point the remote audio element at a specific labeled output device —
   * shared by the automatic earpiece-on-connect routing below and the manual
   * speaker-toggle button. Returns whether a labeled match was actually found and
   * applied; the two call sites deliberately handle a "no match" result
   * differently (see each one's own comment), so this stays a plain yes/no rather
   * than picking a fallback on their behalf.
   */
  const selectAudioOutput = useCallback(async (wantSpeaker: boolean): Promise<boolean> => {
    const audioEl = remoteAudioRef.current as (HTMLAudioElement & { setSinkId(id: string): Promise<void> }) | null;
    if (!SPEAKER_TOGGLE_SUPPORTED || !audioEl) return false;
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const match = devices.find(
        (d) => d.kind === 'audiooutput' && (wantSpeaker ? /speaker/i.test(d.label) : /earpiece|receiver/i.test(d.label)),
      );
      if (!match) return false;
      await audioEl.setSinkId(match.deviceId);
      return true;
    } catch {
      return false;
    }
  }, []);

  const createPeerConnection = useCallback(
    (iceServers: IceServer[], conversationId: string, callId: string): RTCPeerConnection => {
      const pc = new RTCPeerConnection({ iceServers });

      pc.onicecandidate = (e) => {
        if (e.candidate) {
          sendRealtimeEvent({ type: 'call.ice-candidate', conversationId, callId, candidate: e.candidate.toJSON() });
        }
      };

      pc.ontrack = (e) => {
        if (remoteAudioRef.current) {
          remoteAudioRef.current.srcObject = e.streams[0] ?? null;
          void remoteAudioRef.current.play().catch(() => {});
          // "By default it should not be on speaker" — actively route to the
          // earpiece the instant call audio starts, rather than leaving it wherever
          // the browser's own default lands (the loudspeaker, on the platform this
          // was reported from — see SPEAKER_TOGGLE_SUPPORTED's docstring). Only
          // flips the speakerOn LABEL to true if this genuinely couldn't be
          // confirmed, so the button's label stays honest either way.
          void selectAudioOutput(false).then((applied) => setSpeakerOn(!applied));
        }
      };

      pc.onconnectionstatechange = () => {
        if (pc !== pcRef.current) return; // stale event from an already-torn-down connection
        if (pc.connectionState === 'connected') {
          if (ringTimeoutRef.current) {
            clearTimeout(ringTimeoutRef.current);
            ringTimeoutRef.current = null;
          }
          phaseRef.current = 'connected';
          setPhase('connected');
          setStatusText('');
          if (!durationIntervalRef.current) {
            durationIntervalRef.current = setInterval(() => setDurationSec((s) => s + 1), 1000);
          }
        } else if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
          teardown('Call ended');
        }
      };

      return pc;
    },
    [teardown, selectAudioOutput],
  );

  const fetchIceServers = useCallback(async (): Promise<IceServer[]> => {
    try {
      const res = await apiFetch<IceServersResponse>('/api/calls/turn-credentials', { method: 'POST' });
      return res.iceServers;
    } catch {
      // Falls back to host/reflexive-only candidates — enough on the same network;
      // see docs/04-websocket-realtime.md's call-signaling note on why an empty list
      // is expected until coturn (docs/11-deployment-architecture.md) is deployed.
      return [];
    }
  }, []);

  const startCall = useCallback(
    (conversationId: string, otherUserId: string, otherDisplayName: string) => {
      if (phaseRef.current !== 'idle' || getActiveCallKind()) return;

      void (async () => {
        setMicError(null);
        let stream: MediaStream;
        try {
          stream = await navigator.mediaDevices.getUserMedia({ audio: AUDIO_CONSTRAINTS, video: false });
        } catch {
          setMicError('Microphone access is needed to make a call.');
          return;
        }
        localStreamRef.current = stream;
        setActiveCallKind('1:1');

        const callId = crypto.randomUUID();
        const next: ActiveCall = { callId, conversationId, otherUserId, otherDisplayName, direction: 'outgoing' };
        callRef.current = next;
        phaseRef.current = 'outgoing';
        setCall(next);
        setPhase('outgoing');
        setStatusText('Calling…');

        const iceServers = await fetchIceServers();
        const pc = createPeerConnection(iceServers, conversationId, callId);
        pcRef.current = pc;
        stream.getTracks().forEach((t) => pc.addTrack(t, stream));

        const offer = await pc.createOffer();
        offer.sdp = boostOpusAudio(offer.sdp ?? '');
        await pc.setLocalDescription(offer);

        sendRealtimeEvent({ type: 'call.invite', conversationId, callId, sdp: { type: 'offer', sdp: offer.sdp ?? '' } });

        ringTimeoutRef.current = setTimeout(() => {
          sendRealtimeEvent({ type: 'call.end', conversationId, callId });
          teardown('No answer');
        }, RING_TIMEOUT_MS);
      })();
    },
    [createPeerConnection, fetchIceServers, teardown],
  );

  const acceptCall = useCallback(() => {
    const active = callRef.current;
    const offer = pendingOfferRef.current;
    if (!active || phaseRef.current !== 'incoming' || !offer) return;

    void (async () => {
      setMicError(null);
      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: AUDIO_CONSTRAINTS, video: false });
      } catch {
        setMicError('Microphone access is needed to answer.');
        sendRealtimeEvent({ type: 'call.reject', conversationId: active.conversationId, callId: active.callId, reason: 'declined' });
        teardown('Call declined');
        return;
      }
      localStreamRef.current = stream;

      const iceServers = await fetchIceServers();
      const pc = createPeerConnection(iceServers, active.conversationId, active.callId);
      pcRef.current = pc;
      stream.getTracks().forEach((t) => pc.addTrack(t, stream));

      await pc.setRemoteDescription(offer);
      remoteDescSetRef.current = true;
      for (const c of pendingCandidatesRef.current) {
        try {
          await pc.addIceCandidate(c);
        } catch {
          // A single stale/malformed buffered candidate isn't fatal — WebRTC
          // negotiation succeeds as long as at least one usable candidate pair is
          // found among the rest, so this is skipped rather than surfaced.
        }
      }
      pendingCandidatesRef.current = [];

      const answer = await pc.createAnswer();
      answer.sdp = boostOpusAudio(answer.sdp ?? '');
      await pc.setLocalDescription(answer);

      sendRealtimeEvent({
        type: 'call.answer',
        conversationId: active.conversationId,
        callId: active.callId,
        sdp: { type: 'answer', sdp: answer.sdp ?? '' },
      });
      setStatusText('Connecting…');
    })();
  }, [createPeerConnection, fetchIceServers, teardown]);

  const rejectCall = useCallback(
    (reason: CallRejectReason) => {
      const active = callRef.current;
      if (active) {
        sendRealtimeEvent({ type: 'call.reject', conversationId: active.conversationId, callId: active.callId, reason });
      }
      teardown(reason === 'busy' ? 'Call ended' : 'Call declined');
    },
    [teardown],
  );

  const hangUp = useCallback(() => {
    const active = callRef.current;
    if (active) {
      sendRealtimeEvent({ type: 'call.end', conversationId: active.conversationId, callId: active.callId });
    }
    teardown('Call ended');
  }, [teardown]);

  const toggleMute = useCallback(() => {
    setMuted((m) => {
      const next = !m;
      localStreamRef.current?.getAudioTracks().forEach((t) => {
        t.enabled = !next;
      });
      return next;
    });
  }, []);

  /**
   * Manual override for the automatic earpiece routing in `ontrack` above — someone
   * deliberately wants speakerphone (or wants to go back to the earpiece after
   * turning it on). Unlike the automatic call-start attempt, this always honors the
   * tap and flips the label regardless of whether a labeled match was actually
   * found — a button that sometimes visibly does nothing when pressed is worse UX
   * than an occasionally-optimistic label, and `selectAudioOutput` already tried its
   * best either way.
   */
  const toggleSpeaker = useCallback(() => {
    if (!SPEAKER_TOGGLE_SUPPORTED) return;
    const next = !speakerOn;
    void selectAudioOutput(next).finally(() => setSpeakerOn(next));
  }, [speakerOn, selectAudioOutput]);

  useEffect(() => {
    const offRing = onRealtimeEvent('call.ring', (payload) => {
      const p = payload as unknown as {
        conversationId: string;
        callId: string;
        fromUserId: string;
        fromDisplayName: string;
        sdp: CallSessionDescription;
      };
      // Busy if already on (or wrapping up) a 1:1 call, OR mid a group call — the
      // group-call side has no per-invitee "busy" signal to send back the way 1:1
      // does (see call-coordination.ts's own docstring), so this 1:1 ring is the
      // one place that asymmetry has to be handled: reject as busy exactly like
      // the same-kind case just below.
      if ((phaseRef.current !== 'idle' && phaseRef.current !== 'ended') || getActiveCallKind() === 'group') {
        sendRealtimeEvent({ type: 'call.reject', conversationId: p.conversationId, callId: p.callId, reason: 'busy' });
        return;
      }
      pendingOfferRef.current = p.sdp;
      const next: ActiveCall = {
        callId: p.callId,
        conversationId: p.conversationId,
        otherUserId: p.fromUserId,
        otherDisplayName: p.fromDisplayName,
        direction: 'incoming',
      };
      callRef.current = next;
      phaseRef.current = 'incoming';
      setActiveCallKind('1:1');
      setCall(next);
      setPhase('incoming');
      setStatusText('Incoming call…');
      setMicError(null);
      // Tells the caller's side to move from "Calling…" to "Ringing…" — see
      // CallRingingRequest's own docstring (packages/types/src/calls.ts). This
      // handler is also what `checkPendingCall`-style catch-up would feed into if
      // this app ever grows one; either way, this device's incoming-call screen
      // has now actually appeared, which is exactly the moment worth telling the
      // caller about.
      sendRealtimeEvent({ type: 'call.ringing', conversationId: p.conversationId, callId: p.callId });
    });

    const offRinging = onRealtimeEvent('call.ringing', (payload) => {
      const p = payload as unknown as { callId: string };
      if (callRef.current?.callId !== p.callId || phaseRef.current !== 'outgoing') return;
      setStatusText('Ringing…');
    });

    const offAnswered = onRealtimeEvent('call.answered', (payload) => {
      const p = payload as unknown as { callId: string; sdp: CallSessionDescription };
      const pc = pcRef.current;
      if (!pc || callRef.current?.callId !== p.callId) return;
      void (async () => {
        await pc.setRemoteDescription(p.sdp);
        remoteDescSetRef.current = true;
        for (const c of pendingCandidatesRef.current) {
          try {
            await pc.addIceCandidate(c);
          } catch {
            // Same "one stale candidate isn't fatal" reasoning as the other
            // buffered-candidate catch above.
          }
        }
        pendingCandidatesRef.current = [];
        setStatusText('Connecting…');
      })();
    });

    const offIce = onRealtimeEvent('call.ice-candidate', (payload) => {
      const p = payload as unknown as { callId: string; candidate: CallIceCandidateInit };
      if (callRef.current?.callId !== p.callId) return;
      const pc = pcRef.current;
      if (pc && remoteDescSetRef.current) {
        // Same "a single bad candidate isn't fatal" reasoning as the buffered-candidate
        // catches above.
        pc.addIceCandidate(p.candidate).catch(() => undefined);
      } else {
        pendingCandidatesRef.current.push(p.candidate);
      }
    });

    const offRejected = onRealtimeEvent('call.rejected', (payload) => {
      const p = payload as unknown as { callId: string; reason: CallRejectReason };
      if (callRef.current?.callId !== p.callId) return;
      teardown(
        p.reason === 'busy'
          ? 'Busy'
          : p.reason === 'answered_elsewhere'
            ? 'Answered on another device'
            : 'Call declined',
      );
    });

    const offEnded = onRealtimeEvent('call.ended', (payload) => {
      const p = payload as unknown as { callId: string };
      if (callRef.current?.callId !== p.callId) return;
      teardown('Call ended');
    });

    return () => {
      offRing();
      offRinging();
      offAnswered();
      offIce();
      offRejected();
      offEnded();
    };
  }, [teardown]);

  const value = useMemo<CallContextValue>(() => ({ startCall, busy: phase !== 'idle' }), [startCall, phase]);

  return (
    <CallContext.Provider value={value}>
      {children}
      {/* Hidden sink for the remote party's audio track — always mounted so
          `pc.ontrack` has somewhere to attach regardless of call state. */}
      <audio ref={remoteAudioRef} autoPlay playsInline className="hidden" />
      {phase !== 'idle' && call && (
        <CallOverlay
          phase={phase}
          call={call}
          muted={muted}
          speakerOn={speakerOn}
          speakerSupported={SPEAKER_TOGGLE_SUPPORTED}
          durationSec={durationSec}
          statusText={statusText}
          micError={micError}
          onAccept={acceptCall}
          onDecline={() => rejectCall('declined')}
          onHangUp={hangUp}
          onToggleMute={toggleMute}
          onToggleSpeaker={toggleSpeaker}
          onDismissMicError={() => setMicError(null)}
        />
      )}
    </CallContext.Provider>
  );
}
