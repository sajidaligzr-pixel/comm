/// Group (mesh) audio calling — mobile counterpart to
/// `apps/web/components/call/group-call-provider.tsx`. Same WS event names/shapes
/// (`group-call.start`/`join`/`leave`/`offer`/`answer`/`ice-candidate` out,
/// `group-call.invited`/`roster`/`participant-joined`/`participant-left`/`ended`/
/// `offer`/`answer`/`ice-candidate` in — see packages/types/src/calls.ts and
/// realtime.ts), so this interoperates with the web client's group calling
/// unchanged, no server changes needed.
///
/// A SEPARATE controller from `CallController` (1:1), not an extension of it —
/// every participant opens a direct `RTCPeerConnection` to every OTHER
/// participant (N-1 connections each, capped at `GROUP_CALL_MAX_PARTICIPANTS`)
/// instead of 1:1's single peer connection. Kept as its own file/controller/
/// overlay entirely so the already-shipped, delicate 1:1 calling code
/// (`call_controller.dart`) needed zero changes beyond the small cross-controller
/// busy-coordination hook in `call_coordination.dart`.
library;

import 'dart:async';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_webrtc/flutter_webrtc.dart';
import 'package:permission_handler/permission_handler.dart';
import 'package:uuid/uuid.dart';

import '../../api/calls_api.dart';
import '../../app/providers.dart';
import '../../realtime/ws_client.dart';
import 'call_coordination.dart';
import 'group_call_state.dart';

const _uuid = Uuid();

const _audioConstraints = {
  'audio': {
    'echoCancellation': true,
    'noiseSuppression': true,
    'autoGainControl': true,
    'channelCount': 1,
  },
  'video': false,
};

String _key(String userId, String deviceId) => '$userId:$deviceId';

String _connectionStateLabel(RTCPeerConnectionState s) {
  switch (s) {
    case RTCPeerConnectionState.RTCPeerConnectionStateConnected:
      return 'connected';
    case RTCPeerConnectionState.RTCPeerConnectionStateFailed:
      return 'failed';
    case RTCPeerConnectionState.RTCPeerConnectionStateDisconnected:
      return 'disconnected';
    case RTCPeerConnectionState.RTCPeerConnectionStateClosed:
      return 'closed';
    case RTCPeerConnectionState.RTCPeerConnectionStateConnecting:
      return 'connecting';
    case RTCPeerConnectionState.RTCPeerConnectionStateNew:
      return 'new';
  }
}

class GroupCallController extends StateNotifier<GroupCallUiState> {
  GroupCallController(this._callsApi, this._realtime)
    : super(const GroupCallUiState()) {
    _realtime.on('group-call.invited', _onInvited);
    _realtime.on('group-call.roster', _onRoster);
    _realtime.on('group-call.participant-joined', _onParticipantJoined);
    _realtime.on('group-call.offer', _onOffer);
    _realtime.on('group-call.answer', _onAnswer);
    _realtime.on('group-call.ice-candidate', _onIceCandidate);
    _realtime.on('group-call.participant-left', _onParticipantLeft);
    _realtime.on('group-call.ended', _onEnded);
  }

  final CallsApi _callsApi;
  final RealtimeClient _realtime;

  MediaStream? _localStream;
  final Map<String, RTCPeerConnection> _peerConnections = {};
  final Map<String, List<RTCIceCandidate>> _pendingCandidates = {};
  final Map<String, bool> _remoteDescSet = {};
  Timer? _durationTimer;
  Timer? _resetTimer;

  @override
  void dispose() {
    _realtime.off('group-call.invited', _onInvited);
    _realtime.off('group-call.roster', _onRoster);
    _realtime.off('group-call.participant-joined', _onParticipantJoined);
    _realtime.off('group-call.offer', _onOffer);
    _realtime.off('group-call.answer', _onAnswer);
    _realtime.off('group-call.ice-candidate', _onIceCandidate);
    _realtime.off('group-call.participant-left', _onParticipantLeft);
    _realtime.off('group-call.ended', _onEnded);
    _teardownAll('');
    super.dispose();
  }

  Future<bool> _ensureMicPermission() async {
    final status = await Permission.microphone.request();
    return status.isGranted;
  }

