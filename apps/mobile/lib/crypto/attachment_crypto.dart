/// Per-file encryption for the general file-attachment pipeline — direct port of
/// `apps/web/lib/crypto/attachment-crypto.ts`. Deliberately a *different* cipher
/// from `primitives.dart`'s ChaCha20-Poly1305 (used internally by the Double
/// Ratchet) — AES-256-GCM, matching the web client's use of native Web Crypto
/// AES-GCM exactly, per docs/05-crypto-architecture.md#media-encryption: "Each
/// attachment gets a fresh random 256-bit AES key and 96-bit nonce." The key/nonce
/// travel to the recipient inside the already end-to-end-encrypted message envelope
/// (see features/chats/thread_screen.dart), never alongside the ciphertext in
/// object storage.
library;

import 'dart:typed_data';
import 'package:cryptography/cryptography.dart';
import 'primitives.dart' show randomBytes;

const attachmentKeyLen = 32;
const attachmentNonceLen = 12;

final _aesGcm = AesGcm.with256bits();

class EncryptedAttachment {
  final Uint8List ciphertext;
  final Uint8List key;
  final Uint8List nonce;
  const EncryptedAttachment({required this.ciphertext, required this.key, required this.nonce});
}

Future<EncryptedAttachment> encryptAttachment(Uint8List plaintext) async {
  final key = randomBytes(attachmentKeyLen);
  final nonce = randomBytes(attachmentNonceLen);
  final box = await _aesGcm.encrypt(plaintext, secretKey: SecretKey(key), nonce: nonce);
  // AES-GCM's tag is 16 bytes, appended — mirrors ciphertext||tag, same wire
  // convention as primitives.dart's ChaCha20-Poly1305 wrapper, so both ciphers in
  // this codebase share one "ciphertext ends with its own auth tag" rule.
  final ciphertext = Uint8List.fromList([...box.cipherText, ...box.mac.bytes]);
  return EncryptedAttachment(ciphertext: ciphertext, key: key, nonce: nonce);
}

/// Throws (GCM tag mismatch) rather than returning garbage on tamper — same
/// tamper-detection posture as the Double Ratchet's own AEAD.
Future<Uint8List> decryptAttachment(Uint8List ciphertextAndTag, Uint8List key, Uint8List nonce) async {
  const tagLen = 16;
  final cipherText = ciphertextAndTag.sublist(0, ciphertextAndTag.length - tagLen);
  final tag = ciphertextAndTag.sublist(ciphertextAndTag.length - tagLen);
  final box = SecretBox(cipherText, nonce: nonce, mac: Mac(tag));
  final plaintext = await _aesGcm.decrypt(box, secretKey: SecretKey(key));
  return Uint8List.fromList(plaintext);
}
