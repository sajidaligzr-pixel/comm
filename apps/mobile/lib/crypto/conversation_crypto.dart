/// Orchestrates per-remote-device session establishment/reuse for the chat UI —
/// direct port of `apps/web/lib/crypto/conversation-crypto.ts`. "Encrypt this
/// outgoing message" / "decrypt this incoming one" without the caller needing to
/// know whether a Double Ratchet session already exists or a fresh X3DH handshake is
/// needed first.
library;

import 'dart:async';
import 'dart:typed_data';
import '../api/dtos.dart' as dto;
import '../api/keys_api.dart';
import 'encoding.dart';
import 'identity/keys.dart' show IdentityKeyPair;
import 'kek_holder.dart';
import 'local_identity.dart';
import 'session/session.dart' as session;
import 'sessions.dart';
import 'x3dh/x3dh.dart' show PublicKeyBundle, X3dhInitialMessage;

class _Unlocked {
  final IdentityKeyPair identity;
  final Uint8List kek;
  const _Unlocked(this.identity, this.kek);
}

_Unlocked _requireUnlocked() {
  final identity = getCurrentIdentity();
  final kek = getCurrentKek();
  if (identity == null || kek == null) {
    throw StateError('Local keys are locked — sign in again on this device.');
  }
  return _Unlocked(identity, kek);
}

Future<PublicKeyBundle> _fetchRemoteBundle(KeysApi keysApi, String userId, String deviceId) async {
  final res = await keysApi.fetchBundle(userId, deviceId);
  return PublicKeyBundle(
    identityAgreementKey: base64ToBytes(res.identityKey.agreementPublicKey),
    identitySigningKey: base64ToBytes(res.identityKey.signingPublicKey),
    signedPreKeyId: res.signedPreKeyId,
    signedPreKeyPublic: base64ToBytes(res.signedPreKeyPublic),
    signedPreKeySignature: base64ToBytes(res.signedPreKeySignature),
    oneTimePreKeyId: res.oneTimePreKeyId,
    oneTimePreKeyPublic: res.oneTimePreKeyPublic != null ? base64ToBytes(res.oneTimePreKeyPublic!) : null,
  );
}

class OutgoingCiphertext {
  final session.MessageEnvelope envelope;
  final dto.X3dhInitPayload? x3dhInit;
  const OutgoingCiphertext({required this.envelope, required this.x3dhInit});
}

/// Encrypts `plaintext` for a specific recipient device — reuses the existing
/// ratchet session if one is already established with that device, otherwise runs
/// X3DH against its published key bundle first. Session state is always
/// re-persisted after this call.
Future<OutgoingCiphertext> encryptForDevice(
  KeysApi keysApi,
  String recipientUserId,
  String recipientDeviceId,
  Uint8List plaintext,
) async {
  final unlocked = _requireUnlocked();

  var s = await loadSession(unlocked.kek, recipientDeviceId);
  dto.X3dhInitPayload? x3dhInit;

  if (s == null) {
    final bundle = await _fetchRemoteBundle(keysApi, recipientUserId, recipientDeviceId);
    final result = await session.createOutboundSession(unlocked.identity, bundle);
    s = result.session;
    x3dhInit = dto.X3dhInitPayload(
      identityAgreementKey: bytesToBase64(result.x3dhInit.identityAgreementKey),
      ephemeralKey: bytesToBase64(result.x3dhInit.ephemeralKey),
      usedSignedPreKeyId: result.x3dhInit.usedSignedPreKeyId,
      usedOneTimePreKeyId: result.x3dhInit.usedOneTimePreKeyId,
    );
  }

  final envelope = await session.encryptMessage(s, plaintext);
  await saveSession(unlocked.kek, recipientDeviceId, s);
  return OutgoingCiphertext(envelope: envelope, x3dhInit: x3dhInit);
}

/// Decrypts an incoming envelope from `senderDeviceId`. If no session exists yet and
/// the message carries `x3dhInit`, establishes the inbound session first (consuming
/// this device's matching one-time pre-key). Throws if there's no session AND no
/// `x3dhInit` to bootstrap one from.
Future<Uint8List> decryptFromDevice(
  String senderDeviceId,
  session.MessageEnvelope envelope,
  dto.X3dhInitPayload? x3dhInit,
) async {
  final unlocked = _requireUnlocked();

  var s = await loadSession(unlocked.kek, senderDeviceId);

  if (s == null) {
    if (x3dhInit == null) {
      throw StateError('No existing session for this sender, and no session-establishment data on this message.');
    }
    final localIdentity = await loadStoredIdentity(unlocked.kek);
    if (localIdentity == null) {
      throw StateError('Local identity is not available.');
    }
    final oneTimePreKey = await consumeOneTimePreKey(unlocked.kek, x3dhInit.usedOneTimePreKeyId);
    s = await session.createInboundSession(
      localIdentity.identity,
      localIdentity.signedPreKey,
      oneTimePreKey,
      X3dhInitialMessage(
        identityAgreementKey: base64ToBytes(x3dhInit.identityAgreementKey),
        ephemeralKey: base64ToBytes(x3dhInit.ephemeralKey),
        usedSignedPreKeyId: x3dhInit.usedSignedPreKeyId,
        usedOneTimePreKeyId: x3dhInit.usedOneTimePreKeyId,
      ),
    );
  }

  final plaintext = await session.decryptMessage(s, envelope);
  await saveSession(unlocked.kek, senderDeviceId, s);
  return plaintext;
}

/// Memoizes in-flight (and briefly, resolved) decrypts by the message's own id, so no
/// matter how many call sites race to decrypt the same incoming message (a
/// conversation-list preview and an open thread both reacting to the same WS event,
/// for instance), `decryptFromDevice` itself only ever actually runs once — the same
/// race the web client's `decryptFromDeviceOnce` closes, for the identical reason
/// (see that function's docstring in conversation-crypto.ts: a double X3DH-session
/// bootstrap can derive two different shared secrets and corrupt the loser).
final Map<String, Future<Uint8List>> _inFlightDecrypts = {};
const _decryptMemoTtl = Duration(seconds: 10);

Future<Uint8List> decryptFromDeviceOnce(
  String messageId,
  String senderDeviceId,
  session.MessageEnvelope envelope,
  dto.X3dhInitPayload? x3dhInit,
) {
  final existing = _inFlightDecrypts[messageId];
  if (existing != null) return existing;

  final future = decryptFromDevice(senderDeviceId, envelope, x3dhInit);
  _inFlightDecrypts[messageId] = future;

  void scheduleEviction() {
    Timer(_decryptMemoTtl, () {
      if (identical(_inFlightDecrypts[messageId], future)) _inFlightDecrypts.remove(messageId);
    });
  }

  future.then((_) => scheduleEviction(), onError: (_) => scheduleEviction());
  return future;
}
