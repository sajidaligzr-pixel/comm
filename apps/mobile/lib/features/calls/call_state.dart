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
  // Presentation-only, like everything else here — CallOverlay's full-screen
  // dark UI vs. a small floating "return to call" pill over whatever screen
  // is actually underneath (chat list, a thread — any of them, matching
  // WhatsApp's own minimized-call bar). Never touches the actual call/media
  // state: `CallController`'s WebRTC connection, mute/speaker state, and
  // duration timer all keep running identically either way — this only
  // changes how much of the screen CallOverlay covers. Always reset to false
  // on a new call (see `_onRing`/`startCall`) so a fresh incoming/outgoing
  // call never silently inherits a previous call's minimized state.
  final bool minimized;

  const CallUiState({
    this.phase = CallPhase.idle,
    this.call,
    this.muted = false,
    this.speakerOn = false,
    this.durationSec = 0,
    this.statusText = '',
    this.micError,
    this.minimized = false,
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
    bool? minimized,
  }) {
    return CallUiState(
      phase: phase ?? this.phase,
      call: clearCall ? null : (call ?? this.call),
      muted: muted ?? this.muted,
      speakerOn: speakerOn ?? this.speakerOn,
      durationSec: durationSec ?? this.durationSec,
      statusText: statusText ?? this.statusText,
      micError: clearMicError ? null : (micError ?? this.micError),
      minimized: minimized ?? this.minimized,
    );
  }
}
