/// JSON-safe mirrors of the group session types — direct port of
/// `packages/crypto/src/group/serialization.ts`. Same purpose as
/// `session/serialization.dart` for the 1:1 case: exactly one place that knows how
/// to persist/reconstitute group ratchet state.
library;

import '../encoding.dart';
import 'ratchet.dart';

class SerializedGroupOutboundSession {
  final String sessionId;
  final String chainKey;
  final int counter;
  const SerializedGroupOutboundSession({required this.sessionId, required this.chainKey, required this.counter});

  Map<String, dynamic> toJson() => {'sessionId': sessionId, 'chainKey': chainKey, 'counter': counter};

  static SerializedGroupOutboundSession fromJson(Map<String, dynamic> json) => SerializedGroupOutboundSession(
    sessionId: json['sessionId'] as String,
    chainKey: json['chainKey'] as String,
    counter: json['counter'] as int,
  );
}

SerializedGroupOutboundSession serializeGroupOutboundSession(GroupOutboundSession session) {
  return SerializedGroupOutboundSession(
    sessionId: bytesToBase64(session.sessionId),
    chainKey: bytesToBase64(session.chainKey),
    counter: session.counter,
  );
}

GroupOutboundSession deserializeGroupOutboundSession(SerializedGroupOutboundSession s) {
  return GroupOutboundSession(sessionId: base64ToBytes(s.sessionId), chainKey: base64ToBytes(s.chainKey), counter: s.counter);
}

class SerializedGroupInboundSession {
  final String sessionId;
  final String chainKey;
  final int counter;
  final List<List<Object>> skippedMessageKeys; // [ [counter:int, base64:String], ... ]
  const SerializedGroupInboundSession({
    required this.sessionId,
    required this.chainKey,
    required this.counter,
    required this.skippedMessageKeys,
  });

  Map<String, dynamic> toJson() => {
    'sessionId': sessionId,
    'chainKey': chainKey,
    'counter': counter,
    'skippedMessageKeys': skippedMessageKeys,
  };

  static SerializedGroupInboundSession fromJson(Map<String, dynamic> json) => SerializedGroupInboundSession(
    sessionId: json['sessionId'] as String,
    chainKey: json['chainKey'] as String,
    counter: json['counter'] as int,
    skippedMessageKeys: (json['skippedMessageKeys'] as List)
        .map((e) => [(e as List)[0] as int, e[1] as String])
        .toList(),
  );
}

SerializedGroupInboundSession serializeGroupInboundSession(GroupInboundSession session) {
  return SerializedGroupInboundSession(
    sessionId: bytesToBase64(session.sessionId),
    chainKey: bytesToBase64(session.chainKey),
    counter: session.counter,
    skippedMessageKeys: session.skippedMessageKeys.entries.map((e) => [e.key, bytesToBase64(e.value)]).toList(),
  );
}

GroupInboundSession deserializeGroupInboundSession(SerializedGroupInboundSession s) {
  return GroupInboundSession(
    sessionId: base64ToBytes(s.sessionId),
    chainKey: base64ToBytes(s.chainKey),
    counter: s.counter,
    skippedMessageKeys: {for (final pair in s.skippedMessageKeys) (pair[0] as int): base64ToBytes(pair[1] as String)},
  );
}
