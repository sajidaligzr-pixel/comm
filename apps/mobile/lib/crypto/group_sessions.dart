/// Local storage for group ratchet state — direct port of
/// `apps/web/lib/crypto/group-sessions.ts`. One OUTBOUND session per group this
/// device is a member of. One INBOUND session per *other member* per group, keyed by
/// `(groupId, senderUserId)` — see that file's docstring for why it's keyed by
/// sender identity, not device.
library;

import 'dart:convert';
import 'dart:typed_data';
import 'encoding.dart';
import 'group/ratchet.dart';
import 'group/serialization.dart';
import 'storage/wrap.dart';
import '../storage/blob_store.dart';

String _outboundKey(String groupId) => 'group-outbound:$groupId';
String _inboundKey(String groupId, String senderUserId) => 'group-inbound:$groupId:$senderUserId';

Future<void> saveOutboundGroupSession(Uint8List kek, String groupId, GroupOutboundSession session) async {
  final json = jsonEncode(serializeGroupOutboundSession(session).toJson());
  await putBlob(_outboundKey(groupId), await wrapBytes(kek, utf8ToBytes(json)));
}

/// Same "return null, don't throw" reasoning as `sessions.dart#loadSession`.
Future<GroupOutboundSession?> loadOutboundGroupSession(Uint8List kek, String groupId) async {
  final wrapped = await getBlob(_outboundKey(groupId));
  if (wrapped == null) return null;
  try {
    final plaintext = await unwrapBytes(kek, wrapped);
    return deserializeGroupOutboundSession(
      SerializedGroupOutboundSession.fromJson(jsonDecode(bytesToUtf8(plaintext)) as Map<String, dynamic>),
    );
  } catch (_) {
    return null;
  }
}

Future<void> saveInboundGroupSession(Uint8List kek, String groupId, String senderUserId, GroupInboundSession session) async {
  final json = jsonEncode(serializeGroupInboundSession(session).toJson());
  await putBlob(_inboundKey(groupId, senderUserId), await wrapBytes(kek, utf8ToBytes(json)));
}

Future<GroupInboundSession?> loadInboundGroupSession(Uint8List kek, String groupId, String senderUserId) async {
  final wrapped = await getBlob(_inboundKey(groupId, senderUserId));
  if (wrapped == null) return null;
  try {
    final plaintext = await unwrapBytes(kek, wrapped);
    return deserializeGroupInboundSession(
      SerializedGroupInboundSession.fromJson(jsonDecode(bytesToUtf8(plaintext)) as Map<String, dynamic>),
    );
  } catch (_) {
    return null;
  }
}
