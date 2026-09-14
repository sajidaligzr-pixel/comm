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

  /// Non-null only when this call had to create a brand-new session (a fresh
  /// X3DH handshake) rather than reuse an already-established one. The caller
  /// MUST invoke this — and only this — AFTER the server has actually accepted
  /// the message, and must simply drop it if the send failed.
  ///
  /// Found live (2026-09, a real stuck-forever conversation traced through
  /// production data): the previous version of this function always persisted
  /// the new session immediately, before the caller had sent anything over the
  /// network. When that particular send subsequently failed to actually deliver
  /// (here: a voice message whose encrypted payload never made it, though the
  /// exact trigger has since been closed off — see messages/service.ts's own
  /// note), THIS device's local session was already saved as if the handshake
  /// had succeeded. Every later message to that recipient then looked like an
  /// ordinary ratchet continuation (no x3dhInit — `s` was non-null), which the
  /// recipient — who never actually received the real handshake — has no way to
  /// make sense of. No self-heal was possible from either side: the recipient's
  /// `decryptFromDevice` never re-examines `x3dhInit` once it already has any
  /// cached session, and this device kept believing its side was fine.
  ///
  /// Deferring persistence closes this at the source: if the send fails, this
  /// device simply forgets the new session ever existed, and the NEXT attempt
  /// starts over with a genuinely fresh X3DH handshake — carrying `x3dhInit`
  /// again, exactly as a first attempt would. A session that already existed
  /// before this call (a normal ratchet continuation) is unaffected — those keep
  /// persisting immediately, same as always; Double Ratchet's own skipped-
  /// message-key handling already tolerates an occasional lost continuation
  /// message on a chain the recipient has already established.
  final Future<void> Function()? confirmNewSession;

  const OutgoingCiphertext({
    required this.envelope,
    required this.x3dhInit,
    this.confirmNewSession,
  });
}

/// Encrypts `plaintext` for a specific recipient device — reuses the existing
/// ratchet session if one is already established with that device, otherwise runs
/// X3DH against its published key bundle first. An existing session's advanced
/// state is always re-persisted immediately; a brand-new session is NOT — see
/// `OutgoingCiphertext.confirmNewSession`'s own docstring for why, and call it
/// once the caller has confirmed this message actually made it to the server.
Future<OutgoingCiphertext> encryptForDevice(
  KeysApi keysApi,
  String recipientUserId,
  String recipientDeviceId,
  Uint8List plaintext,
) async {
  final unlocked = _requireUnlocked();

  var s = await loadSession(unlocked.kek, recipientDeviceId);
  final isNewSession = s == null;
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
  final establishedSession = s;
  if (isNewSession) {
    return OutgoingCiphertext(
      envelope: envelope,
      x3dhInit: x3dhInit,
      confirmNewSession: () => saveSession(unlocked.kek, recipientDeviceId, establishedSession),
    );
  }
  await saveSession(unlocked.kek, recipientDeviceId, s);
  return OutgoingCiphertext(envelope: envelope, x3dhInit: x3dhInit);
}

Future<session.Session> _bootstrapInboundSession(
  Uint8List kek,
  dto.X3dhInitPayload x3dhInit,
) async {
  final localIdentity = await loadStoredIdentity(kek);
  if (localIdentity == null) {
    throw StateError('Local identity is not available.');
  }
  final oneTimePreKey = await consumeOneTimePreKey(kek, x3dhInit.usedOneTimePreKeyId);
  return session.createInboundSession(
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

/// Decrypts an incoming envelope from `senderDeviceId`. If no session exists yet and
/// the message carries `x3dhInit`, establishes the inbound session first (consuming
/// this device's matching one-time pre-key). Throws if there's no session AND no
/// `x3dhInit` to bootstrap one from.
///
/// Self-heals a stale/wrong cached session: if a session already exists but fails to
/// decrypt this envelope, and the message carries `x3dhInit` anyway, that's the
/// sender telling us (whether it knows it or not) that IT thinks this is a fresh
/// handshake — re-bootstrap from that instead of giving up. Ordinarily a healthy
/// sender only attaches `x3dhInit` on the very first message of a session and never
/// again, so this branch is a no-op cost-wise in the common case (the cached session
/// decrypts fine, `x3dhInit` is simply ignored). It matters for exactly the failure
/// mode `encryptForDevice`'s `confirmNewSession` docstring describes: this device's
/// cached session for that sender is the STALE side of a desync neither end can see
/// on its own. Previously the only way out was uninstalling and reinstalling the
/// whole app — which "fixes" it only because that wipes local storage entirely,
/// forcing a fresh handshake with literally everyone. This is the same recovery,
/// scoped to just the one sender who actually needs it, and it now happens
/// automatically the next time they message us on a genuinely fresh session,
/// instead of needing a manual nuke-and-reinstall at all.
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
    s = await _bootstrapInboundSession(unlocked.kek, x3dhInit);
  } else if (x3dhInit != null) {
    try {
      final plaintext = await session.decryptMessage(s, envelope);
      await saveSession(unlocked.kek, senderDeviceId, s);
      return plaintext;
    } catch (_) {
      s = await _bootstrapInboundSession(unlocked.kek, x3dhInit);
    }
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