  void _closePeer(String key) {
    _peerConnections.remove(key)?.close();
    _pendingCandidates.remove(key);
    _remoteDescSet.remove(key);
  }

  void _teardownAll(String finalStatus) {
    setActiveCallKind(null);
    for (final key in _peerConnections.keys.toList()) {
      _closePeer(key);
    }
    _localStream?.getTracks().forEach((t) => t.stop());
    _localStream = null;
    _durationTimer?.cancel();
    _durationTimer = null;

    if (!mounted) return;
    state = state.copyWith(
      phase: GroupCallPhase.ended,
      statusText: finalStatus,
      participants: const [],
      muted: false,
      durationSec: 0,
    );

    _resetTimer?.cancel();
    _resetTimer = Timer(const Duration(milliseconds: 2000), () {
      if (mounted && state.phase == GroupCallPhase.ended) {
        state = state.copyWith(phase: GroupCallPhase.idle, clearCall: true);
      }
    });
  }

  void _upsertTile(
    String userId,
    String deviceId,
    String connectionState, {
    String? displayName,
  }) {
    final key = _key(userId, deviceId);
    final idx = state.participants.indexWhere(
      (p) => _key(p.userId, p.deviceId) == key,
    );
    final next = List<GroupCallParticipantTile>.from(state.participants);
    if (idx == -1) {
      next.add(
        GroupCallParticipantTile(
          userId: userId,
          deviceId: deviceId,
          displayName: displayName ?? 'Participant',
          connectionState: connectionState,
        ),
      );
    } else {
      next[idx] = next[idx].copyWith(
        connectionState: connectionState,
        displayName: displayName,
      );
    }
    state = state.copyWith(participants: next);
  }

  void _removeTile(String userId, String deviceId) {
    final key = _key(userId, deviceId);
    state = state.copyWith(
      participants: state.participants
          .where((p) => _key(p.userId, p.deviceId) != key)
          .toList(),
    );
  }

  /// One direction of one pairwise connection — used both by the offering side
  /// (existing participants reacting to `group-call.participant-joined`) and the
  /// answering side (a joiner reacting to `group-call.offer`); which side
  /// actually calls `createOffer` is decided entirely by the caller.
  Future<RTCPeerConnection> _getOrCreatePeerConnection(
    String targetUserId,
    String targetDeviceId,
    List<IceServer> iceServers,
    String conversationId,
    String callId,
  ) async {
    final key = _key(targetUserId, targetDeviceId);
    final existing = _peerConnections[key];
    if (existing != null) return existing;

    final pc = await createPeerConnection({
      'iceServers': iceServers.map((s) => s.toJson()).toList(),
    });
    _peerConnections[key] = pc;

    pc.onIceCandidate = (candidate) {
      if (candidate.candidate == null) return;
      _realtime.send({
        'type': 'group-call.ice-candidate',
        'conversationId': conversationId,
        'callId': callId,
        'targetUserId': targetUserId,
        'targetDeviceId': targetDeviceId,
        'candidate': {
          'candidate': candidate.candidate,
          'sdpMid': candidate.sdpMid,
          'sdpMLineIndex': candidate.sdpMLineIndex,
        },
      });
    };

    pc.onConnectionState = (s) {
      if (_peerConnections[key] != pc) return; // stale, already torn down
      _upsertTile(targetUserId, targetDeviceId, _connectionStateLabel(s));
    };

    final localStream = _localStream;
    if (localStream != null) {
      for (final track in localStream.getTracks()) {
        await pc.addTrack(track, localStream);
      }
    }

    return pc;
  }

