/// 1:1 audio calling — direct port of `apps/web/components/call/call-provider.tsx`'s
/// signaling logic onto `flutter_webrtc`. Same WS event names/shapes
/// (`call.invite`/`call.answer`/`call.ice-candidate`/`call.reject`/`call.end` out,
/// `call.ring`/`call.answered`/`call.ice-candidate`/`call.rejected`/`call.ended` in —
/// see packages/types/src/calls.ts and realtime/bus.ts), so the mobile client
/// interoperates with the web client's calling unchanged, no server changes needed.
///
/// One real, welcome difference from the web version: native WebRTC on Android/iOS
/// categorizes call audio as a voice call by default and routes to the earpiece
/// automatically — the "browsers default to the loudspeaker" bug that needed an
/// active `setSinkId` workaround on web (see call-provider.tsx's own docstring on
/// it) simply doesn't exist here. `Helper.setSpeakerphoneOn` is still wired for the
/// manual toggle button, defaulting to off (earpiece) to match.
library;

import 'dart:async';
import 'package:audioplayers/audioplayers.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_webrtc/flutter_webrtc.dart';
import 'package:permission_handler/permission_handler.dart';
import 'package:uuid/uuid.dart';

import '../../api/calls_api.dart';
import '../../app/providers.dart';
import '../../realtime/ws_client.dart';
import 'call_coordination.dart';
import 'call_kit.dart' show endCallKit, setCallKitConnected;
import 'call_state.dart';

const _uuid = Uuid();
const _ringTimeout = Duration(seconds: 45);

const _audioConstraints = {
  'audio': {
    'echoCancellation': true,
    'noiseSuppression': true,
    'autoGainControl': true,
    'channelCount': 1,
  },
  'video': false,
};

/// Raises the Opus encoder's bitrate ceiling and turns on forward error
/// correction — same SDP-munging approach as the web client's `boostOpusAudio`
/// (there's no RTCRtpSender parameter for audio bitrate; editing the offer/answer's
/// own `a=fmtp` line is the only documented way).
String _boostOpusAudio(String sdp) {
  final rtpmapMatch = RegExp(r'a=rtpmap:(\d+) opus/48000').firstMatch(sdp);
  if (rtpmapMatch == null) return sdp;
  final payloadType = rtpmapMatch.group(1);
  final fmtpLineRegex = RegExp('a=fmtp:$payloadType .*');
  const extraParams = 'maxaveragebitrate=32000;useinbandfec=1';
  if (fmtpLineRegex.hasMatch(sdp)) {
    return sdp.replaceFirstMapped(
      fmtpLineRegex,
      (m) => '${m.group(0)};$extraParams',
    );
  }
  return sdp.replaceFirst(
    rtpmapMatch.group(0)!,
    '${rtpmapMatch.group(0)}\r\na=fmtp:$payloadType $extraParams',
  );
}

class CallController extends StateNotifier<CallUiState> {
  CallController(this._callsApi, this._realtime) : super(const CallUiState()) {
    _realtime.on('call.ring', _onRing);
    _realtime.on('call.ringing', _onRinging);
    _realtime.on('call.answered', _onAnswered);
    _realtime.on('call.ice-candidate', _onRemoteIceCandidate);
    _realtime.on('call.rejected', _onRejected);
    _realtime.on('call.ended', _onEnded);
    // Every fresh connection (first connect at app start, or a forced reconnect on
    // resume — ws_client.dart's `reconnect`) is a chance this device missed a
    // call.ring while it wasn't actually listening; see `checkPendingCall`'s own
    // docstring for the full reasoning. Kept inside this controller rather than
    // wired from app/app.dart or chats_list_screen.dart — this is the one place
    // that already owns both "is a call currently active" and "how to start
    // ringing," so nothing external needs to know this check exists at all.
    _realtime.on('connection.open', _onReconnect);
  }

  final CallsApi _callsApi;
  final RealtimeClient _realtime;

  RTCPeerConnection? _pc;
  MediaStream? _localStream;
  final List<RTCIceCandidate> _pendingCandidates = [];
  bool _remoteDescSet = false;
  RTCSessionDescription? _pendingOffer;
  Timer? _ringTimer;
  Timer? _durationTimer;
  Timer? _resetTimer;

