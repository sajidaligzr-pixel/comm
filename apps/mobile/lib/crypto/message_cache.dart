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
/// Backed by `message_db.dart`'s SQLite store (see that file's own docstring for
/// why — this used to be one `flutter_secure_storage` blob per conversation,
/// found live to be the real cause of "opening a big chat takes a while"), one
/// row per message. Each row's `ciphertext` column is this same message's full
/// JSON, wrapped under the same local KEK as identity/session data — plaintext
/// message content is exactly the kind of sensitive local data that must not sit
/// around unencrypted. Only `id`/`conversationId`/`sentAt` are plaintext SQL
/// columns (needed to query/order/index at all), mirroring the server's own
/// Message table's already-accepted metadata-visible/content-encrypted split
/// (docs/02-database-schema.md) — not a new exposure.
library;

import 'dart:convert';
import 'dart:typed_data';
import 'package:flutter/foundation.dart' show debugPrint;
import 'package:sqlite3/sqlite3.dart';
import '../api/dtos.dart' show AttachmentDescriptor;
import 'encoding.dart';
import 'storage/wrap.dart';
import '../storage/blob_store.dart'
    show getBlob, putBlob, deleteBlob, readAllBlobsWithPrefix;
import '../storage/message_db.dart'
    show messageDb, insertMessageSql, loadMessagesSql, trimMessagesSql;

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

  /// Last-known delivered/read state for THIS device's own sent message —
  /// persisted here (unlike thread_screen.dart's own `_status` map, which is
  /// deliberately ephemeral/re-seeded-from-the-server-on-load, same design as
  /// apps/web's message-thread.tsx) specifically so a fresh screen mount can
  /// render the correct tick INSTANTLY from the cache, before the REST re-fetch
  /// that reseeds `_status` has even resolved. Found live as the reported bug:
  /// navigating away and back showed a message regress from a double tick back
  /// to a single one for the length of that reload, self-correcting only once
  /// the REST fetch caught up (or never, if that fetch's result was read before
  /// this device's own write of it landed) — meaningless for anyone who didn't
  /// wait around, but a real, confusing regression for anyone who did. Meaning
  /// only for a message `isOwn` — never set for anyone else's, same reasoning
  /// `_status` itself only ever tracks this device's own sends.
  final bool delivered;
  final bool read;

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
    this.delivered = false,
    this.read = false,
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
    if (delivered) 'delivered': delivered,
    if (read) 'read': read,
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
    delivered: json['delivered'] as bool? ?? false,
    read: json['read'] as bool? ?? false,
  );
}

/// Bounds how much history is kept per conversation locally — this is a cache, not
/// the durable server-side record of the *encrypted* history; older plaintext falls
/// out of it and in practice cannot be recovered (the ratchet message key it was
/// decrypted with is long gone by then) — same tradeoff the web client's
/// forward-secrecy design accepts.
const _maxCachedPerConversation = 500;

Future<CachedMessage> _decodeRow(Uint8List kek, Uint8List ciphertext) async {
  final plaintext = await unwrapBytes(kek, ciphertext);
  return CachedMessage.fromJson(
    jsonDecode(bytesToUtf8(plaintext)) as Map<String, dynamic>,
  );
}

Future<Uint8List> _encodeMessage(Uint8List kek, CachedMessage message) =>
    wrapBytes(kek, utf8ToBytes(jsonEncode(message.toJson())));

/// Deletes the oldest rows for [conversationId] beyond [_maxCachedPerConversation]
/// — a single indexed statement, not a read-modify-write of anything.
void _trim(Database db, String conversationId) {
  db.execute(
    trimMessagesSql,
    [conversationId, _maxCachedPerConversation],
  );
}

