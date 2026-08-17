library;

enum CallPhase { idle, outgoing, incoming, connected, ended }

class ActiveCall {
  final String callId;
  final String conversationId;
  final String otherUserId;
  final String otherDisplayName;
  final bool isOutgoing;
  const ActiveCall({
    required this.callId,
    required this.conversationId,
    required this.otherUserId,
    required this.otherDisplayName,
    required this.isOutgoing,
  });
}

class CallUiState {
  final CallPhase phase;
  final ActiveCall? call;
  final bool muted;
  final bool speakerOn;
  final int durationSec;
  final String statusText;
  final String? micError;

  const CallUiState({
    this.phase = CallPhase.idle,
    this.call,
    this.muted = false,
    this.speakerOn = false,
    this.durationSec = 0,
    this.statusText = '',
    this.micError,
  });

  CallUiState copyWith({
    CallPhase? phase,
    ActiveCall? call,
    bool clearCall = false,
    bool? muted,
    bool? speakerOn,
    int? durationSec,
    String? statusText,
    String? micError,
    bool clearMicError = false,
  }) {
    return CallUiState(
      phase: phase ?? this.phase,
      call: clearCall ? null : (call ?? this.call),
      muted: muted ?? this.muted,
      speakerOn: speakerOn ?? this.speakerOn,
      durationSec: durationSec ?? this.durationSec,
      statusText: statusText ?? this.statusText,
      micError: clearMicError ? null : (micError ?? this.micError),
    );
  }
}
