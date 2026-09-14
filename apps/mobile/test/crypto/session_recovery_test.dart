/// Proves the crypto-level property `conversation_crypto.dart`'s `decryptFromDevice`
/// self-heal fallback relies on — see that function's own docstring for the real
/// stuck-forever conversation this was found fixing. The bug: a sender's local
/// session for a recipient can end up silently orphaned from what the recipient
/// actually has (its own send-side fix is `encryptForDevice`'s `confirmNewSession`),
/// and the ONLY way the recipient recovered before this fix was uninstalling and
/// reinstalling the whole app. This suite exercises `session.dart`'s own public API
/// (the exact layer `conversation_crypto.dart` calls into) to confirm two things a
/// self-heal-on-decrypt-failure strategy depends on:
///
///  1. Decrypting a message with the WRONG cached session throws rather than
///     silently returning corrupted plaintext — self-healing must only ever trigger
///     on a genuine failure, never "sometimes decrypts into garbage instead."
///  2. Bootstrapping a brand-new inbound session from that same message's own
///     `x3dhInit` and retrying recovers the correct plaintext, even though a
///     different (stale) session for the same two parties already existed locally.
library;

import 'dart:typed_data';
import 'package:flutter_test/flutter_test.dart';
import 'package:comm_mobile/crypto/identity/keys.dart';
import 'package:comm_mobile/crypto/session/session.dart';
import 'package:comm_mobile/crypto/x3dh/x3dh.dart' show PublicKeyBundle;

Future<PublicKeyBundle> _publishBundle(
  IdentityKeyPair identity,
  SignedPreKey signedPreKey,
  OneTimePreKey oneTimePreKey,
) async {
  return PublicKeyBundle(
    identityAgreementKey: identity.agreement.publicKey,
    identitySigningKey: identity.signing.publicKey,
    signedPreKeyId: signedPreKey.keyId,
    signedPreKeyPublic: signedPreKey.keyPair.publicKey,
    signedPreKeySignature: signedPreKey.signature,
    oneTimePreKeyId: oneTimePreKey.keyId,
    oneTimePreKeyPublic: oneTimePreKey.keyPair.publicKey,
  );
}

void main() {
  group('Session recovery from a mismatched cached session', () {
    test(
      'the wrong cached session fails closed, then a fresh bootstrap from the '
      "message's own x3dhInit recovers the real plaintext",
      () async {
        final alice = await generateIdentityKeyPair();
        final bob = await generateIdentityKeyPair();
        final bobSignedPreKey = await generateSignedPreKey(bob.signing.privateKey, 1);
        final bobOneTimePreKeys = await generateOneTimePreKeys(2, 1);

        // Session A: what Bob actually has cached locally — a genuine, real
        // session both sides once established properly together.
        final bundleForA = await _publishBundle(bob, bobSignedPreKey, bobOneTimePreKeys[0]);
        final aliceOutboundA = await createOutboundSession(alice, bundleForA);
        final bobInboundA = await createInboundSession(
          bob,
          bobSignedPreKey,
          bobOneTimePreKeys[0],
          aliceOutboundA.x3dhInit,
        );
        // Prove session A genuinely works end to end before moving on — this
        // isn't the failure being tested, just the "both sides once agreed"
        // starting point the bug leaves behind.
        final sanityEnvelope = await encryptMessage(aliceOutboundA.session, utf8ToBytesFor('hi'));
        expect(
          await decryptMessage(bobInboundA, sanityEnvelope),
          equals(utf8ToBytesFor('hi')),
        );

        // Session B: Alice independently creates a SECOND, unrelated session with
        // Bob (a fresh X3DH — a different ephemeral key and one-time pre-key),
        // mirroring exactly what `encryptForDevice` used to persist immediately
        // even when the message carrying it never actually reached Bob. Bob's
        // cache still only has session A; he was never given B.
        final bundleForB = await _publishBundle(bob, bobSignedPreKey, bobOneTimePreKeys[1]);
        final aliceOutboundB = await createOutboundSession(alice, bundleForB);
        final envelopeUnderB = await encryptMessage(aliceOutboundB.session, utf8ToBytesFor('real message'));

        // (1) Decrypting under the wrong (stale) cached session must fail
        // closed — never silently return the wrong plaintext.
        await expectLater(
          decryptMessage(bobInboundA, envelopeUnderB),
          throwsA(anything),
        );

        // (2) The exact fallback `decryptFromDevice` now performs: bootstrap a
        // fresh inbound session from this message's own x3dhInit, then retry.
        final recoveredSession = await createInboundSession(
          bob,
          bobSignedPreKey,
          bobOneTimePreKeys[1],
          aliceOutboundB.x3dhInit,
        );
        expect(
          await decryptMessage(recoveredSession, envelopeUnderB),
          equals(utf8ToBytesFor('real message')),
        );
      },
    );
  });
}

// Local helper — avoids pulling in crypto/encoding.dart's whole surface just for
// one conversion in this test file.
Uint8List utf8ToBytesFor(String s) => Uint8List.fromList(s.codeUnits);
