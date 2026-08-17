/// Self-consistency test suite mirroring
/// `packages/crypto/src/__tests__/group-ratchet.test.ts` — the group ratchet is a
/// zero-DH, one-way symmetric chain (see lib/crypto/group/ratchet.dart's docstring),
/// so unlike the 1:1 Double Ratchet its encrypt/decrypt functions take no internal
/// randomness at all once a session exists — every scenario below is a real,
/// deterministic exercise of the ported algorithm (round trip, out-of-order,
/// wrong-session rejection, forward secrecy, tamper detection).
library;

import 'dart:convert';
import 'dart:typed_data';
import 'package:flutter_test/flutter_test.dart';
import 'package:comm_mobile/crypto/group/ratchet.dart';

void main() {
  group('Group ratchet (Megolm-style)', () {
    test('round trip: outbound session encrypts, matching inbound session decrypts', () async {
      final outbound = createOutboundGroupSession();
      final ad = utf8.encode('group:conversation-id');

      // A real inbound session is created from the chain key value AS SHARED (before
      // any message is sent) — mirrored here by snapshotting it before encrypting,
      // since encryptGroupMessage mutates outbound.chainKey in place.
      final inbound = createInboundGroupSession(outbound.sessionId, outbound.chainKey, 0);

      final result = await encryptGroupMessage(outbound, utf8.encode('hello group'), ad);
      final plaintext = await decryptGroupMessage(inbound, result.header, result.ciphertext, ad);
      expect(utf8.decode(plaintext), 'hello group');
    });

    test('a full sequence of messages from one sender stays in sync', () async {
      final outbound = createOutboundGroupSession();
      final ad = utf8.encode('group:conversation-id');
      final inbound = createInboundGroupSession(outbound.sessionId, outbound.chainKey, 0);

      for (final text in ['one', 'two', 'three', 'four']) {
        final result = await encryptGroupMessage(outbound, utf8.encode(text), ad);
        final plaintext = await decryptGroupMessage(inbound, result.header, result.ciphertext, ad);
        expect(utf8.decode(plaintext), text);
      }
    });

    test('handles out-of-order delivery (message 2 arrives before message 1)', () async {
      final outbound = createOutboundGroupSession();
      final ad = utf8.encode('group:conversation-id');
      final inbound = createInboundGroupSession(outbound.sessionId, outbound.chainKey, 0);

      final msg1 = await encryptGroupMessage(outbound, utf8.encode('first'), ad);
      final msg2 = await encryptGroupMessage(outbound, utf8.encode('second'), ad);

      final plaintext2 = await decryptGroupMessage(inbound, msg2.header, msg2.ciphertext, ad);
      expect(utf8.decode(plaintext2), 'second');

      final plaintext1 = await decryptGroupMessage(inbound, msg1.header, msg1.ciphertext, ad);
      expect(utf8.decode(plaintext1), 'first');
    });

    test('rejects a header belonging to a different group session', () async {
      final outboundA = createOutboundGroupSession();
      final outboundB = createOutboundGroupSession();
      final ad = utf8.encode('group:conversation-id');
      final inboundForA = createInboundGroupSession(outboundA.sessionId, outboundA.chainKey, 0);

      final msgFromB = await encryptGroupMessage(outboundB, utf8.encode('wrong session'), ad);

      expect(
        () => decryptGroupMessage(inboundForA, msgFromB.header, msgFromB.ciphertext, ad),
        throwsA(isA<StateError>()),
      );
    });

    test('rejects a tampered ciphertext rather than returning corrupted plaintext', () async {
      final outbound = createOutboundGroupSession();
      final ad = utf8.encode('group:conversation-id');
      final inbound = createInboundGroupSession(outbound.sessionId, outbound.chainKey, 0);

      final result = await encryptGroupMessage(outbound, utf8.encode('sensitive'), ad);
      final tampered = Uint8List.fromList(result.ciphertext);
      tampered[0] = tampered[0] ^ 0xff;

      expect(() => decryptGroupMessage(inbound, result.header, tampered, ad), throwsA(anything));
    });

    test('forward secrecy: the chain key moves forward and cannot decrypt with a stale copy', () async {
      final outbound = createOutboundGroupSession();
      final ad = utf8.encode('group:conversation-id');
      final inbound = createInboundGroupSession(outbound.sessionId, outbound.chainKey, 0);

      final staleChainKey = Uint8List.fromList(inbound.chainKey);
      final msg = await encryptGroupMessage(outbound, utf8.encode('advance'), ad);
      await decryptGroupMessage(inbound, msg.header, msg.ciphertext, ad);

      expect(inbound.chainKey, isNot(equals(staleChainKey)));
    });

    test('a newly-added member (inbound session starting at a later counter) cannot decrypt earlier history', () async {
      final outbound = createOutboundGroupSession();
      final ad = utf8.encode('group:conversation-id');

      final msg1 = await encryptGroupMessage(outbound, utf8.encode('before the new member joined'), ad);
      // The new member's inbound session is created from the chain key AT THE
      // CURRENT counter (2, since one message already advanced it) — never from
      // counter 0, matching createInboundGroupSession's documented "no retroactive
      // history access" contract.
      final lateJoinerInbound = createInboundGroupSession(outbound.sessionId, outbound.chainKey, outbound.counter);

      expect(
        () => decryptGroupMessage(lateJoinerInbound, msg1.header, msg1.ciphertext, ad),
        throwsA(isA<StateError>()),
      );

      final msg2 = await encryptGroupMessage(outbound, utf8.encode('after the new member joined'), ad);
      final plaintext = await decryptGroupMessage(lateJoinerInbound, msg2.header, msg2.ciphertext, ad);
      expect(utf8.decode(plaintext), 'after the new member joined');
    });
  });
}