Future<List<CachedMessage>> loadCachedMessages(
  Uint8List kek,
  String conversationId,
) async {
  // TEMPORARY diagnostic — see message_db.dart's own note on why. Breaks the
  // total down into "open db" (already timed separately in messageDb()),
  // "run the query," and "decrypt every row," so a real profiling run can
  // show exactly which part actually dominates.
  final total = Stopwatch()..start();
  final db = await messageDb();
  final queryTimer = Stopwatch()..start();
  final rows = db.select(loadMessagesSql, [conversationId]);
  final queryMs = queryTimer.elapsedMilliseconds;
  final decodeTimer = Stopwatch()..start();
  final out = <CachedMessage>[];
  for (final row in rows) {
    try {
      out.add(await _decodeRow(kek, row['ciphertext'] as Uint8List));
    } catch (_) {
      // A KEK mismatch (password changed elsewhere) or a corrupt single row is
      // not a reason to lose the rest of the conversation — same "fail this
      // one message, not the whole cache" reasoning the old blob-based version
      // could only apply at the whole-list level.
    }
  }
  // dart:developer's log() is silently dropped with no debugger/DevTools
  // attached — confirmed live: a whole release-build logcat session had zero
  // "CommPerf" lines despite thousands of ordinary flutter ones. debugPrint
  // goes through the same stdout path Flutter's own framework logging
  // already uses (visible as plain I/flutter lines even in release), so it's
  // what actually survives to logcat on a real device.
  debugPrint(
    'CommPerf: loadCachedMessages($conversationId): ${rows.length} rows, '
    'query=${queryMs}ms, decode=${decodeTimer.elapsedMilliseconds}ms, '
    'total=${total.elapsedMilliseconds}ms',
  );
  return out;
}

Future<void> appendCachedMessage(Uint8List kek, CachedMessage message) async {
  final db = await messageDb();
  db.execute(
    insertMessageSql,
    [
      message.id,
      message.conversationId,
      message.sentAt,
      await _encodeMessage(kek, message),
    ],
  );
  _trim(db, message.conversationId);
}

/// Bulk variant of [appendCachedMessage] — inserts every not-already-present
/// message in [messages] inside one transaction and trims once at the end,
/// instead of once per message. thread_screen.dart's `_load()` uses this for
/// its history catch-up. A single live incoming message (features/chats/
/// thread_screen.dart's `_onRealtimeNew`) still goes through the one-at-a-time
/// [appendCachedMessage] — there's nothing to batch when there's only one.
Future<void> appendCachedMessages(
  Uint8List kek,
  String conversationId,
  List<CachedMessage> messages,
) async {
  if (messages.isEmpty) return;
  final db = await messageDb();
  db.execute('BEGIN');
  try {
    for (final message in messages) {
      db.execute(
        insertMessageSql,
        [
          message.id,
          message.conversationId,
          message.sentAt,
          await _encodeMessage(kek, message),
        ],
      );
    }
    db.execute('COMMIT');
  } catch (_) {
    db.execute('ROLLBACK');
    rethrow;
  }
  _trim(db, conversationId);
}

/// Rolls back an optimistically-rendered outgoing message (thread_screen.dart's
/// `_sendEnvelope`) if the send actually fails server-side — mirrors
/// apps/web/lib/crypto/message-cache.ts's `removeCachedMessage` exactly, same
/// reasoning: the message was appended to the local cache the instant it was
/// encrypted, before the network round trip even started, so a failure needs an
/// explicit way to take it back out again. A single indexed DELETE now, not a
/// read-decrypt-filter-re-encrypt-write of the whole conversation.
Future<void> removeCachedMessage(
  Uint8List kek,
  String conversationId,
  String messageId,
) async {
  final db = await messageDb();
  db.execute('DELETE FROM messages WHERE id = ?', [messageId]);
}

