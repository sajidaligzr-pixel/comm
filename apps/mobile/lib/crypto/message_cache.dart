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
import '../storage/blob_store.dart' show deleteBlob, getBlob, putBlob;

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

  /// Present when `contentTypeHint == 'voice'` — the raw decrypted audio bytes,
  /// base64-encoded for storage in this JSON-backed cache. Mirrors apps/web's
  /// own `CachedMessage.mediaBase64` (lib/crypto/message-cache.ts) exactly: a
  /// voice note travels inline through the same E2E envelope text does (no
  /// object storage — see thread_screen.dart's recording docstring), and
  /// Double Ratchet message keys are single-use, so this IS the durable copy;
  /// there's no ciphertext left on the server to re-derive it from later.
  final String? mediaBase64;

  /// Local-only duration hint for a voice note THIS device just recorded —
  /// known immediately from the recording itself, shown before the audio
  /// player has loaded real metadata. Never transmitted to the server (not a
  /// `SendMessageRequest` field on either client) — a receiving device simply
  /// doesn't have this until its own player loads the audio, same as web.
  final int? mediaDurationSec;

  /// Tombstone fields — mirrors apps/web's own `CachedMessage.deleted`/
  /// `deletedReason` (lib/crypto/message-cache.ts) exactly, including WHY
  /// these are local-only, never part of the wire `MessageDto`: the server's
  /// `listMessages` filters `deletedAt: null` (server/modules/messages/
  /// service.ts), so a deleted message is simply absent from a fresh history
  /// fetch — it never comes back with a "deleted" flag to react to. This
  /// cache is the only place a tombstone placeholder can be shown at all: for
  /// this device's OWN delete action (applied immediately, optimistically —
  /// see thread_screen.dart's `_confirmAndDelete`) or a live `deleted` WS
  /// event from another member's device. A device that was offline when a
  /// deletion happened has no catch-up path for it — same accepted gap as
  /// apps/web; there is no "list of recently deleted message ids" endpoint.
  final bool deleted;
  final String? deletedReason;

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
    this.mediaBase64,
    this.mediaDurationSec,
    this.deleted = false,
    this.deletedReason,
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
    if (mediaBase64 != null) 'mediaBase64': mediaBase64,
    if (mediaDurationSec != null) 'mediaDurationSec': mediaDurationSec,
    if (deleted) 'deleted': deleted,
    if (deletedReason != null) 'deletedReason': deletedReason,
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
    attachment: json['attachment'] != null
        ? AttachmentDescriptor.fromJson(
            json['attachment'] as Map<String, dynamic>,
          )
        : null,
    deleted: json['deleted'] as bool? ?? false,
    deletedReason: json['deletedReason'] as String?,
    mediaBase64: json['mediaBase64'] as String?,
    mediaDurationSec: json['mediaDurationSec'] as int?,
  );
}

/// Bounds how much history is kept per conversation locally — this is a cache, not
/// the durable server-side record of the *encrypted* history; older plaintext falls
/// out of it and in practice cannot be recovered (the ratchet message key it was
/// decrypted with is long gone by then) — same tradeoff the web client's
/// forward-secrecy design accepts.
const _maxCachedPerConversation = 500;

String _cacheKey(String conversationId) => 'msgcache:$conversationId';

Future<List<CachedMessage>> loadCachedMessages(
  Uint8List kek,
  String conversationId,
) async {
  final wrapped = await getBlob(_cacheKey(conversationId));
  if (wrapped == null) return [];
  try {
    final plaintext = await unwrapBytes(kek, wrapped);
    final list = jsonDecode(bytesToUtf8(plaintext)) as List;
    return list
        .map((e) => CachedMessage.fromJson(e as Map<String, dynamic>))
        .toList();
  } catch (_) {
    // A KEK mismatch (password changed elsewhere) is not a reason to crash the chat
    // UI — same reasoning as sessions.dart#loadSession. The cache is just empty
    // until new messages repopulate it.
    return [];
  }
}

Future<void> appendCachedMessage(Uint8List kek, CachedMessage message) async {
  final existing = await loadCachedMessages(kek, message.conversationId);
  if (existing.any((m) => m.id == message.id)) {
    return; // idempotent — a duplicate WS/REST delivery is a no-op
  }
  final updated = [...existing, message];
  final trimmed = updated.length > _maxCachedPerConversation
      ? updated.sublist(updated.length - _maxCachedPerConversation)
      : updated;
  final json = jsonEncode(trimmed.map((m) => m.toJson()).toList());
  await putBlob(
    _cacheKey(message.conversationId),
    await wrapBytes(kek, utf8ToBytes(json)),
  );
}

