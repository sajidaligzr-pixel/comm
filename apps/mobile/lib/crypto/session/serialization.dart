/// JSON-safe mirror of `RatchetState` — direct port of
/// `packages/crypto/src/session/serialization.ts`. This is what actually gets
/// wrapped (crypto/storage/wrap.dart) and persisted, and what's reconstituted back
/// into a live `RatchetState` on load.
library;

import '../encoding.dart';
import '../primitives.dart';
import '../ratchet/double_ratchet.dart';

class SerializedRatchetState {
  final String dhSelfPrivateKey;
  final String dhSelfPublicKey;
  final String? dhRemote;
  final String rootKey;
  final String? chainKeySend;
  final String? chainKeyRecv;
  final int sendCount;
  final int recvCount;
  final int previousSendCount;
  final List<List<String>> skippedMessageKeys; // [ [id, base64], ... ]

  const SerializedRatchetState({
    required this.dhSelfPrivateKey,
    required this.dhSelfPublicKey,
    required this.dhRemote,
    required this.rootKey,
    required this.chainKeySend,
    required this.chainKeyRecv,
    required this.sendCount,
    required this.recvCount,
    required this.previousSendCount,
    required this.skippedMessageKeys,
  });

  Map<String, dynamic> toJson() => {
    'dhSelfPrivateKey': dhSelfPrivateKey,
    'dhSelfPublicKey': dhSelfPublicKey,
    'dhRemote': dhRemote,
    'rootKey': rootKey,
    'chainKeySend': chainKeySend,
    'chainKeyRecv': chainKeyRecv,
    'sendCount': sendCount,
    'recvCount': recvCount,
    'previousSendCount': previousSendCount,
    'skippedMessageKeys': skippedMessageKeys,
  };

  static SerializedRatchetState fromJson(Map<String, dynamic> json) {
    return SerializedRatchetState(
      dhSelfPrivateKey: json['dhSelfPrivateKey'] as String,
      dhSelfPublicKey: json['dhSelfPublicKey'] as String,
      dhRemote: json['dhRemote'] as String?,
      rootKey: json['rootKey'] as String,
      chainKeySend: json['chainKeySend'] as String?,
      chainKeyRecv: json['chainKeyRecv'] as String?,
      sendCount: json['sendCount'] as int,
      recvCount: json['recvCount'] as int,
      previousSendCount: json['previousSendCount'] as int,
      skippedMessageKeys: (json['skippedMessageKeys'] as List)
          .map((e) => (e as List).map((v) => v as String).toList())
          .toList(),
    );
  }
}

SerializedRatchetState serializeRatchetState(RatchetState state) {
  return SerializedRatchetState(
    dhSelfPrivateKey: bytesToBase64(state.dhSelf.privateKey),
    dhSelfPublicKey: bytesToBase64(state.dhSelf.publicKey),
    dhRemote: state.dhRemote != null ? bytesToBase64(state.dhRemote!) : null,
    rootKey: bytesToBase64(state.rootKey),
    chainKeySend: state.chainKeySend != null ? bytesToBase64(state.chainKeySend!) : null,
    chainKeyRecv: state.chainKeyRecv != null ? bytesToBase64(state.chainKeyRecv!) : null,
    sendCount: state.sendCount,
    recvCount: state.recvCount,
    previousSendCount: state.previousSendCount,
    skippedMessageKeys: state.skippedMessageKeys.entries.map((e) => [e.key, bytesToBase64(e.value)]).toList(),
  );
}

RatchetState deserializeRatchetState(SerializedRatchetState s) {
  return RatchetState(
    dhSelf: KeyPairBytes(privateKey: base64ToBytes(s.dhSelfPrivateKey), publicKey: base64ToBytes(s.dhSelfPublicKey)),
    dhRemote: s.dhRemote != null ? base64ToBytes(s.dhRemote!) : null,
    rootKey: base64ToBytes(s.rootKey),
    chainKeySend: s.chainKeySend != null ? base64ToBytes(s.chainKeySend!) : null,
    chainKeyRecv: s.chainKeyRecv != null ? base64ToBytes(s.chainKeyRecv!) : null,
    sendCount: s.sendCount,
    recvCount: s.recvCount,
    previousSendCount: s.previousSendCount,
    skippedMessageKeys: {for (final pair in s.skippedMessageKeys) pair[0]: base64ToBytes(pair[1])},
  );
}