/// Tombstones a message locally — mirrors apps/web's own `markCachedMessageDeleted`
/// (lib/crypto/message-cache.ts) exactly: clears `text`/`mediaBase64`/`attachment`
/// (the whole point of "delete for everyone" is that the content itself is gone,
/// not just hidden) and sets `deleted`/`deletedReason`, leaving everything else
/// (id, sentAt, isOwn, replyToMessageId — so a reply pointing at this message can
/// still resolve it and show the tombstone text) intact. A no-op, returning the
/// list unchanged, if the message isn't cached on this device at all (e.g. it was
/// deleted before this device ever decrypted it). Returns the whole updated list
/// so the caller can `setState` directly with it, same shape web returns — this
/// now costs one indexed UPDATE plus one query, not a read-decrypt-modify-
/// re-encrypt-write of the entire conversation.
Future<List<CachedMessage>> markCachedMessageDeleted(
  Uint8List kek,
  String conversationId,
  String messageId,
  String reason,
) async {
  final db = await messageDb();
  final rows = db.select(
    'SELECT ciphertext FROM messages WHERE id = ?',
    [messageId],
  );
  if (rows.isEmpty) return loadCachedMessages(kek, conversationId);
  final existing = await _decodeRow(kek, rows.first['ciphertext'] as Uint8List);
  final updated = CachedMessage(
    id: existing.id,
    conversationId: existing.conversationId,
    senderUserId: existing.senderUserId,
    isOwn: existing.isOwn,
    contentTypeHint: existing.contentTypeHint,
    text: '',
    sentAt: existing.sentAt,
    replyToMessageId: existing.replyToMessageId,
    deleted: true,
    deletedReason: reason,
  );
  db.execute(
    'UPDATE messages SET ciphertext = ? WHERE id = ?',
    [await _encodeMessage(kek, updated), messageId],
  );
  return loadCachedMessages(kek, conversationId);
}