/// Bulk variant of [appendCachedMessage] — reads the existing cache ONCE, appends
/// every not-already-present message in [messages], and writes back ONCE.
/// thread_screen.dart's `_load()` uses this for its history catch-up instead of
/// calling [appendCachedMessage] once per message: that per-message version reads
/// + decrypts + JSON-decodes the WHOLE cached list, then re-encodes + re-encrypts
/// + rewrites the WHOLE thing, on every single call — O(n) work repeated n times
/// (O(n²) total) for a conversation with n messages to catch up on. Found live as
/// a real, measurable contributor to "opening a chat takes a while" — every
/// message secure-storage read/write pays real Keystore/Keychain overhead, not
/// just plain file I/O. A single live incoming message (features/chats/
/// thread_screen.dart's `_onRealtimeNew`) still goes through the one-at-a-time
/// [appendCachedMessage] — there's nothing to batch when there's only one.
Future<void> appendCachedMessages(
  Uint8List kek,
  String conversationId,
  List<CachedMessage> messages,
) async {
  if (messages.isEmpty) return;
  final existing = await loadCachedMessages(kek, conversationId);
  final existingIds = existing.map((m) => m.id).toSet();
  final additions = messages.where((m) => !existingIds.contains(m.id));
  final updated = [...existing, ...additions];
  final trimmed = updated.length > _maxCachedPerConversation
      ? updated.sublist(updated.length - _maxCachedPerConversation)
      : updated;
  final json = jsonEncode(trimmed.map((m) => m.toJson()).toList());
  await putBlob(
    _cacheKey(conversationId),
    await wrapBytes(kek, utf8ToBytes(json)),
  );
}

/// Rolls back an optimistically-rendered outgoing message (thread_screen.dart's
/// `_sendEnvelope`) if the send actually fails server-side — mirrors
/// apps/web/lib/crypto/message-cache.ts's `removeCachedMessage` exactly, same
/// reasoning: the message was appended to the local cache the instant it was
/// encrypted, before the network round trip even started, so a failure needs an
/// explicit way to take it back out again.
Future<void> removeCachedMessage(
  Uint8List kek,
  String conversationId,
  String messageId,
) async {
  final existing = await loadCachedMessages(kek, conversationId);
  final updated = existing.where((m) => m.id != messageId).toList();
  if (updated.length == existing.length) return; // nothing to remove
  final json = jsonEncode(updated.map((m) => m.toJson()).toList());
  await putBlob(
    _cacheKey(conversationId),
    await wrapBytes(kek, utf8ToBytes(json)),
  );
}

/// Tombstones a message locally — mirrors apps/web's own `markCachedMessageDeleted`
/// (lib/crypto/message-cache.ts) exactly: clears `text`/`mediaBase64`/`attachment`
/// (the whole point of "delete for everyone" is that the content itself is gone,
/// not just hidden) and sets `deleted`/`deletedReason`, leaving everything else
/// (id, sentAt, isOwn, replyToMessageId — so a reply pointing at this message can
/// still resolve it and show the tombstone text) intact. A no-op, returning the
/// list unchanged, if the message isn't cached on this device at all (e.g. it was
/// deleted before this device ever decrypted it). Returns the whole updated list
/// so the caller can `setState` directly with it, same shape web returns.
///
/// Same read-modify-write-the-whole-blob shape every function in this file uses —
/// no per-conversation lock exists here (unlike web's `withConversationLock`), so
/// a delete racing a live incoming message for the exact same conversation at the
/// exact same instant could in principle clobber one or the other. Not solved in
/// this pass; flagged rather than silently accepted, matching every other function
/// in this file's own scope.
Future<List<CachedMessage>> markCachedMessageDeleted(
  Uint8List kek,
  String conversationId,
  String messageId,
  String reason,
) async {
  final existing = await loadCachedMessages(kek, conversationId);
  if (!existing.any((m) => m.id == messageId)) return existing;
  final updated = existing
      .map(
        (m) => m.id == messageId
            ? CachedMessage(
                id: m.id,
                conversationId: m.conversationId,
                senderUserId: m.senderUserId,
                isOwn: m.isOwn,
                contentTypeHint: m.contentTypeHint,
                text: '',
                sentAt: m.sentAt,
                replyToMessageId: m.replyToMessageId,
                deleted: true,
                deletedReason: reason,
              )
            : m,
      )
      .toList();
  final json = jsonEncode(updated.map((m) => m.toJson()).toList());
  await putBlob(
    _cacheKey(conversationId),
    await wrapBytes(kek, utf8ToBytes(json)),
  );
  return updated;
}

/// "Delete chat" (chats_list_screen.dart's long-press menu) — wipes this device's
/// own local decrypted history for one conversation. Deliberately NOT a server-side
/// delete: no such route exists (only `archived`, a per-caller view preference —
/// see conversations_api.dart), and WhatsApp's own "Delete chat" has the same
/// scope: it clears your device's view, not the other person's copy, and the
/// conversation reappears if they message you again. Since a Double Ratchet
/// ciphertext can only ever be decrypted once (this cache's own docstring above),
/// this history is not recoverable afterward even from the server's stored
/// ciphertext.
Future<void> clearCachedMessages(String conversationId) =>
    deleteBlob(_cacheKey(conversationId));
