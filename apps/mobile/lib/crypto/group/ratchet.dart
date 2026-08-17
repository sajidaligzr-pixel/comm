/// A Megolm-style group ratchet, ported from `packages/crypto/src/group/ratchet.ts` —
/// a one-way symmetric chain-key ratchet, one per sender per session, distinct from
/// (and much simpler than) the Double Ratchet in ratchet/double_ratchet.dart: no DH
/// ratchet step, because group key *distribution* (not per-message forward secrecy
/// against the whole group) is what handles membership changes. Same primitives, same
/// AEAD (ChaCha20-Poly1305) — "one audited cipher to review" applies here too.
library;

import 'dart:typed_data';
import '../encoding.dart';
import '../primitives.dart';

const String _chainKdfInfo = 'Comm_GR_MsgKey_v1'; // mirrors double_ratchet.dart's msgKdfInfo naming
const int _aeadKeyLen = 32;
const int _aeadNonceLen = 12;
const int _sessionIdLen = 16;
const int _chainKeyLen = 32;

/// Same DoS-guard reasoning as `maxSkippedMessageKeys` in double_ratchet.dart.
const int maxSkippedGroupMessageKeys = 1000;

class GroupOutboundSession {
  final Uint8List sessionId; // 16 random bytes, minted once per (re)creation
  Uint8List chainKey;
  int counter;
  GroupOutboundSession({required this.sessionId, required this.chainKey, required this.counter});
}

class GroupInboundSession {
  final Uint8List sessionId;
  /// The chain key AT `counter` — i.e. not yet consumed for that counter.
  Uint8List chainKey;
  int counter;
  /// key: counter → message key. Same "delete on use, bounded size" contract as
  /// double_ratchet.dart's `skippedMessageKeys`.
  final Map<int, Uint8List> skippedMessageKeys;
  GroupInboundSession({required this.sessionId, required this.chainKey, required this.counter, required this.skippedMessageKeys});
}

class GroupMessageHeader {
  final Uint8List sessionId;
  final int counter;
  const GroupMessageHeader({required this.sessionId, required this.counter});
}

class _ChainKdfResult {
  final Uint8List chainKey;
  final Uint8List messageKey;
  const _ChainKdfResult(this.chainKey, this.messageKey);
}

Future<_ChainKdfResult> _kdfChainKey(Uint8List chainKey) async {
  // Identical two-HMAC-output construction to double_ratchet.dart's own kdfChainKey —
  // deliberately the same reviewed technique, not a second one to audit.
  final messageKey = await hmacSha256(chainKey, Uint8List.fromList([0x01]));
  final nextChainKey = await hmacSha256(chainKey, Uint8List.fromList([0x02]));
  return _ChainKdfResult(nextChainKey, messageKey);
}

class _AeadMaterial {
  final Uint8List key;
  final Uint8List nonce;
  const _AeadMaterial(this.key, this.nonce);
}

Future<_AeadMaterial> _deriveAeadMaterial(Uint8List messageKey) async {
  final okm = await hkdfSha256(messageKey, Uint8List(32), _chainKdfInfo, _aeadKeyLen + _aeadNonceLen);
  return _AeadMaterial(okm.sublist(0, _aeadKeyLen), okm.sublist(_aeadKeyLen));
}

GroupOutboundSession createOutboundGroupSession() {
  return GroupOutboundSession(sessionId: randomBytes(_sessionIdLen), chainKey: randomBytes(_chainKeyLen), counter: 0);
}

/// `chainKeyAtCounter` is whatever chain-key value the sender's outbound session held
/// at `counter` when it was shared — this inbound session can derive every message
/// key from `counter` onward, but never backward (no retroactive history access for
/// a newly-added member, by design).
GroupInboundSession createInboundGroupSession(Uint8List sessionId, Uint8List chainKeyAtCounter, int counter) {
  return GroupInboundSession(sessionId: sessionId, chainKey: chainKeyAtCounter, counter: counter, skippedMessageKeys: {});
}