/// Persists a delivered/read update for one of THIS device's own cached
/// messages — see `CachedMessage.delivered`/`.read`'s own docstring for why
/// this exists at all. Called alongside every place thread_screen.dart's
/// in-memory `_status` map changes, so the cache never falls behind what's
/// already been shown on screen. A no-op if the message isn't cached (nothing
/// to update) or if the new value is identical to what's already stored. One
/// indexed row read + write now, not the whole conversation.
Future<void> updateCachedMessageStatus(
  Uint8List kek,
  String conversationId,
  String messageId, {
  required bool delivered,
  required bool read,
}) async {
  // TEMPORARY diagnostic — see message_db.dart's own note on why.
  final sw = Stopwatch()..start();
  final db = await messageDb();
  final rows = db.select(
    'SELECT ciphertext FROM messages WHERE id = ?',
    [messageId],
  );
  if (rows.isEmpty) return;
  final existing = await _decodeRow(kek, rows.first['ciphertext'] as Uint8List);
  if (existing.delivered == delivered && existing.read == read) {
    debugPrint('CommPerf: updateCachedMessageStatus($messageId): unchanged, ${sw.elapsedMilliseconds}ms');
    return;
  }
  final updated = CachedMessage(
    id: existing.id,
    conversationId: existing.conversationId,
    senderUserId: existing.senderUserId,
    isOwn: existing.isOwn,
    contentTypeHint: existing.contentTypeHint,
    text: existing.text,
    sentAt: existing.sentAt,
    replyToMessageId: existing.replyToMessageId,
    attachment: existing.attachment,
    mediaBase64: existing.mediaBase64,
    mediaDurationSec: existing.mediaDurationSec,
    deleted: existing.deleted,
    deletedReason: existing.deletedReason,
    delivered: delivered,
    read: read,
  );
  db.execute(
    'UPDATE messages SET ciphertext = ? WHERE id = ?',
    [await _encodeMessage(kek, updated), messageId],
  );
  debugPrint('CommPerf: updateCachedMessageStatus($messageId): wrote, ${sw.elapsedMilliseconds}ms');
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
///
/// Used together with [markConversationLocallyDeleted] below, NOT `archived` —
/// see that function's docstring for why reusing the archive flag for this was
/// wrong (it visibly landed a "deleted" chat inside the Archived section instead
/// of actually making it disappear).
Future<void> clearCachedMessages(String conversationId) async {
  final db = await messageDb();
  db.execute('DELETE FROM messages WHERE conversation_id = ?', [conversationId]);
}

const _locallyDeletedKey = 'locally-deleted-conversations';

Future<Set<String>> _readLocallyDeleted() async {
  final raw = await getBlob(_locallyDeletedKey);
  if (raw == null) return {};
  final decoded = jsonDecode(utf8.decode(raw));
  if (decoded is! List) return {};
  return decoded.whereType<String>().toSet();
}

Future<void> _writeLocallyDeleted(Set<String> ids) async {
  if (ids.isEmpty) {
    await deleteBlob(_locallyDeletedKey);
    return;
  }
  await putBlob(_locallyDeletedKey, utf8.encode(jsonEncode(ids.toList())));
}

/// The other half of "Delete chat" (see [clearCachedMessages] above). Unencrypted
/// on the wire, plaintext at rest is fine here — a conversation id is not
/// sensitive content, unlike everything else this file stores. Kept in its own
/// small blob (this device's account-scoped storage, same as everything else in
/// this file) rather than reusing the server's `archived` field for "deleted":
/// `archived` is a real, separate WhatsApp feature (chats-shell.tsx's own
/// `handleToggleArchive`) with its own dedicated screen, and a chat the user just
/// asked to delete showing up there instead of actually vanishing was the exact,
/// reported bug this replaced. This is local-only and never reaches the server —
/// deleting a chat on one device has no effect on the conversation's `archived`
/// state or visibility on any other device, matching every other "local view
/// preference" in this file.
Future<void> markConversationLocallyDeleted(String conversationId) async {
  final ids = await _readLocallyDeleted();
  ids.add(conversationId);
  await _writeLocallyDeleted(ids);
}

/// Called the moment a live message arrives for a conversation (chats_list_screen.
/// dart's WS 'new' handler) — this is what actually makes good on "this chat will
/// come back if they message you again" from the delete-confirmation dialog: a
/// locally-deleted conversation is hidden by [isConversationLocallyDeleted] below,
/// not removed from the account, so the moment a new message shows it's still
/// live, this un-hides it. A no-op if the id wasn't hidden to begin with.
Future<void> unmarkConversationLocallyDeleted(String conversationId) async {
  final ids = await _readLocallyDeleted();
  if (ids.remove(conversationId)) {
    await _writeLocallyDeleted(ids);
  }
}

Future<bool> isConversationLocallyDeleted(String conversationId) async =>
    (await _readLocallyDeleted()).contains(conversationId);

/// Bulk form of [isConversationLocallyDeleted] — chats_list_screen.dart filters an
/// entire freshly-fetched list against this once per load rather than one blob
/// read per row.
Future<Set<String>> locallyDeletedConversationIds() => _readLocallyDeleted();

/// One-time-per-account migration off the old one-blob-per-conversation cache
/// (`flutter_secure_storage`, key `msgcache:<conversationId>`) into this file's
/// new SQLite-backed store — called once at app startup (see app.dart's own
/// init sequence) after `getCurrentKek()` resolves, since decrypting the old
/// blobs needs it. Safe to call on every startup: a conversation whose old blob
/// was already migrated (and deleted) simply isn't found by
/// `readAllBlobsWithPrefix` any more, so a re-run after a successful migration
/// is a fast no-op, not a re-import. Never throws — a single conversation's old
/// blob failing to decrypt (e.g. a KEK that's changed since) just means that
/// conversation's local history is gone, exactly as it already would have been
/// under the old cache in the same situation (loadCachedMessages's own
/// catch-and-return-empty), not a reason to fail startup.
Future<void> migrateLegacyMessageCache(Uint8List kek) async {
  final legacyBlobs = await readAllBlobsWithPrefix('msgcache:');
  if (legacyBlobs.isEmpty) return;
  for (final entry in legacyBlobs.entries) {
    final conversationId = entry.key.substring('msgcache:'.length);
    try {
      final plaintext = await unwrapBytes(kek, entry.value);
      final list = jsonDecode(bytesToUtf8(plaintext)) as List;
      final messages = list
          .map((e) => CachedMessage.fromJson(e as Map<String, dynamic>))
          .toList();
      await appendCachedMessages(kek, conversationId, messages);
    } catch (_) {
      // See this function's own docstring — one conversation's corrupt/
      // undecryptable legacy blob doesn't block migrating the rest.
    }
    await deleteBlob(entry.key);
  }
}
