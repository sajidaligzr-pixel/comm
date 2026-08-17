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
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_webrtc/flutter_webrtc.dart';
import 'package:permission_handler/permission_handler.dart';
import 'package:uuid/uuid.dart';

import '../../api/calls_api.dart';
import '../../app/providers.dart';
import '../../realtime/ws_client.dart';
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
    return sdp.replaceFirstMapped(fmtpLineRegex, (m) => '${m.group(0)};$extraParams');
  }
  return sdp.replaceFirst(rtpmapMatch.group(0)!, '${rtpmapMatch.group(0)}\r\na=fmtp:$payloadType $extraParams');
}

class CallController extends StateNotifier<CallUiState> {
  CallController(this._callsApi, this._realtime) : super(const CallUiState()) {
    _realtime.on('call.ring', _onRing);
    _realtime.on('call.answered', _onAnswered);
    _realtime.on('call.ice-candidate', _onRemoteIceCandidate);
    _realtime.on('call.rejected', _onRejected);
    _realtime.on('call.ended', _onEnded);
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

  @override
  void dispose() {
    _realtime.off('call.ring', _onRing);
    _realtime.off('call.answered', _onAnswered);
    _realtime.off('call.ice-candidate', _onRemoteIceCandidate);
    _realtime.off('call.rejected', _onRejected);
    _realtime.off('call.ended', _onEnded);
    _teardown('');
    super.dispose();
  }

  Future<bool> _ensureMicPermission() async {
    final status = await Permission.microphone.request();
    return status.isGranted;
  }

  Future<RTCPeerConnection> _createPeerConnection(List<IceServer> iceServers) async {
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
        'candidate': {'candidate': candidate.candidate, 'sdpMid': candidate.sdpMid, 'sdpMLineIndex': candidate.sdpMLineIndex},
      });
    };

    pc.onConnectionState = (connectionState) {
      if (pc != _pc) return; // stale event from an already-torn-down connection
      if (connectionState == RTCPeerConnectionState.RTCPeerConnectionStateConnected) {
        _ringTimer?.cancel();
        _ringTimer = null;
        state = state.copyWith(phase: CallPhase.connected, statusText: '');
        _durationTimer ??= Timer.periodic(const Duration(seconds: 1), (_) {
          state = state.copyWith(durationSec: state.durationSec + 1);
        });
      } else if (connectionState == RTCPeerConnectionState.RTCPeerConnectionStateFailed ||
          connectionState == RTCPeerConnectionState.RTCPeerConnectionStateClosed) {
        _teardown('Call ended');
      }
    };

    return pc;
  }

  void _teardown(String finalStatus) {
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
    state = state.copyWith(phase: CallPhase.ended, statusText: finalStatus, durationSec: 0, muted: false, speakerOn: false);
    unawaited(Helper.setSpeakerphoneOn(false));

    _resetTimer?.cancel();
    _resetTimer = Timer(const Duration(milliseconds: 2500), () {
      if (mounted && state.phase == CallPhase.ended) {
        state = state.copyWith(phase: CallPhase.idle, clearCall: true);
      }
    });
  }

  Future<void> startCall(String conversationId, String otherUserId, String otherDisplayName) async {
    if (state.phase != CallPhase.idle) return;
    if (!await _ensureMicPermission()) {
      state = state.copyWith(micError: 'Microphone access is needed to make a call.');
      return;
    }

    late final MediaStream stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia(_audioConstraints);
    } catch (_) {
      state = state.copyWith(micError: 'Microphone access is needed to make a call.');
      return;
    }
    _localStream = stream;

    final callId = _uuid.v4();
    final call = ActiveCall(callId: callId, conversationId: conversationId, otherUserId: otherUserId, otherDisplayName: otherDisplayName, isOutgoing: true);
    state = state.copyWith(phase: CallPhase.outgoing, call: call, statusText: 'Calling…', clearMicError: true);

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
      _realtime.send({'type': 'call.end', 'conversationId': conversationId, 'callId': callId});
      _teardown('No answer');
    });
  }

  Future<void> acceptCall() async {
    final call = state.call;
    final offer = _pendingOffer;
    if (call == null || state.phase != CallPhase.incoming || offer == null) return;

    if (!await _ensureMicPermission()) {
      state = state.copyWith(micError: 'Microphone access is needed to answer.');
      _realtime.send({'type': 'call.reject', 'conversationId': call.conversationId, 'callId': call.callId, 'reason': 'declined'});
      _teardown('Call declined');
      return;
    }

    late final MediaStream stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia(_audioConstraints);
    } catch (_) {
      state = state.copyWith(micError: 'Microphone access is needed to answer.');
      _realtime.send({'type': 'call.reject', 'conversationId': call.conversationId, 'callId': call.callId, 'reason': 'declined'});
      _teardown('Call declined');
      return;
    }
    _localStream = stream;

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
    answer = RTCSessionDescription(_boostOpusAudio(answer.sdp ?? ''), answer.type);
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
      _realtime.send({'type': 'call.reject', 'conversationId': call.conversationId, 'callId': call.callId, 'reason': reason});
    }
    _teardown(reason == 'busy' ? 'Call ended' : 'Call declined');
  }

  void hangUp() {
    final call = state.call;
    if (call != null) {
      _realtime.send({'type': 'call.end', 'conversationId': call.conversationId, 'callId': call.callId});
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

  void _onRing(Map<String, dynamic> payload) {
    if (state.phase != CallPhase.idle && state.phase != CallPhase.ended) {
      // Already on (or wrapping up) a call — decline as busy, no second ring UI.
      _realtime.send({
        'type': 'call.reject',
        'conversationId': payload['conversationId'],
        'callId': payload['callId'],
        'reason': 'busy',
      });
      return;
    }
    final sdp = payload['sdp'] as Map<String, dynamic>;
    _pendingOffer = RTCSessionDescription(sdp['sdp'] as String?, sdp['type'] as String?);
    final call = ActiveCall(
      callId: payload['callId'] as String,
      conversationId: payload['conversationId'] as String,
      otherUserId: payload['fromUserId'] as String,
      otherDisplayName: payload['fromDisplayName'] as String,
      isOutgoing: false,
    );
    state = state.copyWith(phase: CallPhase.incoming, call: call, statusText: 'Incoming call…', clearMicError: true);
  }

  void _onAnswered(Map<String, dynamic> payload) {
    final pc = _pc;
    if (pc == null || state.call?.callId != payload['callId']) return;
    final sdp = payload['sdp'] as Map<String, dynamic>;
    () async {
      await pc.setRemoteDescription(RTCSessionDescription(sdp['sdp'] as String?, sdp['type'] as String?));
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
    final candidate = RTCIceCandidate(c['candidate'] as String?, c['sdpMid'] as String?, c['sdpMLineIndex'] as int?);
    final pc = _pc;
    if (pc != null && _remoteDescSet) {
      pc.addCandidate(candidate).catchError((_) {});
    } else {
      _pendingCandidates.add(candidate);
    }
  }

  void _onRejected(Map<String, dynamic> payload) {
    if (state.call?.callId != payload['callId']) return;
    _teardown(payload['reason'] == 'busy' ? 'Busy' : 'Call declined');
  }

  void _onEnded(Map<String, dynamic> payload) {
    if (state.call?.callId != payload['callId']) return;
    _teardown('Call ended');
  }
}

final callControllerProvider = StateNotifierProvider<CallController, CallUiState>((ref) {
  final controller = CallController(ref.watch(callsApiProvider), ref.watch(realtimeClientProvider));
  ref.onDispose(controller.dispose);
  return controller;
});
