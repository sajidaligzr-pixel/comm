/// Per-remote-device Double Ratchet session storage — direct port of
/// `apps/web/lib/crypto/sessions.ts`. Wrapped under the same local KEK as the device
/// identity; the caller supplies that KEK rather than this module re-deriving it.
library;

import 'dart:convert';
import 'dart:typed_data';
import 'encoding.dart';
import 'session/session.dart';
import 'storage/wrap.dart';
import '../storage/blob_store.dart';

String _sessionStorageKey(String remoteDeviceId) => 'session:$remoteDeviceId';

Future<void> saveSession(Uint8List kek, String remoteDeviceId, Session session) async {
  final json = jsonEncode(serializeSession(session).toJson());
  final wrapped = await wrapBytes(kek, utf8ToBytes(json));
  await putBlob(_sessionStorageKey(remoteDeviceId), wrapped);
}

/// Returns `null` (not a thrown error) if unwrapping fails — a KEK mismatch (a
/// password change, most concretely) leaves an old cached session permanently
/// unreadable; the caller's existing `if (session == null)` branch re-runs X3DH and
/// starts a fresh one, same recovery `local_identity.dart`/`message_cache.dart` apply
/// to the same class of failure.
Future<Session?> loadSession(Uint8List kek, String remoteDeviceId) async {
  final wrapped = await getBlob(_sessionStorageKey(remoteDeviceId));
  if (wrapped == null) return null;
  try {
    final plaintext = await unwrapBytes(kek, wrapped);
    return deserializeSession(SerializedSession.fromJson(jsonDecode(bytesToUtf8(plaintext)) as Map<String, dynamic>));
  } catch (_) {
    return null;
  }
}

Future<void> deleteSession(String remoteDeviceId) async {
  await deleteBlob(_sessionStorageKey(remoteDeviceId));
}
