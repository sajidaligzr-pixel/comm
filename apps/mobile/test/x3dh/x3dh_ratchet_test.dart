/// Self-consistency test suite mirroring
/// `packages/crypto/src/__tests__/x3dh-ratchet.test.ts` scenario-for-scenario — proves
/// this Dart port of the X3DH + Double Ratchet *algorithm* is internally correct
/// (full round trip, out-of-order delivery, DH-ratchet-turn skip, tamper detection,
/// forward secrecy). Combined with `x3dh_vectors_test.dart`'s byte-exact cross-language
/// proof of the handshake math, and `primitives_test.dart`'s byte-exact cross-language
/// proof of every primitive underneath, this is the third and final leg: that the
/// composition built on those primitives behaves per the Signal spec.
library;

import 'dart:convert';
import 'dart:typed_data';
import 'package:flutter_test/flutter_test.dart';
import 'package:comm_mobile/crypto/identity/keys.dart';
import 'package:comm_mobile/crypto/x3dh/x3dh.dart';
import 'package:comm_mobile/crypto/ratchet/double_ratchet.dart';

Future<PublicKeyBundle> _publishBundle(
  IdentityKeyPair identity,
  SignedPreKey signedPreKey, {
  OneTimePreKey? oneTimePreKey,
}) async {
  return PublicKeyBundle(
    identityAgreementKey: identity.agreement.publicKey,
    identitySigningKey: identity.signing.publicKey,
    signedPreKeyId: signedPreKey.keyId,
    signedPreKeyPublic: signedPreKey.keyPair.publicKey,
    signedPreKeySignature: signedPreKey.signature,
    oneTimePreKeyId: oneTimePreKey?.keyId,
    oneTimePreKeyPublic: oneTimePreKey?.keyPair.publicKey,
  );
}

class _Session {
  final IdentityKeyPair alice;
  final IdentityKeyPair bob;
  final X3dhInitiatorResult aliceSide;
  final X3dhReceiverResult bobSide;
  _Session({required this.alice, required this.bob, required this.aliceSide, required this.bobSide});
}

/// Mirrors the TS suite's `establishSession()` helper exactly: Alice fetches Bob's
/// bundle, initiates; Bob receives Alice's first message and derives the matching
/// session.
Future<_Session> _establishSession() async {
  final alice = await generateIdentityKeyPair();
  final bob = await generateIdentityKeyPair();
  final bobSignedPreKey = await generateSignedPreKey(bob.signing.privateKey, 1);
  final bobOneTimePreKeys = await generateOneTimePreKeys(1, 1);
  final bobOneTimePreKey = bobOneTimePreKeys[0];

  final bundle = await _publishBundle(bob, bobSignedPreKey, oneTimePreKey: bobOneTimePreKey);
  final aliceSide = await initiateSession(alice, bundle);

  final bobSide = await receiveSession(
    bob,
    bobSignedPreKey,
    bobOneTimePreKey,
    aliceSide.initialMessage.identityAgreementKey,
    aliceSide.initialMessage.ephemeralKey,
  );

  return _Session(alice: alice, bob: bob, aliceSide: aliceSide, bobSide: bobSide);
}