  // A separate player from the one thread_screen.dart uses for voice-note
  // playback (each `AudioPlayer` instance is its own independent player) — this
  // one only ever plays the two short local assets below, on loop for the
  // ringtone. Volume follows this app's normal media stream, not the phone's
  // dedicated "Ring" volume slider the way a native dialer's ringtone would — a
  // real, disclosed limitation of doing this at the Flutter/`audioplayers` level
  // rather than through a native `RingtoneManager`-style API; still audible for
  // the common case (ringer not muted), just not silenced by the same control a
  // real phone call would be.
  final AudioPlayer _ringtonePlayer = AudioPlayer();

  Future<void> _startRinging() async {
    try {
      await _ringtonePlayer.setReleaseMode(ReleaseMode.loop);
      await _ringtonePlayer.play(AssetSource('sounds/ringtone.wav'));
    } catch (_) {
      // Missing/locked audio output shouldn't block showing the incoming-call
      // screen itself — same fail-open-on-the-UI, fail-silent-on-the-extra
      // reasoning as every other best-effort side effect in this file.
    }
  }

  Future<void> _stopRinging() async {
    try {
      await _ringtonePlayer.stop();
    } catch (_) {}
  }

  @override
  void dispose() {
    _realtime.off('call.ring', _onRing);
    _realtime.off('call.ringing', _onRinging);
    _realtime.off('call.answered', _onAnswered);
    _realtime.off('call.ice-candidate', _onRemoteIceCandidate);
    _realtime.off('call.rejected', _onRejected);
    _realtime.off('call.ended', _onEnded);
    _realtime.off('connection.open', _onReconnect);
    _teardown('');
    _ringtonePlayer.dispose();
    super.dispose();
  }

  Future<bool> _ensureMicPermission() async {
    final status = await Permission.microphone.request();
    return status.isGranted;
  }

  Future<RTCPeerConnection> _createPeerConnection(
    List<IceServer> iceServers,
  ) async {
    final pc = await createPeerConnection({
      'iceServers': iceServers.map((s) => s.toJson()).toList(),
    });

    pc.onIceCandidate = (candidate) {
      final call = state.call;
      if (call == null || candidate.candidate == null) return;
      _realtime.send({
        'type': 'call.ice-candidate',
        'conversationId': call.conversationId,
        'callId': call.callId,
        'candidate': {
          'candidate': candidate.candidate,
          'sdpMid': candidate.sdpMid,
          'sdpMLineIndex': candidate.sdpMLineIndex,
        },
      });
    };

    pc.onConnectionState = (connectionState) {
      if (pc != _pc) return; // stale event from an already-torn-down connection
      if (connectionState ==
          RTCPeerConnectionState.RTCPeerConnectionStateConnected) {
        _ringTimer?.cancel();
        _ringTimer = null;
        state = state.copyWith(phase: CallPhase.connected, statusText: '');
        final callId = state.call?.callId;
        if (callId != null) unawaited(setCallKitConnected(callId));
        _durationTimer ??= Timer.periodic(const Duration(seconds: 1), (_) {
          state = state.copyWith(durationSec: state.durationSec + 1);
        });
      } else if (connectionState ==
              RTCPeerConnectionState.RTCPeerConnectionStateFailed ||
          connectionState ==
              RTCPeerConnectionState.RTCPeerConnectionStateClosed) {
        _teardown('Call ended');
      }
    };

    return pc;
  }

  void _teardown(String finalStatus) {
    // The one call-resolution choke point (ring timeout, rejected, ended, ICE
    // failure, hangUp/rejectCall) — clearing the native incoming-call UI/ring here,
    // rather than at each of those call sites individually, covers every one of them
    // at once, including paths a push-woken call's own UI never touches (e.g. the
    // caller cancelling before this device even opens the app).
    //
    // Cleared immediately, not deferred to the 'ended' cooldown's Timer below — a
    // fresh incoming call (1:1 or group) arriving during that ~2.5s window is meant
    // to preempt it, so this must stop blocking GroupCallController the instant
    // this call actually ends, not after.
    setActiveCallKind(null);
    final callId = state.call?.callId;
    if (callId != null) unawaited(endCallKit(callId));
    unawaited(_stopRinging());

    _ringTimer?.cancel();
    _ringTimer = null;
    _durationTimer?.cancel();
    _durationTimer = null;

    _pc?.close();
    _pc = null;
    _localStream?.getTracks().forEach((t) => t.stop());
    _localStream = null;
    _pendingCandidates.clear();
    _remoteDescSet = false;
    _pendingOffer = null;

    if (!mounted) return;
    state = state.copyWith(
      phase: CallPhase.ended,
      statusText: finalStatus,
      durationSec: 0,
      muted: false,
      speakerOn: false,
    );
    unawaited(Helper.setSpeakerphoneOn(false));

    _resetTimer?.cancel();
    _resetTimer = Timer(const Duration(milliseconds: 2500), () {
      if (mounted && state.phase == CallPhase.ended) {
        state = state.copyWith(phase: CallPhase.idle, clearCall: true);
      }
    });
  }

