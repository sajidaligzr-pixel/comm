/// The Double Ratchet Algorithm, ported from `packages/crypto/src/ratchet/double-ratchet.ts`
/// line-by-line — function names deliberately mirror Signal's published spec
/// (https://signal.org/docs/specifications/doubleratchet/) pseudocode (KDF_RK,
/// KDF_CK, DHRatchet, SkipMessageKeys, RatchetEncrypt, RatchetDecrypt), same as the
/// TypeScript original, so the two can be reviewed side-by-side. See
/// `primitives.dart`'s docstring for the cross-validation story that backs this file.
library;

import 'dart:typed_data';
import '../encoding.dart';
import '../primitives.dart';

const String _rootKdfInfo = 'Comm_DR_RootKey_v1';
const String _msgKdfInfo = 'Comm_DR_MsgKey_v1';
const int _aeadKeyLen = 32;
const int _aeadNonceLen = 12;

/// Same DoS-guard reasoning as the TS original: bounds how many message keys a
/// receiving chain will derive-and-store while catching up on out-of-order/lost
/// messages, so a malicious/corrupted header claiming a huge message number can't
/// force unbounded memory allocation.
const int maxSkippedMessageKeys = 1000;

class RatchetHeader {
  final Uint8List dhPublicKey; // sender's current ratchet public key (32 bytes, X25519)
  final int previousChainLength; // PN
  final int messageNumber; // N
  const RatchetHeader({required this.dhPublicKey, required this.previousChainLength, required this.messageNumber});
}

class RatchetState {
  KeyPairBytes dhSelf; // DHs
  Uint8List? dhRemote; // DHr
  Uint8List rootKey; // RK
  Uint8List? chainKeySend; // CKs
  Uint8List? chainKeyRecv; // CKr
  int sendCount; // Ns
  int recvCount; // Nr
  int previousSendCount; // PN
  /// key: `${base64(DHr)}:${N}` → message key, deleted on use — a stored skipped key
  /// is single-use just like any other ratchet message key.
  final Map<String, Uint8List> skippedMessageKeys;

  RatchetState({
    required this.dhSelf,
    required this.dhRemote,
    required this.rootKey,
    required this.chainKeySend,
    required this.chainKeyRecv,
    required this.sendCount,
    required this.recvCount,
    required this.previousSendCount,
    required this.skippedMessageKeys,
  });
}

class _RootKdfResult {
  final Uint8List rootKey;
  final Uint8List chainKey;
  const _RootKdfResult(this.rootKey, this.chainKey);
}

Future<_RootKdfResult> _kdfRootKey(Uint8List rootKey, Uint8List dhOutput) async {
  final okm = await hkdfSha256(dhOutput, rootKey, _rootKdfInfo, 64);
  return _RootKdfResult(okm.sublist(0, 32), okm.sublist(32, 64));
}

class _ChainKdfResult {
  final Uint8List chainKey;
  final Uint8List messageKey;
  const _ChainKdfResult(this.chainKey, this.messageKey);
}

Future<_ChainKdfResult> _kdfChainKey(Uint8List chainKey) async {
  // Single-byte constants distinguishing the two HMAC outputs — standard practice
  // for a symmetric-key ratchet (spec §3.2), not a secret in itself.
  final messageKey = await hmacSha256(chainKey, Uint8List.fromList([0x01]));
  final nextChainKey = await hmacSha256(chainKey, Uint8List.fromList([0x02]));
  return _ChainKdfResult(nextChainKey, messageKey);
}

class _AeadMaterial {
  final Uint8List key;
  final Uint8List nonce;
  const _AeadMaterial(this.key, this.nonce);
}

/// Expands a 32-byte ratchet message key into an actual AEAD key + nonce — never
/// uses `mk` directly as the cipher key, so the "message key" and "AEAD key"
/// namespaces can never collide even in principle.
Future<_AeadMaterial> _deriveAeadMaterial(Uint8List messageKey) async {
  final okm = await hkdfSha256(messageKey, Uint8List(32), _msgKdfInfo, _aeadKeyLen + _aeadNonceLen);
  return _AeadMaterial(okm.sublist(0, _aeadKeyLen), okm.sublist(_aeadKeyLen));
}

String _skippedKeyId(Uint8List dhRemote, int n) => '${bytesToBase64(dhRemote)}:$n';

/// RatchetInitAlice — the session initiator's side. `sharedKey` is X3DH's `SK`;
/// `theirRatchetPublicKey` is the recipient's signed pre-key public.
Future<RatchetState> initRatchetAsSender(Uint8List sharedKey, Uint8List theirRatchetPublicKey) async {
  final dhSelf = await generateX25519KeyPair();
  final dhOutput = await dh(dhSelf.privateKey, theirRatchetPublicKey);
  final derived = await _kdfRootKey(sharedKey, dhOutput);

  return RatchetState(
    dhSelf: dhSelf,
    dhRemote: theirRatchetPublicKey,
    rootKey: derived.rootKey,
    chainKeySend: derived.chainKey,
    chainKeyRecv: null,
    sendCount: 0,
    recvCount: 0,
    previousSendCount: 0,
    skippedMessageKeys: {},
  );
}

/// RatchetInitBob — the session recipient's side. `ourRatchetKeyPair` is our own
/// signed pre-key pair, reused as the initial ratchet key pair.
RatchetState initRatchetAsReceiver(Uint8List sharedKey, KeyPairBytes ourRatchetKeyPair) {
  return RatchetState(
    dhSelf: ourRatchetKeyPair,
    dhRemote: null,
    rootKey: sharedKey,
    chainKeySend: null,
    chainKeyRecv: null,
    sendCount: 0,
    recvCount: 0,
    previousSendCount: 0,
    skippedMessageKeys: {},
  );
}

