/// `GroupSessionDescriptor` is the small JSON payload that travels inside a 1:1
/// Double-Ratchet envelope to hand a group session's chain key to another device
/// (see features/groups/group_session_controller.dart's docstring) — a round-trip
/// bug here would silently corrupt every group's key distribution, so it gets its
/// own focused test independent of the full controller (which needs a live API
/// client/realtime socket to construct and isn't unit-testable in isolation).
library;

import 'dart:convert';
import 'package:flutter_test/flutter_test.dart';
import 'package:comm_mobile/features/groups/group_session_controller.dart';

void main() {
  group('GroupSessionDescriptor', () {
    test('round-trips through JSON exactly', () {
      const original = GroupSessionDescriptor(
        groupId: '11111111-1111-1111-1111-111111111111',
        epoch: 3,
        sessionId: 'c2Vzc2lvbi1pZA==',
        chainKey: 'Y2hhaW4ta2V5LWJ5dGVz',
        counter: 42,
      );

      final roundTripped = GroupSessionDescriptor.fromJson(
        jsonDecode(jsonEncode(original.toJson())) as Map<String, dynamic>,
      );

      expect(roundTripped.groupId, original.groupId);
      expect(roundTripped.epoch, original.epoch);
      expect(roundTripped.sessionId, original.sessionId);
      expect(roundTripped.chainKey, original.chainKey);
      expect(roundTripped.counter, original.counter);
    });
  });
}
