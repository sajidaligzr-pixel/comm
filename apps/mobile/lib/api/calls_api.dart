library;

import 'api_client.dart';

class IceServer {
  final dynamic urls; // String or List<String>
  final String? username;
  final String? credential;
  const IceServer({required this.urls, this.username, this.credential});

  static IceServer fromJson(Map<String, dynamic> json) => IceServer(
    urls: json['urls'],
    username: json['username'] as String?,
    credential: json['credential'] as String?,
  );

  Map<String, dynamic> toJson() => {
    'urls': urls,
    if (username != null) 'username': username,
    if (credential != null) 'credential': credential,
  };
}

/// The durable counterpart to a live `call.ring` WS event — see
/// `GET /api/calls/pending` (apps/web) and its own docstring for exactly why this
/// has to exist (a device that was closed/backgrounded when a call came in has no
/// way to receive that event a second time over WS). Same field shape as the WS
/// payload `call_controller.dart`'s `_onRing` already handles, deliberately — see
/// `toRingPayload`.
class PendingCall {
  final String conversationId;
  final String callId;
  final String fromUserId;
  final String fromDisplayName;
  final Map<String, dynamic> sdp;

  const PendingCall({
    required this.conversationId,
    required this.callId,
    required this.fromUserId,
    required this.fromDisplayName,
    required this.sdp,
  });

  static PendingCall fromJson(Map<String, dynamic> json) => PendingCall(
    conversationId: json['conversationId'] as String,
    callId: json['callId'] as String,
    fromUserId: json['fromUserId'] as String,
    fromDisplayName: json['fromDisplayName'] as String,
    sdp: json['sdp'] as Map<String, dynamic>,
  );

  /// Reshapes this into exactly what a live `call.ring` WS payload looks like, so
  /// `CallController.checkPendingCall` can feed it straight into the same `_onRing`
  /// handler a live event uses rather than duplicating that logic.
  Map<String, dynamic> toRingPayload() => {
    'conversationId': conversationId,
    'callId': callId,
    'fromUserId': fromUserId,
    'fromDisplayName': fromDisplayName,
    'sdp': sdp,
  };
}

/// One row of `GET /api/calls/history` (the "Calls" tab) — mirrors
/// `CallHistoryEntry` (packages/types/src/calls.ts) exactly; see
/// server/modules/calls/history.ts's docstring for how `direction`/`otherUser` are
/// derived server-side.
class CallHistoryEntry {
  final String id;
  final String conversationId;
  final String? otherUserId;
  final String? otherUsername;
  final String? otherDisplayName;
  // Set instead of the three `other*` fields above for a group call — exactly one
  // of `groupName`/`otherUserId` is ever non-null, mirroring
  // `CallHistoryEntry.groupName` (packages/types/src/calls.ts) exactly. Previously
  // unparsed here entirely, which mislabeled every group-call row as "Unknown".
  final String? groupName;
  final String direction; // 'incoming' | 'outgoing'
  final String status; // 'answered' | 'missed' | 'declined'
  final String? startedAt;
  final String? endedAt;
  final String createdAt;

  const CallHistoryEntry({
    required this.id,
    required this.conversationId,
    required this.otherUserId,
    required this.otherUsername,
    required this.otherDisplayName,
    required this.groupName,
    required this.direction,
    required this.status,
    required this.startedAt,
    required this.endedAt,
    required this.createdAt,
  });

  static CallHistoryEntry fromJson(Map<String, dynamic> json) {
    final other = json['otherUser'] as Map<String, dynamic>?;
    return CallHistoryEntry(
      id: json['id'] as String,
      conversationId: json['conversationId'] as String,
      otherUserId: other?['id'] as String?,
      otherUsername: other?['username'] as String?,
      otherDisplayName: other?['displayName'] as String?,
      groupName: json['groupName'] as String?,
      direction: json['direction'] as String,
      status: json['status'] as String,
      startedAt: json['startedAt'] as String?,
      endedAt: json['endedAt'] as String?,
      createdAt: json['createdAt'] as String,
    );
  }

  bool get isGroup => groupName != null;

  String displayName() => groupName ?? otherDisplayName ?? otherUsername ?? 'Unknown';

  /// Null when the call was never answered (`missed`/`declined` — nothing to
  /// measure) or, defensively, if either timestamp is somehow missing/malformed
  /// despite `status == answered`.
  Duration? callDuration() {
    if (status != 'answered' || startedAt == null || endedAt == null) {
      return null;
    }
    final start = DateTime.tryParse(startedAt!);
    final end = DateTime.tryParse(endedAt!);
    if (start == null || end == null) return null;
    final diff = end.difference(start);
    return diff.isNegative ? null : diff;
  }
}

class CallsApi {
  const CallsApi(this._client);
  final ApiClient _client;

  /// Newest first, capped server-side (default 50) — see history.ts's own
  /// docstring. No try/catch fallback here (unlike `turnCredentials`/`pending`
  /// above): a failed fetch on a screen whose entire purpose is showing this list
  /// should surface as a real error state, not silently render an empty list that
  /// looks like "no calls yet."
  Future<List<CallHistoryEntry>> history({int limit = 50}) {
    return _client.request(
      '/api/calls/history',
      method: 'GET',
      query: {'limit': '$limit'},
      parse: (data) => ((data as Map<String, dynamic>)['calls'] as List)
          .map((e) => CallHistoryEntry.fromJson(e as Map<String, dynamic>))
          .toList(),
    );
  }

  /// Empty list is a valid, expected response — it means no coturn deployment is
  /// configured and ICE will only gather host/reflexive candidates (fine on the same
  /// network, not guaranteed across arbitrary real-world NATs). Falls back to an
  /// empty list on any error too, same as the web client — a call attempt shouldn't
  /// hard-fail just because this best-effort fetch did.
  Future<List<IceServer>> turnCredentials() async {
    try {
      return await _client.request(
        '/api/calls/turn-credentials',
        method: 'POST',
        parse: (data) => ((data as Map<String, dynamic>)['iceServers'] as List)
            .map((e) => IceServer.fromJson(e as Map<String, dynamic>))
            .toList(),
      );
    } on ApiException {
      return const [];
    }
  }

  /// REST counterpart to the in-app Decline button's WS `call.reject` send — used
  /// specifically by the native incoming-call UI's "Decline" action
  /// (features/calls/call_kit.dart's `_declineFromEvent`), which can fire with no
  /// live socket (or even a running CallController) to send a WS frame over at all.
  /// Not used by the normal in-app decline path (call_controller.dart), which still
  /// sends over WS as before.
  Future<void> decline(String conversationId, String callId, String reason) =>
      _client.requestVoid(
        '/api/calls/decline',
        body: {
          'conversationId': conversationId,
          'callId': callId,
          'reason': reason,
        },
      );

  /// `null` is the normal case (no missed call waiting) — see PendingCallResponse's
  /// docstring (packages/types/src/calls.ts). Falls back to `null` on any error too,
  /// same reasoning as `turnCredentials` above: this is a best-effort catch-up check
  /// run on every reconnect, not something that should ever surface as a visible
  /// failure to the user.
  Future<PendingCall?> pending() async {
    try {
      return await _client.request(
        '/api/calls/pending',
        method: 'GET',
        parse: (data) => data == null
            ? null
            : PendingCall.fromJson(data as Map<String, dynamic>),
      );
    } on ApiException {
      return null;
    }
  }
}
