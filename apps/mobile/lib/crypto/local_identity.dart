/// Client-side device identity: generation, password-protected local storage, and
/// unlock — direct port of `apps/web/lib/crypto/identity.ts`. Real key generation
/// happens via this package's own crypto/ files; this file's job is orchestration
/// (generate → wrap under the password-derived KEK → store).
library;

import 'dart:convert';
import 'dart:typed_data';
import '../api/dtos.dart' show DeviceKeyBundle, IdentityKeyUpload, SignedPreKeyUpload, OneTimePreKeyUpload;
import 'encoding.dart';
import 'identity/keys.dart';
import 'primitives.dart';
import 'storage/key_derivation.dart';
import 'storage/wrap.dart';
import '../storage/blob_store.dart';

const _saltKey = 'kek-salt';
const _identityKey = 'identity-bundle';

/// How many one-time pre-keys a fresh device generates up front — a device tops
/// this pool back up later via keys_api.dart's uploadOneTimePreKeys.
const _initialOneTimePreKeyCount = 20;

class _StoredOneTimePreKey {
  final int keyId;
  final String privateKey;
  final String publicKey;
  const _StoredOneTimePreKey({required this.keyId, required this.privateKey, required this.publicKey});

  Map<String, dynamic> toJson() => {'keyId': keyId, 'privateKey': privateKey, 'publicKey': publicKey};
  static _StoredOneTimePreKey fromJson(Map<String, dynamic> json) => _StoredOneTimePreKey(
    keyId: json['keyId'] as int,
    privateKey: json['privateKey'] as String,
    publicKey: json['publicKey'] as String,
  );
}

class _StoredIdentityBundle {
  final String signingPrivateKey;
  final String signingPublicKey;
  final String agreementPrivateKey;
  final String agreementPublicKey;
  final int signedPreKeyId;
  final String signedPreKeyPrivateKey;
  final String signedPreKeyPublicKey;
  final String signedPreKeySignature;
  final List<_StoredOneTimePreKey> oneTimePreKeys;

  const _StoredIdentityBundle({
    required this.signingPrivateKey,
    required this.signingPublicKey,
    required this.agreementPrivateKey,
    required this.agreementPublicKey,
    required this.signedPreKeyId,
    required this.signedPreKeyPrivateKey,
    required this.signedPreKeyPublicKey,
    required this.signedPreKeySignature,
    required this.oneTimePreKeys,
  });

  Map<String, dynamic> toJson() => {
    'identity': {
      'signingPrivateKey': signingPrivateKey,
      'signingPublicKey': signingPublicKey,
      'agreementPrivateKey': agreementPrivateKey,
      'agreementPublicKey': agreementPublicKey,
    },
    'signedPreKey': {
      'keyId': signedPreKeyId,
      'privateKey': signedPreKeyPrivateKey,
      'publicKey': signedPreKeyPublicKey,
      'signature': signedPreKeySignature,
    },
    'oneTimePreKeys': oneTimePreKeys.map((k) => k.toJson()).toList(),
  };

  static _StoredIdentityBundle fromJson(Map<String, dynamic> json) {
    final identity = json['identity'] as Map<String, dynamic>;
    final signedPreKey = json['signedPreKey'] as Map<String, dynamic>;
    return _StoredIdentityBundle(
      signingPrivateKey: identity['signingPrivateKey'] as String,
      signingPublicKey: identity['signingPublicKey'] as String,
      agreementPrivateKey: identity['agreementPrivateKey'] as String,
      agreementPublicKey: identity['agreementPublicKey'] as String,
      signedPreKeyId: signedPreKey['keyId'] as int,
      signedPreKeyPrivateKey: signedPreKey['privateKey'] as String,
      signedPreKeyPublicKey: signedPreKey['publicKey'] as String,
      signedPreKeySignature: signedPreKey['signature'] as String,
      oneTimePreKeys: (json['oneTimePreKeys'] as List)
          .map((e) => _StoredOneTimePreKey.fromJson(e as Map<String, dynamic>))
          .toList(),
    );
  }
}