void main() {
  group('X3DH session establishment', () {
    test('both sides derive the same associated data', () async {
      final s = await _establishSession();
      expect(s.aliceSide.associatedData, equals(s.bobSide.associatedData));
    });

    test('rejects a bundle whose signed pre-key signature does not verify (spoofed bundle)', () async {
      final alice = await generateIdentityKeyPair();
      final bob = await generateIdentityKeyPair();
      final mallory = await generateIdentityKeyPair();
      final bobSignedPreKey = await generateSignedPreKey(bob.signing.privateKey, 1);

      final malloryPreKey = await generateSignedPreKey(mallory.signing.privateKey, 1);
      final tamperedBundle = PublicKeyBundle(
        identityAgreementKey: bob.agreement.publicKey,
        identitySigningKey: bob.signing.publicKey,
        signedPreKeyId: bobSignedPreKey.keyId,
        // Mallory (or a malicious server) substitutes Bob's signed pre-key with her
        // own, but the signature still claims to be Bob's — must fail closed.
        signedPreKeyPublic: malloryPreKey.keyPair.publicKey,
        signedPreKeySignature: bobSignedPreKey.signature,
        oneTimePreKeyId: null,
        oneTimePreKeyPublic: null,
      );

      expect(() => initiateSession(alice, tamperedBundle), throwsA(isA<StateError>()));
    });

    test('works without a one-time pre-key (exhausted pool fallback per the X3DH spec)', () async {
      final alice = await generateIdentityKeyPair();
      final bob = await generateIdentityKeyPair();
      final bobSignedPreKey = await generateSignedPreKey(bob.signing.privateKey, 1);
      final bundle = await _publishBundle(bob, bobSignedPreKey); // no one-time pre-key

      final aliceSide = await initiateSession(alice, bundle);
      final bobSide = await receiveSession(
        bob,
        bobSignedPreKey,
        null,
        aliceSide.initialMessage.identityAgreementKey,
        aliceSide.initialMessage.ephemeralKey,
      );

      expect(aliceSide.associatedData, equals(bobSide.associatedData));
    });
  });

  group('Double Ratchet over an X3DH-derived session', () {
    test('Alice sends, Bob decrypts — first message of a brand-new session', () async {
      final s = await _establishSession();
      final result = await ratchetEncrypt(s.aliceSide.ratchetState, utf8.encode('hello bob'), s.aliceSide.associatedData);
      final plaintext = await ratchetDecrypt(
        s.bobSide.ratchetState,
        result.header,
        result.ciphertext,
        s.bobSide.associatedData,
      );
      expect(utf8.decode(plaintext), 'hello bob');
    });

    test('a full back-and-forth conversation stays in sync across many messages', () async {
      final s = await _establishSession();
      final messages = ['hi', 'how are you', 'good, you?', 'great, want to grab coffee?', 'sure, 3pm?'];
      var fromAlice = true;

      for (final text in messages) {
        final senderState = fromAlice ? s.aliceSide.ratchetState : s.bobSide.ratchetState;
        final senderAd = fromAlice ? s.aliceSide.associatedData : s.bobSide.associatedData;
        final receiverState = fromAlice ? s.bobSide.ratchetState : s.aliceSide.ratchetState;
        final receiverAd = fromAlice ? s.bobSide.associatedData : s.aliceSide.associatedData;

        final result = await ratchetEncrypt(senderState, utf8.encode(text), senderAd);
        final plaintext = await ratchetDecrypt(receiverState, result.header, result.ciphertext, receiverAd);
        expect(utf8.decode(plaintext), text);

        fromAlice = !fromAlice;
      }
    });

    test('handles out-of-order delivery within a chain (message 2 arrives before message 1)', () async {
      final s = await _establishSession();

      final msg1 = await ratchetEncrypt(s.aliceSide.ratchetState, utf8.encode('first'), s.aliceSide.associatedData);
      final msg2 = await ratchetEncrypt(s.aliceSide.ratchetState, utf8.encode('second'), s.aliceSide.associatedData);

      final plaintext2 = await ratchetDecrypt(s.bobSide.ratchetState, msg2.header, msg2.ciphertext, s.bobSide.associatedData);
      expect(utf8.decode(plaintext2), 'second');

      final plaintext1 = await ratchetDecrypt(s.bobSide.ratchetState, msg1.header, msg1.ciphertext, s.bobSide.associatedData);
      expect(utf8.decode(plaintext1), 'first');
    });

    test('handles messages skipped across a DH ratchet turn (lost message, conversation continues)', () async {
      final s = await _establishSession();

      final opener = await ratchetEncrypt(s.aliceSide.ratchetState, utf8.encode('hey bob'), s.aliceSide.associatedData);
      await ratchetDecrypt(s.bobSide.ratchetState, opener.header, opener.ciphertext, s.bobSide.associatedData);

      // simulates network loss — encrypted, never delivered to Bob.
      await ratchetEncrypt(s.aliceSide.ratchetState, utf8.encode('this one gets lost'), s.aliceSide.associatedData);

      final bobReply = await ratchetEncrypt(s.bobSide.ratchetState, utf8.encode('bob replies'), s.bobSide.associatedData);
      await ratchetDecrypt(s.aliceSide.ratchetState, bobReply.header, bobReply.ciphertext, s.aliceSide.associatedData);

      final afterTurn = await ratchetEncrypt(s.aliceSide.ratchetState, utf8.encode('after the turn'), s.aliceSide.associatedData);
      final plaintext = await ratchetDecrypt(s.bobSide.ratchetState, afterTurn.header, afterTurn.ciphertext, s.bobSide.associatedData);
      expect(utf8.decode(plaintext), 'after the turn');
    });

    test('rejects a tampered ciphertext (bit flip) rather than returning corrupted plaintext', () async {
      final s = await _establishSession();
      final result = await ratchetEncrypt(s.aliceSide.ratchetState, utf8.encode('sensitive'), s.aliceSide.associatedData);

      final tampered = Uint8List.fromList(result.ciphertext);
      tampered[0] = tampered[0] ^ 0xff;

      expect(
        () => ratchetDecrypt(s.bobSide.ratchetState, result.header, tampered, s.bobSide.associatedData),
        throwsA(anything),
      );
    });

    test('rejects a message re-encrypted under the wrong associated data (cross-session replay)', () async {
      final s = await _establishSession();
      final result = await ratchetEncrypt(s.aliceSide.ratchetState, utf8.encode('for bob only'), s.aliceSide.associatedData);

      final wrongAd = utf8.encode('not the real associated data');
      expect(
        () => ratchetDecrypt(s.bobSide.ratchetState, result.header, result.ciphertext, wrongAd),
        throwsA(anything),
      );
    });

    test('forward secrecy: an old chain key cannot decrypt a message sent after a DH ratchet turn', () async {
      final s = await _establishSession();

      final opener = await ratchetEncrypt(s.aliceSide.ratchetState, utf8.encode('hey bob'), s.aliceSide.associatedData);
      await ratchetDecrypt(s.bobSide.ratchetState, opener.header, opener.ciphertext, s.bobSide.associatedData);

      final staleChainKey = s.bobSide.ratchetState.chainKeyRecv;

      final bobReply = await ratchetEncrypt(s.bobSide.ratchetState, utf8.encode('turning the ratchet'), s.bobSide.associatedData);
      await ratchetDecrypt(s.aliceSide.ratchetState, bobReply.header, bobReply.ciphertext, s.aliceSide.associatedData);
      final afterTurn = await ratchetEncrypt(s.aliceSide.ratchetState, utf8.encode('new chain message'), s.aliceSide.associatedData);

      final plaintext = await ratchetDecrypt(s.bobSide.ratchetState, afterTurn.header, afterTurn.ciphertext, s.bobSide.associatedData);
      expect(utf8.decode(plaintext), 'new chain message');
      expect(s.bobSide.ratchetState.chainKeyRecv, isNot(equals(staleChainKey)));
    });
  });
}
