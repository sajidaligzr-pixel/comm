/// The group-chat analog of `features/calls/call_controller.dart` — direct port of
/// `apps/web/components/group/group-session-provider.tsx`: owns everything about
/// group Megolm-style session lifecycle (creation, key distribution, epoch rotation
/// on removal), so `ThreadScreen` only ever calls `encryptForGroup`/
/// `decryptGroupMessageOnce` and never touches ratchet state directly.
///
/// Everything here rides the EXISTING 1:1 Double Ratchet (`conversation_crypto.dart`)
/// to move group session key material between devices — zero changes needed to that
/// code, confirmed reusable as-is (same as the TS original's own design note).
library;

import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import '../../api/dtos.dart';
import '../../api/groups_api.dart';
import '../../api/keys_api.dart';
import '../../crypto/conversation_crypto.dart' as convo;
import '../../crypto/encoding.dart';
import '../../crypto/group/ratchet.dart';
import '../../crypto/group_sessions.dart';
import '../../crypto/kek_holder.dart';
import '../../crypto/session/session.dart' show MessageEnvelope;
import '../../realtime/ws_client.dart';

class GroupSessionDescriptor {
  final String groupId;
  final int epoch;
  final String sessionId; // base64
  final String chainKey; // base64
  final int counter;
  const GroupSessionDescriptor({required this.groupId, required this.epoch, required this.sessionId, required this.chainKey, required this.counter});

  Map<String, dynamic> toJson() => {'groupId': groupId, 'epoch': epoch, 'sessionId': sessionId, 'chainKey': chainKey, 'counter': counter};
  static GroupSessionDescriptor fromJson(Map<String, dynamic> json) => GroupSessionDescriptor(
    groupId: json['groupId'] as String,
    epoch: json['epoch'] as int,
    sessionId: json['sessionId'] as String,
    chainKey: json['chainKey'] as String,
    counter: json['counter'] as int,
  );
}

Uint8List _associatedDataFor(String groupId, String senderUserId) => utf8ToBytes('group:$groupId:$senderUserId');

class EncryptedGroupEnvelope {
  final String header; // base64
  final String ciphertext; // base64
  const EncryptedGroupEnvelope({required this.header, required this.ciphertext});
}

class GroupSessionController {
  GroupSessionController({required this.groupsApi, required this.keysApi, required this.realtime});

  final GroupsApi groupsApi;
  final KeysApi keysApi;
  final RealtimeClient realtime;

  /// groupId -> last-known member user ids, used purely to diff an incoming
  /// `group.members-changed` event into "who got added" vs. "who got removed" (the
  /// event itself only says "something changed," not what).
  final Map<String, Set<String>> _knownMembers = {};

  /// A per-key promise-chain mutex — every load-mutate-save for the same
  /// `outbound:<groupId>` or `inbound:<groupId>:<senderUserId>` chain runs one at a
  /// time, in arrival order, each seeing the previous one's actual result. Without
  /// this, two messages from the same sender arriving close together would both load
  /// the same starting ratchet state and independently advance their own in-memory
  /// copy — whichever save wins overwrites the other's advance rather than the two
  /// composing, corrupting real ratchet state (not just a UI desync), See the TS
  /// original's docstring for the full incident this closes.
  final Map<String, Future<void>> _locks = {};

  Future<T> _withLock<T>(String key, Future<T> Function() run) async {
    final prior = _locks[key] ?? Future.value();
    final resultFuture = prior.then((_) => run(), onError: (_) => run());
    // A rejection must never wedge the queue for later callers — chain a
    // swallowed-error tracker for scheduling purposes only, never awaited by callers.
    final queued = resultFuture.then((_) {}, onError: (_) {});
    _locks[key] = queued;
    unawaited(queued.then((_) {
      if (identical(_locks[key], queued)) _locks.remove(key);
    }));
    return resultFuture;
  }

  Future<void> _shareSessionTo(String groupId, int epoch, GroupOutboundSession session, List<GroupMemberTarget> targets) async {
    final descriptor = GroupSessionDescriptor(
      groupId: groupId,
      epoch: epoch,
      sessionId: bytesToBase64(session.sessionId),
      chainKey: bytesToBase64(session.chainKey),
      counter: session.counter,
    );
    final plaintext = utf8ToBytes(jsonEncode(descriptor.toJson()));
    for (final target in targets) {
      try {
        final outgoing = await convo.encryptForDevice(keysApi, target.userId, target.deviceId, plaintext);
        final envelope = MessageEnvelopeUpload(header: outgoing.envelope.header, ciphertext: outgoing.envelope.ciphertext);
        await groupsApi.sendKeyShare(groupId, epoch, target.deviceId, envelope, outgoing.x3dhInit);
      } catch (_) {
        // One member's device being briefly unreachable shouldn't abort sharing with
        // everyone else.
      }
    }
  }