_StoredIdentityBundle _toStored(IdentityKeyPair identity, SignedPreKey signedPreKey, List<OneTimePreKey> oneTimePreKeys) {
  return _StoredIdentityBundle(
    signingPrivateKey: bytesToBase64(identity.signing.privateKey),
    signingPublicKey: bytesToBase64(identity.signing.publicKey),
    agreementPrivateKey: bytesToBase64(identity.agreement.privateKey),
    agreementPublicKey: bytesToBase64(identity.agreement.publicKey),
    signedPreKeyId: signedPreKey.keyId,
    signedPreKeyPrivateKey: bytesToBase64(signedPreKey.keyPair.privateKey),
    signedPreKeyPublicKey: bytesToBase64(signedPreKey.keyPair.publicKey),
    signedPreKeySignature: bytesToBase64(signedPreKey.signature),
    oneTimePreKeys: oneTimePreKeys
        .map((k) => _StoredOneTimePreKey(
              keyId: k.keyId,
              privateKey: bytesToBase64(k.keyPair.privateKey),
              publicKey: bytesToBase64(k.keyPair.publicKey),
            ))
        .toList(),
  );
}

class LocalIdentity {
  final IdentityKeyPair identity;
  final SignedPreKey signedPreKey;
  final List<OneTimePreKey> oneTimePreKeys;
  const LocalIdentity({required this.identity, required this.signedPreKey, required this.oneTimePreKeys});
}

LocalIdentity _fromStored(_StoredIdentityBundle s) {
  return LocalIdentity(
    identity: IdentityKeyPair(
      signing: KeyPairBytes(privateKey: base64ToBytes(s.signingPrivateKey), publicKey: base64ToBytes(s.signingPublicKey)),
      agreement: KeyPairBytes(privateKey: base64ToBytes(s.agreementPrivateKey), publicKey: base64ToBytes(s.agreementPublicKey)),
    ),
    signedPreKey: SignedPreKey(
      keyId: s.signedPreKeyId,
      keyPair: KeyPairBytes(privateKey: base64ToBytes(s.signedPreKeyPrivateKey), publicKey: base64ToBytes(s.signedPreKeyPublicKey)),
      signature: base64ToBytes(s.signedPreKeySignature),
    ),
    oneTimePreKeys: s.oneTimePreKeys
        .map((k) => OneTimePreKey(
              keyId: k.keyId,
              keyPair: KeyPairBytes(privateKey: base64ToBytes(k.privateKey), publicKey: base64ToBytes(k.publicKey)),
            ))
        .toList(),
  );
}

Future<bool> hasLocalIdentity() async => (await getBlob(_identityKey)) != null;

class CreatedIdentity {
  final DeviceKeyBundle keyBundle;
  final Uint8List kek;
  final IdentityKeyPair identity;
  const CreatedIdentity({required this.keyBundle, required this.kek, required this.identity});
}

/// Generates a brand-new device identity and stores it locally, wrapped under a key
/// derived from the account password. Returns the public `DeviceKeyBundle` to upload
/// via invite-redeem/login/device-link. Called exactly once per device.
Future<CreatedIdentity> createLocalIdentity(String password) async {
  final identity = await generateIdentityKeyPair();
  final signedPreKey = await generateSignedPreKey(identity.signing.privateKey, 1);
  final oneTimePreKeys = await generateOneTimePreKeys(_initialOneTimePreKeyCount, 1);

  final salt = generateKekSalt();
  final kek = await deriveKek(password, salt);
  final wrapped = await wrapBytes(kek, utf8ToBytes(jsonEncode(_toStored(identity, signedPreKey, oneTimePreKeys).toJson())));

  await putBlob(_saltKey, salt);
  await putBlob(_identityKey, wrapped);

  final keyBundle = DeviceKeyBundle(
    identityKey: IdentityKeyUpload(
      signingPublicKey: bytesToBase64(identity.signing.publicKey),
      agreementPublicKey: bytesToBase64(identity.agreement.publicKey),
    ),
    signedPreKey: SignedPreKeyUpload(
      keyId: signedPreKey.keyId,
      publicKey: bytesToBase64(signedPreKey.keyPair.publicKey),
      signature: bytesToBase64(signedPreKey.signature),
    ),
    oneTimePreKeys: oneTimePreKeys.map((k) => OneTimePreKeyUpload(keyId: k.keyId, publicKey: bytesToBase64(k.keyPair.publicKey))).toList(),
  );

  return CreatedIdentity(keyBundle: keyBundle, kek: kek, identity: identity);
}