  Future<bool> _enterCall(
    ActiveGroupCall call,
    String statusWhileWaiting,
  ) async {
    if (!await _ensureMicPermission()) {
      state = state.copyWith(
        micError: 'Microphone access is needed to join a call.',
      );
      return false;
    }
    late final MediaStream stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia(_audioConstraints);
    } catch (_) {
      state = state.copyWith(
        micError: 'Microphone access is needed to join a call.',
      );
      return false;
    }
    _localStream = stream;
    setActiveCallKind(ActiveCallKind.group);
    state = state.copyWith(
      phase: GroupCallPhase.active,
      call: call,
      participants: const [],
      statusText: statusWhileWaiting,
      clearMicError: true,
    );
    return true;
  }

  Future<void> startGroupCall(String conversationId, String groupName) async {
    if (state.phase != GroupCallPhase.idle || getActiveCallKind() != null) {
      return;
    }
    final callId = _uuid.v4();
    final ok = await _enterCall(
      ActiveGroupCall(
        callId: callId,
        conversationId: conversationId,
        groupName: groupName,
      ),
      'Waiting for others to join…',
    );
    if (!ok) return;
    _realtime.send({
      'type': 'group-call.start',
      'conversationId': conversationId,
      'callId': callId,
    });
  }

  Future<void> acceptInvite() async {
    final invite = state.invite;
    if (invite == null ||
        state.phase != GroupCallPhase.idle ||
        getActiveCallKind() != null) {
      return;
    }
    final ok = await _enterCall(
      ActiveGroupCall(
        callId: invite.callId,
        conversationId: invite.conversationId,
        groupName: invite.groupName,
      ),
      'Connecting…',
    );
    state = state.copyWith(clearInvite: true);
    if (!ok) return;
    _realtime.send({
      'type': 'group-call.join',
      'conversationId': invite.conversationId,
      'callId': invite.callId,
    });
  }

  void declineInvite() {
    // No signal sent back — a group call has no per-invitee "ringing" state the
    // way 1:1 does (see call_coordination.dart's docstring on this asymmetry);
    // declining is simply not joining.
    state = state.copyWith(clearInvite: true);
  }

  void hangUp() {
    final call = state.call;
    if (call != null) {
      _realtime.send({
        'type': 'group-call.leave',
        'conversationId': call.conversationId,
        'callId': call.callId,
      });
    }
    _teardownAll('Call ended');
  }

  void toggleMute() {
    final next = !state.muted;
    _localStream?.getAudioTracks().forEach((t) => t.enabled = !next);
    state = state.copyWith(muted: next);
  }

  void dismissMicError() => state = state.copyWith(clearMicError: true);

  void _onInvited(Map<String, dynamic> payload) {
    if (state.phase != GroupCallPhase.idle || getActiveCallKind() != null) {
      return; // already on a call — no per-invitee reject to send, see declineInvite's comment
    }
    state = state.copyWith(
      invite: GroupCallInvite(
        callId: payload['callId'] as String,
        conversationId: payload['conversationId'] as String,
        fromUserId: payload['fromUserId'] as String,
        fromDisplayName: payload['fromDisplayName'] as String,
        groupName: payload['groupName'] as String,
      ),
    );
  }

  void _onRoster(Map<String, dynamic> payload) {
    final call = state.call;
    if (call == null || call.callId != payload['callId']) return;
    // Informational only — renders a tile per already-there participant right
    // away. This device does NOT open connections from this event; existing
    // participants initiate offers TO the joiner (see _onOffer below), never the
    // other way, avoiding SDP glare — see GroupCallEvent's own docstring
    // (packages/types/src/realtime.ts) for the full convention.
    final participants = (payload['participants'] as List)
        .cast<Map<String, dynamic>>();
    for (final p in participants) {
      _upsertTile(
        p['userId'] as String,
        p['deviceId'] as String,
        'pending',
        displayName: p['displayName'] as String,
      );
    }
  }

  void _onParticipantJoined(Map<String, dynamic> payload) {
    final call = state.call;
    if (call == null || call.callId != payload['callId']) return;
    final p = payload['participant'] as Map<String, dynamic>;
    final userId = p['userId'] as String;
    final deviceId = p['deviceId'] as String;
    _upsertTile(
      userId,
      deviceId,
      'pending',
      displayName: p['displayName'] as String,
    );

    () async {
      final iceServers = await _callsApi.turnCredentials();
      final pc = await _getOrCreatePeerConnection(
        userId,
        deviceId,
        iceServers,
        call.conversationId,
        call.callId,
      );
      final offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      _realtime.send({
        'type': 'group-call.offer',
        'conversationId': call.conversationId,
        'callId': call.callId,
        'targetUserId': userId,
        'targetDeviceId': deviceId,
        'sdp': {'type': 'offer', 'sdp': offer.sdp},
      });
    }();
  }

  void _onOffer(Map<String, dynamic> payload) {
    final call = state.call;
    if (call == null || call.callId != payload['callId']) return;
    final fromUserId = payload['fromUserId'] as String;
    final fromDeviceId = payload['fromDeviceId'] as String;
    final key = _key(fromUserId, fromDeviceId);
    // No displayName — this tile should already exist (from roster/joined
    // above), and if it somehow doesn't, _upsertTile's own fallback
    // ('Participant') beats showing a raw UUID.
    _upsertTile(fromUserId, fromDeviceId, 'pending');

    () async {
      final sdp = payload['sdp'] as Map<String, dynamic>;
      final iceServers = await _callsApi.turnCredentials();
      final pc = await _getOrCreatePeerConnection(
        fromUserId,
        fromDeviceId,
        iceServers,
        call.conversationId,
        call.callId,
      );
      await pc.setRemoteDescription(
        RTCSessionDescription(sdp['sdp'] as String?, sdp['type'] as String?),
      );
      _remoteDescSet[key] = true;
      for (final c in _pendingCandidates[key] ?? const <RTCIceCandidate>[]) {
        try {
          await pc.addCandidate(c);
        } catch (_) {
          // One stale/malformed buffered candidate isn't fatal.
        }
      }
      _pendingCandidates.remove(key);

      final answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      _realtime.send({
        'type': 'group-call.answer',
        'conversationId': call.conversationId,
        'callId': call.callId,
        'targetUserId': fromUserId,
        'targetDeviceId': fromDeviceId,
        'sdp': {'type': 'answer', 'sdp': answer.sdp},
      });
    }();
  }

  void _onAnswer(Map<String, dynamic> payload) {
    final call = state.call;
    if (call == null || call.callId != payload['callId']) return;
    final fromUserId = payload['fromUserId'] as String;
    final fromDeviceId = payload['fromDeviceId'] as String;
    final key = _key(fromUserId, fromDeviceId);
    final pc = _peerConnections[key];
    if (pc == null) return;
    final sdp = payload['sdp'] as Map<String, dynamic>;
    () async {
      await pc.setRemoteDescription(
        RTCSessionDescription(sdp['sdp'] as String?, sdp['type'] as String?),
      );
      _remoteDescSet[key] = true;
      for (final c in _pendingCandidates[key] ?? const <RTCIceCandidate>[]) {
        try {
          await pc.addCandidate(c);
        } catch (_) {}
      }
      _pendingCandidates.remove(key);
    }();
  }

  void _onIceCandidate(Map<String, dynamic> payload) {
    final call = state.call;
    if (call == null || call.callId != payload['callId']) return;
    final fromUserId = payload['fromUserId'] as String;
    final fromDeviceId = payload['fromDeviceId'] as String;
    final key = _key(fromUserId, fromDeviceId);
    final c = payload['candidate'] as Map<String, dynamic>;
    final candidate = RTCIceCandidate(
      c['candidate'] as String?,
      c['sdpMid'] as String?,
      c['sdpMLineIndex'] as int?,
    );
    final pc = _peerConnections[key];
    if (pc != null && (_remoteDescSet[key] ?? false)) {
      pc.addCandidate(candidate).catchError((_) {});
    } else {
      (_pendingCandidates[key] ??= []).add(candidate);
    }
  }

  void _onParticipantLeft(Map<String, dynamic> payload) {
    final call = state.call;
    if (call == null || call.callId != payload['callId']) return;
    final userId = payload['userId'] as String;
    final deviceId = payload['deviceId'] as String;
    _closePeer(_key(userId, deviceId));
    _removeTile(userId, deviceId);
  }

  void _onEnded(Map<String, dynamic> payload) {
    if (state.call?.callId != payload['callId']) return;
    _teardownAll('Call ended');
  }
}

final groupCallControllerProvider =
    StateNotifierProvider<GroupCallController, GroupCallUiState>((ref) {
      final controller = GroupCallController(
        ref.watch(callsApiProvider),
        ref.watch(realtimeClientProvider),
      );
      ref.onDispose(controller.dispose);
      return controller;
    });
