/// The high-level API the app's client code actually calls — direct port of
/// `packages/crypto/src/session/session.ts`. Combines X3DH session establishment
/// with the Double Ratchet into "create a session with this bundle" / "encrypt this
/// message" / "decrypt this envelope", and turns ratchet state into something
/// JSON-safe to persist between messages.
library;

import 'dart:typed_data';
import '../encoding.dart';
import '../identity/keys.dart';
import '../ratchet/double_ratchet.dart';
import '../x3dh/x3dh.dart';
import 'serialization.dart';

class Session {
  final RatchetState ratchetState;
  final Uint8List associatedData;
  const Session({required this.ratchetState, required this.associatedData});
}

/// JSON-safe form for local persistence (wrap/unwrap under the local KEK before
/// persisting — see crypto/storage/wrap.dart; this class doesn't do that itself).
class SerializedSession {
  final SerializedRatchetState ratchetState;
  final String associatedData; // base64
  const SerializedSession({required this.ratchetState, required this.associatedData});

  Map<String, dynamic> toJson() => {'ratchetState': ratchetState.toJson(), 'associatedData': associatedData};

  static SerializedSession fromJson(Map<String, dynamic> json) => SerializedSession(
    ratchetState: SerializedRatchetState.fromJson(json['ratchetState'] as Map<String, dynamic>),
    associatedData: json['associatedData'] as String,
  );
}

SerializedSession serializeSession(Session session) {
  return SerializedSession(
    ratchetState: serializeRatchetState(session.ratchetState),
    associatedData: bytesToBase64(session.associatedData),
  );
}

Session deserializeSession(SerializedSession serialized) {
  return Session(
    ratchetState: deserializeRatchetState(serialized.ratchetState),
    associatedData: base64ToBytes(serialized.associatedData),
  );
}

class OutboundSessionResult {
  final Session session;

  /// Carried alongside only the FIRST message sent on this session — the recipient
  /// needs it to derive the matching session via `createInboundSession`. Every
  /// subsequent message on the same session omits this.
  final X3dhInitialMessage x3dhInit;

  const OutboundSessionResult({required this.session, required this.x3dhInit});
}

/// Alice's side — call once per (our device, their device) pair, the first time we
/// ever message that device. `theirBundle` comes from
/// `GET /api/keys/bundle/:userId/:deviceId`.
Future<OutboundSessionResult> createOutboundSession(IdentityKeyPair ourIdentity, PublicKeyBundle theirBundle) async {
  final result = await initiateSession(ourIdentity, theirBundle);
  return OutboundSessionResult(
    session: Session(ratchetState: result.ratchetState, associatedData: result.associatedData),
    x3dhInit: result.initialMessage,
  );
}

/// Bob's side — call once, when a message carrying `x3dhInit` arrives for a session
/// we don't already have. `ourOneTimePreKey` must be looked up locally by the id in
/// `x3dhInit.usedOneTimePreKeyId` (or null) and deleted immediately after this call.
Future<Session> createInboundSession(
  IdentityKeyPair ourIdentity,
  SignedPreKey ourSignedPreKey,
  OneTimePreKey? ourOneTimePreKey,
  X3dhInitialMessage x3dhInit,
) async {
  final result = await receiveSession(
    ourIdentity,
    ourSignedPreKey,
    ourOneTimePreKey,
    x3dhInit.identityAgreementKey,
    x3dhInit.ephemeralKey,
  );
  return Session(ratchetState: result.ratchetState, associatedData: result.associatedData);
}

class MessageEnvelope {
  final String header; // base64(40-byte encoded ratchet header)
  final String ciphertext; // base64
  const MessageEnvelope({required this.header, required this.ciphertext});
}

/// Mutates `session.ratchetState` in place (advances the sending chain) — callers
/// MUST re-persist the session after this returns, or a later message will re-derive
/// from stale state and desync from the recipient.
Future<MessageEnvelope> encryptMessage(Session session, Uint8List plaintext) async {
  final result = await ratchetEncrypt(session.ratchetState, plaintext, session.associatedData);
  return MessageEnvelope(header: bytesToBase64(encodeHeader(result.header)), ciphertext: bytesToBase64(result.ciphertext));
}

/// Same persist-after-calling requirement as `encryptMessage` — decrypting also
/// advances ratchet state (and may perform a DH ratchet step). Throws on tamper or
/// an undecryptable message — never returns corrupted plaintext.
Future<Uint8List> decryptMessage(Session session, MessageEnvelope envelope) async {
  final header = decodeHeader(base64ToBytes(envelope.header));
  final ciphertext = base64ToBytes(envelope.ciphertext);
  return ratchetDecrypt(session.ratchetState, header, ciphertext, session.associatedData);
}
