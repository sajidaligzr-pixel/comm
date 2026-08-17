/// X3DH (Extended Triple Diffie-Hellman), ported from `packages/crypto/src/x3dh/x3dh.ts`
/// to Signal's published specification (https://signal.org/docs/specifications/x3dh/).
/// The asynchronous handshake that lets Alice start a session with Bob's device while
/// Bob is offline. Produces the initial root key handed to
/// `ratchet/double_ratchet.dart`'s `initRatchetAsSender`/`initRatchetAsReceiver`.
library;

import 'dart:typed_data';
import '../encoding.dart';
import '../primitives.dart';
import '../identity/keys.dart';
import '../ratchet/double_ratchet.dart';

const String _x3dhKdfInfo = 'Comm_X3DH_v1';

/// 32 bytes of 0xFF prepended to the DH outputs before the KDF, per the spec's
/// recommendation (§2.2) — domain-separates X3DH-derived keys cheaply.
Uint8List _x3dhF() => Uint8List(32)..fillRange(0, 32, 0xff);

/// What a device publishes so others can start a session with it — public material
/// only.
class PublicKeyBundle {
  final Uint8List identityAgreementKey; // X25519 public
  final Uint8List identitySigningKey; // Ed25519 public
  final int signedPreKeyId;
  final Uint8List signedPreKeyPublic;
  final Uint8List signedPreKeySignature;
  final int? oneTimePreKeyId;
  final Uint8List? oneTimePreKeyPublic;

  const PublicKeyBundle({
    required this.identityAgreementKey,
    required this.identitySigningKey,
    required this.signedPreKeyId,
    required this.signedPreKeyPublic,
    required this.signedPreKeySignature,
    required this.oneTimePreKeyId,
    required this.oneTimePreKeyPublic,
  });
}

class X3dhInitialMessage {
  final Uint8List identityAgreementKey;
  final Uint8List ephemeralKey;
  final int usedSignedPreKeyId;
  final int? usedOneTimePreKeyId;
  const X3dhInitialMessage({
    required this.identityAgreementKey,
    required this.ephemeralKey,
    required this.usedSignedPreKeyId,
    required this.usedOneTimePreKeyId,
  });
}

class X3dhInitiatorResult {
  final RatchetState ratchetState;
  final Uint8List associatedData;

  /// What the initiator sends to the recipient alongside their first ratchet-encrypted
  /// message, so the recipient can derive the same SK — carried on the first message
  /// of a new session only.
  final X3dhInitialMessage initialMessage;

  const X3dhInitiatorResult({required this.ratchetState, required this.associatedData, required this.initialMessage});
}

/// Alice's side. Throws if the recipient's signed pre-key signature doesn't verify
/// against their identity key — this is the check that stops a compromised server
/// from substituting a key of its own into the bundle it relays.
Future<X3dhInitiatorResult> initiateSession(IdentityKeyPair ourIdentity, PublicKeyBundle theirBundle) async {
  final signatureValid = await verify(
    theirBundle.identitySigningKey,
    theirBundle.signedPreKeyPublic,
    theirBundle.signedPreKeySignature,
  );
  if (!signatureValid) {
    throw StateError('Signed pre-key signature is invalid — refusing to establish a session with this bundle.');
  }

  final ephemeral = await generateX25519KeyPair();

  final dh1 = await dh(ourIdentity.agreement.privateKey, theirBundle.signedPreKeyPublic);
  final dh2 = await dh(ephemeral.privateKey, theirBundle.identityAgreementKey);
  final dh3 = await dh(ephemeral.privateKey, theirBundle.signedPreKeyPublic);
  final dh4 = theirBundle.oneTimePreKeyPublic != null
      ? await dh(ephemeral.privateKey, theirBundle.oneTimePreKeyPublic!)
      : Uint8List(0);

  final ikm = concatBytes([_x3dhF(), dh1, dh2, dh3, dh4]);
  final sharedKey = await hkdfSha256(ikm, Uint8List(32), _x3dhKdfInfo, 32);

  // Initiator's identity goes first in the associated data, consistently on both
  // sides — see receiveSession's matching construction.
  final associatedData = concatBytes([ourIdentity.agreement.publicKey, theirBundle.identityAgreementKey]);

  final ratchetState = await initRatchetAsSender(sharedKey, theirBundle.signedPreKeyPublic);

  wipe(dh1);
  wipe(dh2);
  wipe(dh3);
  wipe(dh4);
  wipe(ikm);
  wipe(ephemeral.privateKey);

  return X3dhInitiatorResult(
    ratchetState: ratchetState,
    associatedData: associatedData,
    initialMessage: X3dhInitialMessage(
      identityAgreementKey: ourIdentity.agreement.publicKey,
      ephemeralKey: ephemeral.publicKey,
      usedSignedPreKeyId: theirBundle.signedPreKeyId,
      usedOneTimePreKeyId: theirBundle.oneTimePreKeyId,
    ),
  );
}

class X3dhReceiverResult {
  final RatchetState ratchetState;
  final Uint8List associatedData;
  const X3dhReceiverResult({required this.ratchetState, required this.associatedData});
}

/// Bob's side — called once, when the first message referencing a not-yet-established
/// session arrives. `ourOneTimePreKey` must be the specific one the initiator's
/// message says it used (looked up by id, then deleted by the caller after this
/// returns — one-time pre-keys are exactly that).
Future<X3dhReceiverResult> receiveSession(
  IdentityKeyPair ourIdentity,
  SignedPreKey ourSignedPreKey,
  OneTimePreKey? ourOneTimePreKey,
  Uint8List theirIdentityAgreementKey,
  Uint8List theirEphemeralKey,
) async {
  final dh1 = await dh(ourSignedPreKey.keyPair.privateKey, theirIdentityAgreementKey);
  final dh2 = await dh(ourIdentity.agreement.privateKey, theirEphemeralKey);
  final dh3 = await dh(ourSignedPreKey.keyPair.privateKey, theirEphemeralKey);
  final dh4 = ourOneTimePreKey != null
      ? await dh(ourOneTimePreKey.keyPair.privateKey, theirEphemeralKey)
      : Uint8List(0);

  final ikm = concatBytes([_x3dhF(), dh1, dh2, dh3, dh4]);
  final sharedKey = await hkdfSha256(ikm, Uint8List(32), _x3dhKdfInfo, 32);

  // Same order as initiateSession: initiator (them) first, responder (us) second.
  final associatedData = concatBytes([theirIdentityAgreementKey, ourIdentity.agreement.publicKey]);

  final ratchetState = initRatchetAsReceiver(sharedKey, ourSignedPreKey.keyPair);

  wipe(dh1);
  wipe(dh2);
  wipe(dh3);
  wipe(dh4);
  wipe(ikm);
  if (ourOneTimePreKey != null) wipe(ourOneTimePreKey.keyPair.privateKey);

  return X3dhReceiverResult(ratchetState: ratchetState, associatedData: associatedData);
}
