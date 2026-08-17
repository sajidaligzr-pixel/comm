/// Known-answer test generated FROM `packages/crypto`'s actual TypeScript
/// `receiveSession` computation (see packages/crypto/scripts/_gen-dart-x3dh-vectors.ts,
/// not committed) — every hex literal below was written by a script reading the
/// generator's JSON output directly, not retyped by hand. `receiveSession` has zero
/// internal randomness (the ephemeral key is something it RECEIVES, not generates),
/// so with fixed input key material its output is 100% reproducible — this is a real,
/// byte-exact proof that x3dh.dart's receiver-side math (all four DH computations,
/// the HKDF derivation, and the associated-data construction) agrees with the
/// TypeScript implementation, not just "should agree because both claim X3DH".
library;

import 'dart:typed_data';
import 'package:flutter_test/flutter_test.dart';
import 'package:comm_mobile/crypto/primitives.dart';
import 'package:comm_mobile/crypto/identity/keys.dart';
import 'package:comm_mobile/crypto/x3dh/x3dh.dart';
import '../crypto/hex.dart';

void main() {
  group('X3DH receiveSession (vs packages/crypto/src/x3dh/x3dh.ts)', () {
    test('shared key, associated data, and ratchet root key all match exactly', () async {
      final bobIdentity = IdentityKeyPair(
        signing: KeyPairBytes(
          privateKey: hexToBytes('6666666666666666666666666666666666666666666666666666666666666666'),
          publicKey: hexToBytes('219e4d800da968d2a5fcb009c784f4746c7138edb9ee4844b739e830b05cf424'),
        ),
        agreement: KeyPairBytes(
          privateKey: hexToBytes('1111111111111111111111111111111111111111111111111111111111111111'),
          publicKey: hexToBytes('7b4e909bbe7ffe44c465a220037d608ee35897d31ef972f07f74892cb0f73f13'),
        ),
      );
      final bobSignedPreKey = SignedPreKey(
        keyId: 1,
        keyPair: KeyPairBytes(
          privateKey: hexToBytes('2222222222222222222222222222222222222222222222222222222222222222'),
          publicKey: hexToBytes('0faa684ed28867b97f4a6a2dee5df8ce974e76b7018e3f22a1c4cf2678570f20'),
        ),
        signature: Uint8List(64),
      );
      final bobOneTimePreKey = OneTimePreKey(
        keyId: 7,
        keyPair: KeyPairBytes(
          privateKey: hexToBytes('3333333333333333333333333333333333333333333333333333333333333333'),
          publicKey: hexToBytes('7b0d47d93427f8311160781c7c733fd89f88970aef490d8aa0ee19a4cb8a1b14'),
        ),
      );
      final theirIdentityAgreementKey = hexToBytes('ff2ee45601ec1b67310c7790404585ae697331eee1c1f8cf2419731c1fff3e6b');
      final theirEphemeralKey = hexToBytes('38ab664bd86f77d7e66bdd9ae0792913a94fd8b33a1260027e4b46c1f4884c67');

      final result = await receiveSession(
        bobIdentity,
        bobSignedPreKey,
        bobOneTimePreKey,
        theirIdentityAgreementKey,
        theirEphemeralKey,
      );

      expect(bytesToHex(result.ratchetState.rootKey), '2f97de4b63e03956d934028137d23c5994a2e122bc958b1111bfbdd9e8df5bba');
      expect(bytesToHex(result.associatedData), 'ff2ee45601ec1b67310c7790404585ae697331eee1c1f8cf2419731c1fff3e6b7b4e909bbe7ffe44c465a220037d608ee35897d31ef972f07f74892cb0f73f13');
      // A fresh receiver ratchet state has no send/recv chain yet — mirrors
      // initRatchetAsReceiver's contract exactly (same as the TS side).
      expect(result.ratchetState.chainKeySend, isNull);
      expect(result.ratchetState.chainKeyRecv, isNull);
      expect(result.ratchetState.dhRemote, isNull);
    });
  });
}