Uint8List encodeGroupHeader(GroupMessageHeader header) {
  final counterBytes = ByteData(4);
  counterBytes.setUint32(0, header.counter, Endian.big);
  return concatBytes([header.sessionId, counterBytes.buffer.asUint8List()]);
}

GroupMessageHeader decodeGroupHeader(Uint8List bytes) {
  if (bytes.length != _sessionIdLen + 4) throw const FormatException('Malformed group ratchet header.');
  final sessionId = bytes.sublist(0, _sessionIdLen);
  final view = ByteData.sublistView(bytes, _sessionIdLen, _sessionIdLen + 4);
  return GroupMessageHeader(sessionId: sessionId, counter: view.getUint32(0, Endian.big));
}

class GroupEncryptResult {
  final GroupMessageHeader header;
  final Uint8List ciphertext;
  const GroupEncryptResult({required this.header, required this.ciphertext});
}

/// Advances the ratchet by exactly one step — never reversible, which is the whole
/// forward-secrecy property this session type provides (a later compromise of
/// `session.chainKey` cannot recover any message this sender already sent).
Future<GroupEncryptResult> encryptGroupMessage(
  GroupOutboundSession session,
  Uint8List plaintext,
  Uint8List associatedData,
) async {
  final result = await _kdfChainKey(session.chainKey);
  final header = GroupMessageHeader(sessionId: session.sessionId, counter: session.counter);
  session.chainKey = result.chainKey;
  session.counter += 1;

  final material = await _deriveAeadMaterial(result.messageKey);
  final aad = concatBytes([associatedData, encodeGroupHeader(header)]);
  final ciphertext = await aeadEncrypt(material.key, material.nonce, plaintext, aad);
  return GroupEncryptResult(header: header, ciphertext: ciphertext);
}

Future<void> _skipGroupMessageKeys(GroupInboundSession session, int until) async {
  if (until - session.counter > maxSkippedGroupMessageKeys) {
    throw StateError('Too many skipped group messages in one session — refusing (DoS guard).');
  }
  while (session.counter < until) {
    final result = await _kdfChainKey(session.chainKey);
    session.chainKey = result.chainKey;
    session.skippedMessageKeys[session.counter] = result.messageKey;
    session.counter += 1;
  }
}

/// Throws (never returns garbage) on: a header for a different session, a counter
/// this session has already advanced past with no cached skip-key for it (either a
/// duplicate delivery or genuinely unrecoverable), the DoS-guard bound, or an AEAD
/// tag mismatch (tamper detection) — matching double_ratchet.dart's `ratchetDecrypt`
/// contract exactly.
Future<Uint8List> decryptGroupMessage(
  GroupInboundSession session,
  GroupMessageHeader header,
  Uint8List ciphertext,
  Uint8List associatedData,
) async {
  if (bytesToBase64(header.sessionId) != bytesToBase64(session.sessionId)) {
    throw StateError('Message belongs to a different group session.');
  }

  final cached = session.skippedMessageKeys[header.counter];
  if (cached != null) {
    session.skippedMessageKeys.remove(header.counter);
    final material = await _deriveAeadMaterial(cached);
    final aad = concatBytes([associatedData, encodeGroupHeader(header)]);
    return aeadDecrypt(material.key, material.nonce, ciphertext, aad);
  }

  if (header.counter < session.counter) {
    throw StateError('Cannot decrypt: this message key is no longer available.');
  }

  await _skipGroupMessageKeys(session, header.counter); // session.counter === header.counter now

  final result = await _kdfChainKey(session.chainKey);
  session.chainKey = result.chainKey;
  session.counter += 1;

  final material = await _deriveAeadMaterial(result.messageKey);
  final aad = concatBytes([associatedData, encodeGroupHeader(header)]);
  return aeadDecrypt(material.key, material.nonce, ciphertext, aad);
}
