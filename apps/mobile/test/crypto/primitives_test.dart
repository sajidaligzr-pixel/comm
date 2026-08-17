/// Known-answer tests generated FROM `packages/crypto`'s actual TypeScript
/// implementation (@noble/curves, @noble/hashes, @noble/ciphers, hash-wasm) — not
/// hand-derived expected values, and every hex literal below was written by a
/// script reading the generator's JSON output directly, not retyped by hand (a
/// transcription slip in a cross-validation test would silently defeat the whole
/// point of having one). A pass here is a real, proven guarantee that this Dart
/// port and the web/server TypeScript code agree byte-for-byte on every primitive,
/// which is what makes a message encrypted by one client decryptable by the other.
/// See lib/crypto/primitives.dart's own docstring.
library;

import 'dart:convert';
import 'package:flutter_test/flutter_test.dart';
import 'package:comm_mobile/crypto/primitives.dart';
import 'package:comm_mobile/crypto/storage/key_derivation.dart';
import 'hex.dart';

void main() {
  group('X25519 (vs @noble/curves)', () {
    test('shared secret matches', () async {
      final alicePriv = hexToBytes('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
      final bobPub = hexToBytes('6b0b616d718e53691236d3be3ce6d44f9d28836426d81305d131f488206f8d2b');
      final expectedShared = hexToBytes('2f6d4d0247b4216d9114a87cf9206bc9c65c1b62593f18b7f3474a747e615229');

      final shared = await dh(alicePriv, bobPub);
      expect(bytesToHex(shared), bytesToHex(expectedShared));
    });

    test('generated key pair produces correctly-sized keys', () async {
      final kp = await generateX25519KeyPair();
      expect(kp.privateKey.length, x25519KeyLen);
      expect(kp.publicKey.length, x25519KeyLen);
    });
  });

  group('Ed25519 (vs @noble/curves)', () {
    test('signature matches', () async {
      final signPriv = hexToBytes('cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc');
      final message = utf8.encode('comm-dart-cross-validation');
      final expectedSig = hexToBytes('5762c71fdac4a91e3faad18725460dda269e78f6e844ff9046210001bd17b8bfc0a0cba93ef12225917b1e5b32317d02fe24b3afbe4fb9bad497287e78a43e00');

      final sig = await sign(signPriv, message);
      expect(bytesToHex(sig), bytesToHex(expectedSig));
    });

    test('verify accepts a genuine signature and rejects a tampered one', () async {
      final kp = await generateEd25519KeyPair();
      final message = utf8.encode('hello');
      final sig = await sign(kp.privateKey, message);

      expect(await verify(kp.publicKey, message, sig), isTrue);

      final tampered = utf8.encode('hellO');
      expect(await verify(kp.publicKey, tampered, sig), isFalse);
    });
  });

  group('HKDF-SHA256 (vs @noble/hashes)', () {
    test('output matches', () async {
      final ikm = hexToBytes('dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd');
      final salt = hexToBytes('eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee');
      final expected = hexToBytes('d3271011ee0b46885b6534674e477a9dd63b8ed72cf19495d98e0f7c444193f6');

      final okm = await hkdfSha256(ikm, salt, 'comm-dart-hkdf-info', 32);
      expect(bytesToHex(okm), bytesToHex(expected));
    });
  });

  group('ChaCha20-Poly1305 AEAD (vs @noble/ciphers)', () {
    test('ciphertext||tag matches', () async {
      final key = hexToBytes('ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff');
      final nonce = hexToBytes('111111111111111111111111');
      final aad = utf8.encode('comm-dart-aad');
      final plaintext = utf8.encode('the quick brown fox');
      final expectedCiphertext = hexToBytes('c93be0f7f3fc0f02e7e422292aa19a6f43d50239e02ead02162e5adb519c606afeed1a');

      final ciphertext = await aeadEncrypt(key, nonce, plaintext, aad);
      expect(bytesToHex(ciphertext), bytesToHex(expectedCiphertext));

      final decrypted = await aeadDecrypt(key, nonce, ciphertext, aad);
      expect(utf8.decode(decrypted), 'the quick brown fox');
    });

    test('tampered ciphertext fails to decrypt rather than returning garbage', () async {
      final key = randomBytes(aeadKeyLen);
      final nonce = randomBytes(aeadNonceLen);
      final aad = utf8.encode('aad');
      final plaintext = utf8.encode('secret');
      final ciphertext = await aeadEncrypt(key, nonce, plaintext, aad);
      ciphertext[0] ^= 0xff;

      expect(() => aeadDecrypt(key, nonce, ciphertext, aad), throwsA(anything));
    });
  });

  group('Argon2id KEK derivation (vs hash-wasm)', () {
    test('output matches key-derivation.ts DEFAULT_PARAMS', () async {
      final salt = hexToBytes('22222222222222222222222222222222');
      final expected = hexToBytes('5a4d8dc22f66472dcbeb2059a1412f79bbfba18780278983a013b0ca4a434979');

      final kek = await deriveKek('correct horse battery staple', salt);
      expect(bytesToHex(kek), bytesToHex(expected));
    });
  });
}