  Future<void> startCall(
    String conversationId,
    String otherUserId,
    String otherDisplayName,
  ) async {
    if (state.phase != CallPhase.idle || getActiveCallKind() != null) return;

    final callId = _uuid.v4();
    final call = ActiveCall(
      callId: callId,
      conversationId: conversationId,
      otherUserId: otherUserId,
      otherDisplayName: otherDisplayName,
      isOutgoing: true,
    );
    // Set BEFORE the mic-permission check below, not after — CallOverlay only
    // renders once `call`/`phase` are populated (see its own idle/null guard at
    // the top of build()), so a permission denial hitting the early-return
    // below used to be entirely invisible: no dialog, no banner, nothing (found
    // live on iOS — see ios/Podfile's own comment on the permission_handler
    // setup gap that had been masking this).
    state = state.copyWith(
      phase: CallPhase.outgoing,
      call: call,
      statusText: 'Calling…',
      clearMicError: true,
    );

    if (!await _ensureMicPermission()) {
      state = state.copyWith(
        micError: 'Microphone access is needed to make a call.',
      );
      _teardown('Call ended');
      return;
    }

    late final MediaStream stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia(_audioConstraints);
    } catch (_) {
      state = state.copyWith(
        micError: 'Microphone access is needed to make a call.',
      );
      _teardown('Call ended');
      return;
    }
    _localStream = stream;
    setActiveCallKind(ActiveCallKind.oneToOne);
    // Actively force earpiece routing the moment this call's own audio session
    // starts — found live (reported directly: calls come out of the loudspeaker,
    // not the earpiece, by default). The class docstring's assumption that native
    // WebRTC categorizes call audio as a voice call and routes to the earpiece
    // automatically doesn't hold on every real device/OEM audio stack — Android's
    // speakerphone flag can be left ON from something else entirely (a previous
    // call that used the toggle, a video app, etc.) and nothing resets it FOR the
    // next call, only after one ends (see `_teardown`'s own call to this). Setting
    // it explicitly here, not just trusting the default, is the same "don't lean
    // on an assumed default for something that matters" fix web's own
    // call-provider.tsx already applies via `selectAudioOutput(false)`.
    unawaited(Helper.setSpeakerphoneOn(false));

    final iceServers = await _callsApi.turnCredentials();
    final pc = await _createPeerConnection(iceServers);
    _pc = pc;
    for (final track in stream.getTracks()) {
      await pc.addTrack(track, stream);
    }

    var offer = await pc.createOffer();
    offer = RTCSessionDescription(_boostOpusAudio(offer.sdp ?? ''), offer.type);
    await pc.setLocalDescription(offer);

    _realtime.send({
      'type': 'call.invite',
      'conversationId': conversationId,
      'callId': callId,
      'sdp': {'type': 'offer', 'sdp': offer.sdp},
    });

