/// Direct port of `packages/crypto/src/storage/wrap.ts` — see that file's docstring
/// for the design rationale (ChaCha20-Poly1305 reused rather than a second cipher,
/// random-not-counter nonce since wrapping is infrequent). Output layout is
/// identical: `nonce (12 bytes) || ciphertext+tag`.
library;

import 'dart:typed_data';
import '../encoding.dart';
import '../primitives.dart';

Future<Uint8List> wrapBytes(Uint8List kek, Uint8List plaintext) async {
  final nonce = randomBytes(aeadNonceLen);
  final ciphertext = await aeadEncrypt(kek, nonce, plaintext, Uint8List(0));
  return concatBytes([nonce, ciphertext]);
}

Future<Uint8List> unwrapBytes(Uint8List kek, Uint8List wrapped) async {
  final nonce = wrapped.sublist(0, aeadNonceLen);
  final ciphertext = wrapped.sublist(aeadNonceLen);
  return aeadDecrypt(kek, nonce, ciphertext, Uint8List(0));
}
