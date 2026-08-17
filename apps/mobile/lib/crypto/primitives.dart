/// Thin, direct wrappers around `package:cryptography` — the Dart counterpart of
/// `packages/crypto/src/primitives.ts`. Same rule as that file: no cryptographic
/// logic of its own, just names matching the Signal spec's own notation (DH, KDF,
/// ENCRYPT, ...) so every other file in this directory stays reviewable against
/// that spec line-by-line, and against `primitives.ts` side-by-side.
///
/// Cross-validated against the actual TypeScript implementation's own output (see
/// `test/crypto/primitives_test.dart`'s known-answer vectors, generated FROM
/// `packages/crypto` directly, not hand-derived) — this is what actually proves the
/// two clients agree on identical algorithms, not just "should be the same because
/// both claim to implement X25519."
library;

import 'dart:convert';
import 'dart:math';
import 'dart:typed_data';
import 'package:cryptography/cryptography.dart';

const int x25519KeyLen = 32;
const int ed25519KeyLen = 32;
const int ed25519SigLen = 64;
const int aeadKeyLen = 32;
const int aeadNonceLen = 12;

final _secureRandom = Random.secure();

class KeyPairBytes {
  final Uint8List privateKey;
  final Uint8List publicKey;
  const KeyPairBytes({required this.privateKey, required this.publicKey});
}

Uint8List randomBytes(int length) {
  final bytes = Uint8List(length);
  for (var i = 0; i < length; i++) {
    bytes[i] = _secureRandom.nextInt(256);
  }
  return bytes;
}

// ── X25519 (Diffie-Hellman key agreement) ─────────────────────────────────────
final _x25519 = X25519();

Future<KeyPairBytes> generateX25519KeyPair() async {
  final kp = await _x25519.newKeyPair();
  final priv = await kp.extractPrivateKeyBytes();
  final pub = await kp.extractPublicKey();
  return KeyPairBytes(privateKey: Uint8List.fromList(priv), publicKey: Uint8List.fromList(pub.bytes));
}

/// `DH(pair, pub)` in the X3DH/Double Ratchet specs' own notation. Takes raw key
/// bytes (as stored/wrapped locally — see storage/wrap.dart) rather than a live
/// `KeyPair` object, matching `primitives.ts#dh`'s signature exactly.
Future<Uint8List> dh(Uint8List ourPrivateKey, Uint8List theirPublicKey) async {
  final ourKeyPair = await _x25519.newKeyPairFromSeed(ourPrivateKey);
  final shared = await _x25519.sharedSecretKey(
    keyPair: ourKeyPair,
    remotePublicKey: SimplePublicKey(theirPublicKey, type: KeyPairType.x25519),
  );
  return Uint8List.fromList(await shared.extractBytes());
}

// ── Ed25519 (identity signing) ─────────────────────────────────────────────────
final _ed25519 = Ed25519();

Future<KeyPairBytes> generateEd25519KeyPair() async {
  final kp = await _ed25519.newKeyPair();
  final priv = await kp.extractPrivateKeyBytes();
  final pub = await kp.extractPublicKey();
  return KeyPairBytes(privateKey: Uint8List.fromList(priv), publicKey: Uint8List.fromList(pub.bytes));
}

Future<Uint8List> sign(Uint8List privateKey, Uint8List message) async {
  final keyPair = await _ed25519.newKeyPairFromSeed(privateKey);
  final sig = await _ed25519.sign(message, keyPair: keyPair);
  return Uint8List.fromList(sig.bytes);
}

/// Fails closed (`false`), never throws — a malformed signature/key is an expected
/// outcome to check for (a tampered or spoofed bundle), not a program error. Same
/// contract as `primitives.ts#verify`.
Future<bool> verify(Uint8List publicKey, Uint8List message, Uint8List signature) async {
  try {
    return await _ed25519.verify(
      message,
      signature: Signature(signature, publicKey: SimplePublicKey(publicKey, type: KeyPairType.ed25519)),
    );
  } catch (_) {
    return false;
  }
}

// ── HKDF / HMAC (root-key and chain-key derivation) ────────────────────────────
Future<Uint8List> hkdfSha256(Uint8List ikm, Uint8List salt, String info, int length) async {
  final hkdf = Hkdf(hmac: Hmac.sha256(), outputLength: length);
  final key = await hkdf.deriveKey(secretKey: SecretKey(ikm), nonce: salt, info: utf8.encode(info));
  return Uint8List.fromList(await key.extractBytes());
}

Future<Uint8List> hmacSha256(Uint8List key, Uint8List message) async {
  final mac = await Hmac.sha256().calculateMac(message, secretKey: SecretKey(key));
  return Uint8List.fromList(mac.bytes);
}

// ── AEAD (message content encryption) ───────────────────────────────────────────
final _chacha = Chacha20.poly1305Aead();

/// ChaCha20-Poly1305 — same choice and same reasoning as `primitives.ts`'s AEAD
/// section: a well-studied AEAD with no known implementation footgun comparable to
/// AES-GCM's nonce-reuse catastrophe. Returns `ciphertext || tag` concatenated (16
/// -byte Poly1305 tag appended), matching `@noble/ciphers`' wire format exactly —
/// this is what makes a ciphertext produced by either client's Double Ratchet
/// decryptable by the other's.
Future<Uint8List> aeadEncrypt(Uint8List key, Uint8List nonce, Uint8List plaintext, Uint8List aad) async {
  final box = await _chacha.encrypt(plaintext, secretKey: SecretKey(key), nonce: nonce, aad: aad);
  return Uint8List.fromList([...box.cipherText, ...box.mac.bytes]);
}

/// Throws on tag mismatch (via `SecretBoxAuthenticationError` from the underlying
/// package) — callers must not catch-and-ignore this, same contract as
/// `primitives.ts#aeadDecrypt`.
Future<Uint8List> aeadDecrypt(Uint8List key, Uint8List nonce, Uint8List ciphertextAndTag, Uint8List aad) async {
  final tagLen = 16; // Poly1305 tag length — fixed by construction, not configurable
  final cipherText = ciphertextAndTag.sublist(0, ciphertextAndTag.length - tagLen);
  final tag = ciphertextAndTag.sublist(ciphertextAndTag.length - tagLen);
  final box = SecretBox(cipherText, nonce: nonce, mac: Mac(tag));
  final plaintext = await _chacha.decrypt(box, secretKey: SecretKey(key), aad: aad);
  return Uint8List.fromList(plaintext);
}

/// Best-effort overwrite of sensitive bytes once they're no longer needed — same
/// "defense in depth, not a claim of secure erasure" caveat as `primitives.ts#wipe`
/// (Dart's GC may have already made copies before this runs).
void wipe(Uint8List bytes) {
  bytes.fillRange(0, bytes.length, 0);
}