    _ringTimer = Timer(_ringTimeout, () {
      _realtime.send({
        'type': 'call.end',
        'conversationId': conversationId,
        'callId': callId,
      });
      _teardown('No answer');
    });
  }

  Future<void> acceptCall() async {
    final call = state.call;
    final offer = _pendingOffer;
    if (call == null || state.phase != CallPhase.incoming || offer == null) {
      return;
    }
    // Stops the moment the user taps Accept, not once the (async, multi-step)
    // connection setup below finishes — a ring continuing through "Connecting…"
    // would read as a second call coming in.
    unawaited(_stopRinging());

    if (!await _ensureMicPermission()) {
      state = state.copyWith(
        micError: 'Microphone access is needed to answer.',
      );
      _realtime.send({
        'type': 'call.reject',
        'conversationId': call.conversationId,
        'callId': call.callId,
        'reason': 'declined',
      });
      _teardown('Call declined');
      return;
    }

    late final MediaStream stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia(_audioConstraints);
    } catch (_) {
      state = state.copyWith(
        micError: 'Microphone access is needed to answer.',
      );
      _realtime.send({
        'type': 'call.reject',
        'conversationId': call.conversationId,
        'callId': call.callId,
        'reason': 'declined',
      });
      _teardown('Call declined');
      return;
    }
    _localStream = stream;
    // Same active earpiece-forcing fix as startCall above — see that call site's
    // comment for why this can't be left to an assumed default.
    unawaited(Helper.setSpeakerphoneOn(false));

    final iceServers = await _callsApi.turnCredentials();
    final pc = await _createPeerConnection(iceServers);
    _pc = pc;
    for (final track in stream.getTracks()) {
      await pc.addTrack(track, stream);
    }

    await pc.setRemoteDescription(offer);
    _remoteDescSet = true;
    for (final c in _pendingCandidates) {
      try {
        await pc.addCandidate(c);
      } catch (_) {
        // A single stale/malformed buffered candidate isn't fatal.
      }
    }
    _pendingCandidates.clear();

    var answer = await pc.createAnswer();
    answer = RTCSessionDescription(
      _boostOpusAudio(answer.sdp ?? ''),
      answer.type,
    );
    await pc.setLocalDescription(answer);

    _realtime.send({
      'type': 'call.answer',
      'conversationId': call.conversationId,
      'callId': call.callId,
      'sdp': {'type': 'answer', 'sdp': answer.sdp},
    });
    state = state.copyWith(statusText: 'Connecting…');
  }

  void rejectCall([String reason = 'declined']) {
    final call = state.call;
    if (call != null) {
      _realtime.send({
        'type': 'call.reject',
        'conversationId': call.conversationId,
        'callId': call.callId,
        'reason': reason,
      });
    }
    _teardown(reason == 'busy' ? 'Call ended' : 'Call declined');
  }

  void hangUp() {
    final call = state.call;
    if (call != null) {
      _realtime.send({
        'type': 'call.end',
        'conversationId': call.conversationId,
        'callId': call.callId,
      });
    }
    _teardown('Call ended');
  }

  void toggleMute() {
    final next = !state.muted;
    _localStream?.getAudioTracks().forEach((t) => t.enabled = !next);
    state = state.copyWith(muted: next);
  }

  Future<void> toggleSpeaker() async {
    final next = !state.speakerOn;
    await Helper.setSpeakerphoneOn(next);
    state = state.copyWith(speakerOn: next);
  }

  void dismissMicError() => state = state.copyWith(clearMicError: true);

  void _onReconnect(Map<String, dynamic> _) => checkPendingCall();

  /// The catch-up half of push-notification calling (see calls_api.dart's
  /// `PendingCall` docstring) — called on every WS reconnect (ws_client.dart's
  /// `reconnect`, wired from app/app.dart's lifecycle observer and
  /// chats_list_screen.dart's initial connect) rather than only in response to a
  /// tapped call notification, so this also covers "the call push notification
  /// hasn't even arrived yet, but reconnecting is what surfaces it" — the two race
  /// against each other and whichever gets there first wins, same as any other
  /// live-vs-catch-up pair in this app (thread_screen.dart's `_load` after a WS
  /// event vs. after a reconnect). Feeds straight into `_onRing`, the exact same
  /// handler a live `call.ring` WS event uses, so there's exactly one "start
  /// ringing" code path regardless of which route delivered it.
  Future<void> checkPendingCall() async {
    if (state.phase != CallPhase.idle) {
      return; // already mid-call — nothing to catch up to
    }
    final pending = await _callsApi.pending();
    if (pending == null) return;
    if (state.phase != CallPhase.idle) {
      return; // re-check: a live event may have landed while awaiting above
    }
    _onRing(pending.toRingPayload());
  }

  /// Used by the call notification's "Accept" action button
  /// (local_notifications.dart, `showsUserInterface: true` — opens the app straight
  /// into this via main.dart's `onTap`) — `checkPendingCall`'s normal job is only
  /// ever surfacing the incoming-call screen for the user to choose from; this goes
  /// one step further and answers it immediately, matching what tapping "Accept" on
  /// a real phone call notification does. Safe to call even if a live 'call.ring'
  /// WS event already got here first: `checkPendingCall` no-ops once `phase` isn't
  /// idle, and this device is already `incoming` either way, which is all
  /// `acceptCall` itself needs.
  Future<void> acceptPendingCall() async {
    await checkPendingCall();
    if (state.phase == CallPhase.incoming) {
      await acceptCall();
    }
  }

  void _onRing(Map<String, dynamic> payload) {
    // Busy if already on (or wrapping up) a 1:1 call, OR mid a group call — the
    // group-call side has no per-invitee "busy" signal to send back the way 1:1
    // does (see call_coordination.dart's own docstring), so this is the one
    // place that asymmetry has to be handled: reject as busy exactly like the
    // same-kind case just below.
    if ((state.phase != CallPhase.idle && state.phase != CallPhase.ended) ||
        getActiveCallKind() == ActiveCallKind.group) {
      _realtime.send({
        'type': 'call.reject',
        'conversationId': payload['conversationId'],
        'callId': payload['callId'],
        'reason': 'busy',
      });
      return;
    }
    final sdp = payload['sdp'] as Map<String, dynamic>;
    _pendingOffer = RTCSessionDescription(
      sdp['sdp'] as String?,
      sdp['type'] as String?,
    );
    final call = ActiveCall(
      callId: payload['callId'] as String,
      conversationId: payload['conversationId'] as String,
      otherUserId: payload['fromUserId'] as String,
      otherDisplayName: payload['fromDisplayName'] as String,
      isOutgoing: false,
    );
    setActiveCallKind(ActiveCallKind.oneToOne);
    state = state.copyWith(
      phase: CallPhase.incoming,
      call: call,
      statusText: 'Incoming call…',
      clearMicError: true,
    );
    unawaited(_startRinging());
    // Tells the caller's side to move from "Calling…" to "Ringing…" — see
    // CallRingingRequest's own docstring (packages/types/src/calls.ts). Fired here
    // rather than only from a live 'call.ring' arrival specifically because `_onRing`
    // is also what `checkPendingCall`'s catch-up path feeds into (this same
    // function, not a separate one) — either way this device's incoming-call screen
    // has now actually appeared, which is exactly the moment worth telling the
    // caller about.
    _realtime.send({
      'type': 'call.ringing',
      'conversationId': call.conversationId,
      'callId': call.callId,
    });
  }

  void _onRinging(Map<String, dynamic> payload) {
    if (state.call?.callId != payload['callId'] ||
        state.phase != CallPhase.outgoing) {
      return;
    }
    state = state.copyWith(statusText: 'Ringing…');
  }

  void _onAnswered(Map<String, dynamic> payload) {
    final pc = _pc;
    if (pc == null || state.call?.callId != payload['callId']) return;
    final sdp = payload['sdp'] as Map<String, dynamic>;
    () async {
      await pc.setRemoteDescription(
        RTCSessionDescription(sdp['sdp'] as String?, sdp['type'] as String?),
      );
      _remoteDescSet = true;
      for (final c in _pendingCandidates) {
        try {
          await pc.addCandidate(c);
        } catch (_) {}
      }
      _pendingCandidates.clear();
      state = state.copyWith(statusText: 'Connecting…');
    }();
  }

  void _onRemoteIceCandidate(Map<String, dynamic> payload) {
    if (state.call?.callId != payload['callId']) return;
    final c = payload['candidate'] as Map<String, dynamic>;
    final candidate = RTCIceCandidate(
      c['candidate'] as String?,
      c['sdpMid'] as String?,
      c['sdpMLineIndex'] as int?,
    );
    final pc = _pc;
    if (pc != null && _remoteDescSet) {
      pc.addCandidate(candidate).catchError((_) {});
    } else {
      _pendingCandidates.add(candidate);
    }
  }

  void _onRejected(Map<String, dynamic> payload) {
    if (state.call?.callId != payload['callId']) return;
    final reason = payload['reason'];
    final message = reason == 'busy'
        ? 'Busy'
        : reason == 'answered_elsewhere'
        // Another of this account's active devices answered first — the
        // multi-device fan-out in call.invite (message-handlers.ts) is what makes
        // this reachable at all now; see that handler's own docstring.
        ? 'Answered on another device'
        : 'Call declined';
    _teardown(message);
  }

  void _onEnded(Map<String, dynamic> payload) {
    if (state.call?.callId != payload['callId']) return;
    _teardown('Call ended');
  }
}

final callControllerProvider =
    StateNotifierProvider<CallController, CallUiState>((ref) {
      final controller = CallController(
        ref.watch(callsApiProvider),
        ref.watch(realtimeClientProvider),
      );
      ref.onDispose(controller.dispose);
      return controller;
    });
