/// `wrapBytes`/`unwrapBytes` (crypto/storage/wrap.dart) is what biometric unlock
/// (features/auth/biometric_unlock.dart) actually relies on to protect the KEK
/// under a device-local wrap key — the local_auth/flutter_secure_storage halves of
/// that feature need platform channels this suite doesn't mock, but the
/// cryptographic round trip underneath them is pure Dart and worth its own direct
/// coverage: a bug here would silently break unlock for every device that ever
/// enrolls, not just fail loudly at the call site.
library;

import 'dart:typed_data';
import 'package:flutter_test/flutter_test.dart';
import 'package:comm_mobile/crypto/primitives.dart';
import 'package:comm_mobile/crypto/storage/wrap.dart';

void main() {
  group('wrapBytes / unwrapBytes', () {
    test('round-trips arbitrary plaintext under a random key', () async {
      final key = randomBytes(aeadKeyLen);
      final plaintext = randomBytes(32); // KEK-sized payload, same as the real use

      final wrapped = await wrapBytes(key, plaintext);
      final unwrapped = await unwrapBytes(key, wrapped);

      expect(unwrapped, plaintext);
    });

    test('a different key fails to unwrap rather than returning garbage', () async {
      final key = randomBytes(aeadKeyLen);
      final wrongKey = randomBytes(aeadKeyLen);
      final plaintext = randomBytes(32);

      final wrapped = await wrapBytes(key, plaintext);

      expect(() => unwrapBytes(wrongKey, wrapped), throwsA(anything));
    });

    test('two wraps of the same plaintext use different nonces (never repeats)', () async {
      final key = randomBytes(aeadKeyLen);
      final plaintext = randomBytes(32);

      final a = await wrapBytes(key, plaintext);
      final b = await wrapBytes(key, plaintext);

      final nonceA = Uint8List.sublistView(a, 0, aeadNonceLen);
      final nonceB = Uint8List.sublistView(b, 0, aeadNonceLen);
      expect(nonceA, isNot(nonceB));
    });
  });
}