  Future<GroupOutboundSession> _createAndShareNewOutboundSession(String groupId) async {
    final kek = getCurrentKek();
    if (kek == null) throw StateError('This device is locked. Please sign in again.');
    final session = createOutboundGroupSession();
    await saveOutboundGroupSession(kek, groupId, session);
    final targets = await groupsApi.memberDevices(groupId);
    // Epoch is server-side bookkeeping only — the client doesn't need to track it
    // precisely to redistribute correctly, since inbound sessions key off sessionId,
    // not epoch number. 0 is a placeholder carried along for observability.
    await _shareSessionTo(groupId, 0, session, targets);
    return session;
  }

  Future<EncryptedGroupEnvelope> encryptForGroup(String groupId, String currentUserId, Uint8List plaintext) {
    return _withLock('outbound:$groupId', () async {
      final kek = getCurrentKek();
      if (kek == null) throw StateError('This device is locked. Please sign in again.');
      var session = await loadOutboundGroupSession(kek, groupId);
      session ??= await _createAndShareNewOutboundSession(groupId);

      final result = await encryptGroupMessage(session, plaintext, _associatedDataFor(groupId, currentUserId));
      await saveOutboundGroupSession(kek, groupId, session);
      return EncryptedGroupEnvelope(header: bytesToBase64(encodeGroupHeader(result.header)), ciphertext: bytesToBase64(result.ciphertext));
    });
  }

  Future<Uint8List> _decryptGroupMessageUnmemoized(String groupId, String senderUserId, EncryptedGroupEnvelope envelope) {
    return _withLock('inbound:$groupId:$senderUserId', () async {
      final kek = getCurrentKek();
      if (kek == null) throw StateError('This device is locked. Please sign in again.');
      final session = await loadInboundGroupSession(kek, groupId, senderUserId);
      if (session == null) throw StateError('No group session yet for this sender.');

      final header = decodeGroupHeader(base64ToBytes(envelope.header));
      final plaintext = await decryptGroupMessage(session, header, base64ToBytes(envelope.ciphertext), _associatedDataFor(groupId, senderUserId));
      await saveInboundGroupSession(kek, groupId, senderUserId, session);
      return plaintext;
    });
  }

  /// Memoized by `messageId` — a mount-time catch-up effect firing twice (or a
  /// sidebar preview and an open thread both reacting to the same event) must not
  /// decrypt the SAME group message twice: the one-way group ratchet has no way to
  /// tell "the same logical decrypt, called again" from a genuine replay, so a
  /// second call legitimately fails once the first has advanced past that counter.
  final Map<String, Future<Uint8List>> _inFlightDecrypts = {};
  static const Duration _decryptMemoTtl = Duration(seconds: 10);

  Future<Uint8List> decryptGroupMessageOnce(String messageId, String groupId, String senderUserId, EncryptedGroupEnvelope envelope) {
    final existing = _inFlightDecrypts[messageId];
    if (existing != null) return existing;
    final future = _decryptGroupMessageUnmemoized(groupId, senderUserId, envelope);
    _inFlightDecrypts[messageId] = future;
    void evict() {
      Timer(_decryptMemoTtl, () {
        if (identical(_inFlightDecrypts[messageId], future)) _inFlightDecrypts.remove(messageId);
      });
    }

    future.then((_) => evict(), onError: (_) => evict());
    return future;
  }

