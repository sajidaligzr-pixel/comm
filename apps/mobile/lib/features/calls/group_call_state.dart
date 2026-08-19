library;

enum GroupCallPhase { idle, active, ended }

class ActiveGroupCall {
  final String callId;
  final String conversationId;
  final String groupName;
  const ActiveGroupCall({
    required this.callId,
    required this.conversationId,
    required this.groupName,
  });
}

class GroupCallInvite {
  final String callId;
  final String conversationId;
  final String fromUserId;
  final String fromDisplayName;
  final String groupName;
  const GroupCallInvite({
    required this.callId,
    required this.conversationId,
    required this.fromUserId,
    required this.fromDisplayName,
    required this.groupName,
  });
}

/// A tile in the active-call grid. `connectionState` mirrors flutter_webrtc's
/// `RTCPeerConnectionState` enum values as plain strings (rather than importing
/// that type here) plus one extra: `'pending'` — known (from the roster snapshot
/// or a participant-joined event) but no peer connection has reached a real
/// state yet.
class GroupCallParticipantTile {
  final String userId;
  final String deviceId;
  final String displayName;
  final String connectionState;
  const GroupCallParticipantTile({
    required this.userId,
    required this.deviceId,
    required this.displayName,
    required this.connectionState,
  });

  GroupCallParticipantTile copyWith({
    String? displayName,
    String? connectionState,
  }) => GroupCallParticipantTile(
    userId: userId,
    deviceId: deviceId,
    displayName: displayName ?? this.displayName,
    connectionState: connectionState ?? this.connectionState,
  );
}

class GroupCallUiState {
  final GroupCallPhase phase;
  final ActiveGroupCall? call;
  final GroupCallInvite? invite;
  final List<GroupCallParticipantTile> participants;
  final bool muted;
  final int durationSec;
  final String statusText;
  final String? micError;

  const GroupCallUiState({
    this.phase = GroupCallPhase.idle,
    this.call,
    this.invite,
    this.participants = const [],
    this.muted = false,
    this.durationSec = 0,
    this.statusText = '',
    this.micError,
  });

  GroupCallUiState copyWith({
    GroupCallPhase? phase,
    ActiveGroupCall? call,
    bool clearCall = false,
    GroupCallInvite? invite,
    bool clearInvite = false,
    List<GroupCallParticipantTile>? participants,
    bool? muted,
    int? durationSec,
    String? statusText,
    String? micError,
    bool clearMicError = false,
  }) {
    return GroupCallUiState(
      phase: phase ?? this.phase,
      call: clearCall ? null : (call ?? this.call),
      invite: clearInvite ? null : (invite ?? this.invite),
      participants: participants ?? this.participants,
      muted: muted ?? this.muted,
      durationSec: durationSec ?? this.durationSec,
      statusText: statusText ?? this.statusText,
      micError: clearMicError ? null : (micError ?? this.micError),
    );
  }
}