Future<void> _dhRatchetStep(RatchetState state, Uint8List theirNewRatchetPublicKey) async {
  state.previousSendCount = state.sendCount;
  state.sendCount = 0;
  state.recvCount = 0;
  state.dhRemote = theirNewRatchetPublicKey;

  final recv = await _kdfRootKey(state.rootKey, await dh(state.dhSelf.privateKey, state.dhRemote!));
  state.rootKey = recv.rootKey;
  state.chainKeyRecv = recv.chainKey;

  state.dhSelf = await generateX25519KeyPair();
  final send = await _kdfRootKey(state.rootKey, await dh(state.dhSelf.privateKey, state.dhRemote!));
  state.rootKey = send.rootKey;
  state.chainKeySend = send.chainKey;
}

Future<void> _skipMessageKeys(RatchetState state, int until) async {
  if (state.chainKeyRecv == null) return;
  if (until - state.recvCount > maxSkippedMessageKeys) {
    throw StateError('Too many skipped messages in one receiving chain — refusing (DoS guard).');
  }
  while (state.recvCount < until) {
    final result = await _kdfChainKey(state.chainKeyRecv!);
    state.chainKeyRecv = result.chainKey;
    state.skippedMessageKeys[_skippedKeyId(state.dhRemote!, state.recvCount)] = result.messageKey;
    state.recvCount += 1;
  }
}

Uint8List encodeHeader(RatchetHeader header) {
  final lengths = ByteData(8);
  lengths.setUint32(0, header.previousChainLength, Endian.big);
  lengths.setUint32(4, header.messageNumber, Endian.big);
  return concatBytes([header.dhPublicKey, lengths.buffer.asUint8List()]);
}

RatchetHeader decodeHeader(Uint8List bytes) {
  if (bytes.length != 40) throw const FormatException('Malformed ratchet header.');
  final dhPublicKey = bytes.sublist(0, 32);
  final view = ByteData.sublistView(bytes, 32, 40);
  return RatchetHeader(
    dhPublicKey: dhPublicKey,
    previousChainLength: view.getUint32(0, Endian.big),
    messageNumber: view.getUint32(4, Endian.big),
  );
}

class RatchetEncryptResult {
  final RatchetHeader header;
  final Uint8List ciphertext;
  const RatchetEncryptResult({required this.header, required this.ciphertext});
}

/// RatchetEncrypt. `associatedData` is bound into the AEAD tag — see
/// `session/session.dart`, which passes each participant's identity keys so a
/// ciphertext can never be replayed into a different conversation and decrypt.
Future<RatchetEncryptResult> ratchetEncrypt(RatchetState state, Uint8List plaintext, Uint8List associatedData) async {
  if (state.chainKeySend == null) {
    throw StateError('Cannot encrypt: no sending chain established yet.');
  }
  final chainResult = await _kdfChainKey(state.chainKeySend!);
  state.chainKeySend = chainResult.chainKey;

  final header = RatchetHeader(
    dhPublicKey: state.dhSelf.publicKey,
    previousChainLength: state.previousSendCount,
    messageNumber: state.sendCount,
  );
  state.sendCount += 1;

  final material = await _deriveAeadMaterial(chainResult.messageKey);
  final aad = concatBytes([associatedData, encodeHeader(header)]);
  final ciphertext = await aeadEncrypt(material.key, material.nonce, plaintext, aad);

  return RatchetEncryptResult(header: header, ciphertext: ciphertext);
}

/// RatchetDecrypt. Throws (never returns garbage) on: unknown/consumed skipped key,
/// a DH ratchet step that fails, or AEAD tag mismatch (tamper detection).
Future<Uint8List> ratchetDecrypt(
  RatchetState state,
  RatchetHeader header,
  Uint8List ciphertext,
  Uint8List associatedData,
) async {
  final skippedId = _skippedKeyId(header.dhPublicKey, header.messageNumber);
  final skippedKey = state.skippedMessageKeys[skippedId];
  if (skippedKey != null) {
    state.skippedMessageKeys.remove(skippedId);
    final material = await _deriveAeadMaterial(skippedKey);
    final aad = concatBytes([associatedData, encodeHeader(header)]);
    return aeadDecrypt(material.key, material.nonce, ciphertext, aad);
  }

  final isNewRatchetKey =
      state.dhRemote == null || bytesToBase64(header.dhPublicKey) != bytesToBase64(state.dhRemote!);
  if (isNewRatchetKey) {
    await _skipMessageKeys(state, header.previousChainLength);
    await _dhRatchetStep(state, header.dhPublicKey);
  }

  await _skipMessageKeys(state, header.messageNumber);

  if (state.chainKeyRecv == null) {
    throw StateError('Cannot decrypt: no receiving chain established.');
  }
  final chainResult = await _kdfChainKey(state.chainKeyRecv!);
  state.chainKeyRecv = chainResult.chainKey;
  state.recvCount += 1;

  final material = await _deriveAeadMaterial(chainResult.messageKey);
  final aad = concatBytes([associatedData, encodeHeader(header)]);
  // If this throws (tampered ciphertext / wrong key), the ratchet has already
  // advanced past this message — by design, matching the spec: a Double Ratchet
  // does not roll back state on a failed decrypt. For this system's
  // message-per-envelope model, a failed decrypt simply means that message is
  // undeliverable.
  return aeadDecrypt(material.key, material.nonce, ciphertext, aad);
}
