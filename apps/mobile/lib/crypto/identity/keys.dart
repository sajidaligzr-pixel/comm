/// Direct port of `packages/crypto/src/identity/keys.ts` — see that file's docstring
/// for why identity is a pair of key pairs (Ed25519 signing + X25519 agreement)
/// rather than one XEdDSA-converted key.
library;

import 'dart:typed_data';
import '../primitives.dart';

class IdentityKeyPair {
  final KeyPairBytes signing; // Ed25519
  final KeyPairBytes agreement; // X25519
  const IdentityKeyPair({required this.signing, required this.agreement});
}

Future<IdentityKeyPair> generateIdentityKeyPair() async {
  final signing = await generateEd25519KeyPair();
  final agreement = await generateX25519KeyPair();
  return IdentityKeyPair(signing: signing, agreement: agreement);
}

class SignedPreKey {
  final int keyId;
  final KeyPairBytes keyPair; // X25519
  final Uint8List signature; // Ed25519 signature over keyPair.publicKey
  const SignedPreKey({required this.keyId, required this.keyPair, required this.signature});
}

/// Rotated periodically by the client — a fresh one replaces the old (server-side
/// concern, not this file's).
Future<SignedPreKey> generateSignedPreKey(Uint8List identitySigningPrivateKey, int keyId) async {
  final keyPair = await generateX25519KeyPair();
  final signature = await sign(identitySigningPrivateKey, keyPair.publicKey);
  return SignedPreKey(keyId: keyId, keyPair: keyPair, signature: signature);
}

class OneTimePreKey {
  final int keyId;
  final KeyPairBytes keyPair; // X25519
  const OneTimePreKey({required this.keyId, required this.keyPair});
}

/// Each one-time pre-key is consumed exactly once (server enforces via
/// `one_time_pre_keys.claimed_at`) — this just generates a batch; the caller keeps
/// the private halves until used, then deletes them (see crypto/sessions.dart's
/// inbound-session handling).
Future<List<OneTimePreKey>> generateOneTimePreKeys(int count, int startKeyId) async {
  final out = <OneTimePreKey>[];
  for (var i = 0; i < count; i++) {
    out.add(OneTimePreKey(keyId: startKeyId + i, keyPair: await generateX25519KeyPair()));
  }
  return out;
}