  /// Fetches + applies any pending key shares for this group (REST catch-up) — call
  /// on group-thread mount/reconnect and whenever a `group.key-share` ping arrives.
  Future<void> ensureGroupKeysUpToDate(String groupId) async {
    final kek = getCurrentKek();
    if (kek == null) return;
    List<GroupKeyShareDto> shares;
    try {
      shares = await groupsApi.listKeyShares(groupId);
    } catch (_) {
      return;
    }

    for (final share in shares) {
      try {
        final envelope = MessageEnvelope(header: share.envelope.header, ciphertext: share.envelope.ciphertext);
        final plaintext = await convo.decryptFromDeviceOnce(share.id, share.fromDeviceId, envelope, share.x3dhInit);
        final descriptor = GroupSessionDescriptor.fromJson(jsonDecode(bytesToUtf8(plaintext)) as Map<String, dynamic>);

        // Same lock key `_decryptGroupMessageUnmemoized` uses for this
        // (groupId, senderUserId) pair — a key-share and an actual incoming message
        // from that same sender racing each other for the same inbound-session slot
        // must serialize against each other, not just against themselves.
        await _withLock('inbound:$groupId:${share.fromUserId}', () async {
          final existing = await loadInboundGroupSession(kek, groupId, share.fromUserId);
          if (existing != null && bytesToBase64(existing.sessionId) == descriptor.sessionId) {
            return; // already have this exact session (possibly further advanced) — never regress it
          }
          final inbound = createInboundGroupSession(base64ToBytes(descriptor.sessionId), base64ToBytes(descriptor.chainKey), descriptor.counter);
          await saveInboundGroupSession(kek, groupId, share.fromUserId, inbound);
        });
      } catch (_) {
        // Skipped rather than aborting the rest of the batch — GET .../key-shares
        // marks a row consumed the moment it's fetched, so a share that fails to
        // apply here won't be re-delivered (an honest limitation, not silently
        // hidden).
      }
    }
  }

  /// Seeds this group's known-member baseline so the next `group.members-changed`
  /// event can correctly diff "who was added vs. removed" — call once when a group
  /// thread mounts, before relying on live rotation/redistribution.
  Future<void> registerGroupMembership(String groupId) async {
    if (_knownMembers.containsKey(groupId)) return;
    try {
      final summary = await groupsApi.get(groupId);
      _knownMembers[groupId] = summary.members.map((m) => m.userId).toSet();
    } catch (_) {
      // Not (or no longer) a member, or a transient failure — nothing to seed; the
      // next successful call will seed it.
    }
  }

  void Function(Map<String, dynamic>)? _onKeyShareListener;
  void Function(Map<String, dynamic>)? _onMembersChangedListener;
  String? _currentUserId;

  /// Must be called once, after `currentUserId` is known (post-login) — mirrors the
  /// TS provider's `currentUserId` prop, threaded in at construction time there
  /// since it's a React component; here it's set explicitly since the controller is
  /// constructed once for the app's lifetime, before login necessarily completes.
  void start() {
    _onKeyShareListener = (payload) {
      final groupId = payload['groupId'] as String?;
      if (groupId != null) unawaited(ensureGroupKeysUpToDate(groupId));
    };
    _onMembersChangedListener = (payload) => unawaited(_handleMembersChanged(payload));
    realtime.on('group.key-share', _onKeyShareListener!);
    realtime.on('group.members-changed', _onMembersChangedListener!);
  }

  void setCurrentUserId(String userId) => _currentUserId = userId;

  Future<void> _handleMembersChanged(Map<String, dynamic> payload) async {
    final groupId = payload['groupId'] as String?;
    if (groupId == null) return;
    final previous = _knownMembers[groupId];

    GroupSummary summary;
    try {
      summary = await groupsApi.get(groupId);
    } catch (_) {
      // Most likely: this device's own membership was just removed — nothing to
      // redistribute since we can no longer participate.
      return;
    }
    final current = summary.members.map((m) => m.userId).toSet();
    _knownMembers[groupId] = current;
    if (previous == null) return; // first observation — nothing to diff against yet

    final removed = previous.difference(current);
    final added = current.difference(previous)..remove(_currentUserId);

    final kek = getCurrentKek();
    if (kek == null) return;

    if (removed.isNotEmpty) {
      // A member was removed — rotate to a fresh outbound session and redistribute
      // to everyone CURRENTLY in the group, excluding the removed member from all
      // future key distribution by construction (they simply never receive this new
      // session).
      await _createAndShareNewOutboundSession(groupId);
    } else if (added.isNotEmpty) {
      // A member was added — share the CURRENT session (not a new one) with only
      // the new member's device, going forward only (no retroactive history access).
      final existing = await loadOutboundGroupSession(kek, groupId);
      if (existing == null) return; // nothing sent yet in this group from this device
      final allTargets = await groupsApi.memberDevices(groupId);
      final newTargets = allTargets.where((t) => added.contains(t.userId)).toList();
      await _shareSessionTo(groupId, 0, existing, newTargets);
    }
  }

  void dispose() {
    if (_onKeyShareListener != null) realtime.off('group.key-share', _onKeyShareListener!);
    if (_onMembersChangedListener != null) realtime.off('group.members-changed', _onMembersChangedListener!);
  }
}