class UnlockedIdentity {
  final IdentityKeyPair identity;
  final SignedPreKey signedPreKey;
  final List<OneTimePreKey> oneTimePreKeys;
  final Uint8List kek;
  const UnlockedIdentity({required this.identity, required this.signedPreKey, required this.oneTimePreKeys, required this.kek});
}

/// Unlocks the already-stored identity on a device that's logging back in. Returns
/// `null` on a wrong password (AEAD tag fails to verify, caught here since "wrong
/// password" is an expected outcome, not a program error) or if nothing is stored.
Future<UnlockedIdentity?> unlockLocalIdentity(String password) async {
  final salt = await getBlob(_saltKey);
  final wrapped = await getBlob(_identityKey);
  if (salt == null || wrapped == null) return null;

  final kek = await deriveKek(password, salt);
  Uint8List plaintext;
  try {
    plaintext = await unwrapBytes(kek, wrapped);
  } catch (_) {
    return null;
  }

  final stored = _StoredIdentityBundle.fromJson(jsonDecode(bytesToUtf8(plaintext)) as Map<String, dynamic>);
  final loaded = _fromStored(stored);
  return UnlockedIdentity(identity: loaded.identity, signedPreKey: loaded.signedPreKey, oneTimePreKeys: loaded.oneTimePreKeys, kek: kek);
}

/// Re-reads the current local identity using an ALREADY-derived KEK — no Argon2id
/// re-derivation, unlike `unlockLocalIdentity`. Used mid-session (e.g. establishing
/// an inbound X3DH session against an incoming message).
Future<LocalIdentity?> loadStoredIdentity(Uint8List kek) async {
  final wrapped = await getBlob(_identityKey);
  if (wrapped == null) return null;
  final plaintext = await unwrapBytes(kek, wrapped);
  return _fromStored(_StoredIdentityBundle.fromJson(jsonDecode(bytesToUtf8(plaintext)) as Map<String, dynamic>));
}

/// Called on logout/device revoke.
Future<void> wipeLocalIdentity() async {
  await deleteBlob(_saltKey);
  await deleteBlob(_identityKey);
}

/// Finds this device's own one-time pre-key by id and removes it from local
/// storage — one-time pre-keys are exactly that. Returns `null` if `keyId` is null
/// (the sender's bundle had no unclaimed one-time pre-key — X3DH's documented
/// fallback) or if this device has no record of that key.
Future<OneTimePreKey?> consumeOneTimePreKey(Uint8List kek, int? keyId) async {
  if (keyId == null) return null;

  final wrapped = await getBlob(_identityKey);
  if (wrapped == null) return null;
  final stored = _StoredIdentityBundle.fromJson(jsonDecode(bytesToUtf8(await unwrapBytes(kek, wrapped))) as Map<String, dynamic>);

  final index = stored.oneTimePreKeys.indexWhere((k) => k.keyId == keyId);
  if (index == -1) return null;

  final remaining = List<_StoredOneTimePreKey>.from(stored.oneTimePreKeys);
  final consumed = remaining.removeAt(index);
  final updated = _StoredIdentityBundle(
    signingPrivateKey: stored.signingPrivateKey,
    signingPublicKey: stored.signingPublicKey,
    agreementPrivateKey: stored.agreementPrivateKey,
    agreementPublicKey: stored.agreementPublicKey,
    signedPreKeyId: stored.signedPreKeyId,
    signedPreKeyPrivateKey: stored.signedPreKeyPrivateKey,
    signedPreKeyPublicKey: stored.signedPreKeyPublicKey,
    signedPreKeySignature: stored.signedPreKeySignature,
    oneTimePreKeys: remaining,
  );
  final rewrapped = await wrapBytes(kek, utf8ToBytes(jsonEncode(updated.toJson())));
  await putBlob(_identityKey, rewrapped);

  return OneTimePreKey(
    keyId: consumed.keyId,
    keyPair: KeyPairBytes(privateKey: base64ToBytes(consumed.privateKey), publicKey: base64ToBytes(consumed.publicKey)),
  );
}
