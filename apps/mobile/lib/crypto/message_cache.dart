/// The durable, local record of decrypted message history — trimmed port of
/// `apps/web/lib/crypto/message-cache.ts` to text/system messages only for this
/// pass (voice/image/generic-attachment caching is a follow-up — see
/// apps/mobile/README.md's milestone list; the *reason* this file has to exist at
/// all is identical for whichever content types it covers, see below).
///
/// Why this has to exist, not just be "nice to have": Double Ratchet message keys
/// are deleted immediately after a single use, so a ciphertext can only ever be
/// decrypted ONCE. The server's stored ciphertext is not a durable archive a client
/// can re-read from later — this local cache is. It also holds this device's OWN
/// sent messages, which could never be re-decrypted from stored ciphertext at all (a
/// sending chain is one-directional — the sender doesn't keep the keys either).
///
/// Wrapped under the same local KEK as identity/session data — plaintext message
/// content is exactly the kind of sensitive local data that must not sit around
/// unencrypted.
library;

import 'dart:convert';
import 'dart:typed_data';
import '../api/dtos.dart' show AttachmentDescriptor;
import 'encoding.dart';
import 'storage/wrap.dart';
import '../storage/blob_store.dart';

class CachedMessage {
  final String id;
  final String conversationId;
  final String senderUserId;
  final bool isOwn;
  final String contentTypeHint;
  final String text;
  final String sentAt;
  final String? replyToMessageId;
  /// Present when `contentTypeHint == 'media'` — the decrypted descriptor for a
  /// generic file attachment (see crypto/attachment_crypto.dart, api/media_api.dart).
  /// The actual bytes are fetched + decrypted on demand when the user taps
  /// Download, not eagerly.
  final AttachmentDescriptor? attachment;

  const CachedMessage({
    required this.id,
    required this.conversationId,
    required this.senderUserId,
    required this.isOwn,
    required this.contentTypeHint,
    required this.text,
    required this.sentAt,
    required this.replyToMessageId,
    this.attachment,
  });

  Map<String, dynamic> toJson() => {
    'id': id,
    'conversationId': conversationId,
    'senderUserId': senderUserId,
    'isOwn': isOwn,
    'contentTypeHint': contentTypeHint,
    'text': text,
    'sentAt': sentAt,
    'replyToMessageId': replyToMessageId,
    if (attachment != null) 'attachment': attachment!.toJson(),
  };

  static CachedMessage fromJson(Map<String, dynamic> json) => CachedMessage(
    id: json['id'] as String,
    conversationId: json['conversationId'] as String,
    senderUserId: json['senderUserId'] as String,
    isOwn: json['isOwn'] as bool,
    contentTypeHint: json['contentTypeHint'] as String,
    text: json['text'] as String,
    sentAt: json['sentAt'] as String,
    replyToMessageId: json['replyToMessageId'] as String?,
    attachment: json['attachment'] != null ? AttachmentDescriptor.fromJson(json['attachment'] as Map<String, dynamic>) : null,
  );
}

/// Bounds how much history is kept per conversation locally — this is a cache, not
/// the durable server-side record of the *encrypted* history; older plaintext falls
/// out of it and in practice cannot be recovered (the ratchet message key it was
/// decrypted with is long gone by then) — same tradeoff the web client's
/// forward-secrecy design accepts.
const _maxCachedPerConversation = 500;

String _cacheKey(String conversationId) => 'msgcache:$conversationId';

Future<List<CachedMessage>> loadCachedMessages(Uint8List kek, String conversationId) async {
  final wrapped = await getBlob(_cacheKey(conversationId));
  if (wrapped == null) return [];
  try {
    final plaintext = await unwrapBytes(kek, wrapped);
    final list = jsonDecode(bytesToUtf8(plaintext)) as List;
    return list.map((e) => CachedMessage.fromJson(e as Map<String, dynamic>)).toList();
  } catch (_) {
    // A KEK mismatch (password changed elsewhere) is not a reason to crash the chat
    // UI — same reasoning as sessions.dart#loadSession. The cache is just empty
    // until new messages repopulate it.
    return [];
  }
}

Future<void> appendCachedMessage(Uint8List kek, CachedMessage message) async {
  final existing = await loadCachedMessages(kek, message.conversationId);
  if (existing.any((m) => m.id == message.id)) return; // idempotent — a duplicate WS/REST delivery is a no-op
  final updated = [...existing, message];
  final trimmed = updated.length > _maxCachedPerConversation
      ? updated.sublist(updated.length - _maxCachedPerConversation)
      : updated;
  final json = jsonEncode(trimmed.map((m) => m.toJson()).toList());
  await putBlob(_cacheKey(message.conversationId), await wrapBytes(kek, utf8ToBytes(json)));
}
