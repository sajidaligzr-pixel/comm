/// Real indexed local storage for cached, decrypted message history — see
/// pubspec.yaml's own comment (search `sqlite3_flutter_libs`) for why this
/// exists at all: a single encrypted blob per conversation (the previous
/// design, still what `flutter_secure_storage`/`blob_store.dart` is used for
/// everywhere else in this app) has no way to fetch just the newest slice of
/// a big conversation — every open had to pull the WHOLE blob out of
/// Keystore/Keychain and JSON-decode all of it, which is exactly the
/// "opening a big chat takes a while, shows a spinner" behavior reported
/// live. SQLite lets a query ask for only the rows it actually needs.
///
/// Deliberately a thin, low-level wrapper — `message_cache.dart` owns the
/// actual read/write API and the AEAD wrap/unwrap of each row's content; this
/// file only owns the connection lifecycle and schema. Raw `sqlite3` (FFI
/// bindings), not `drift` — this app has no codegen step anywhere
/// (api/dtos.dart's own docstring) and a hand-written schema this small
/// doesn't need one.
library;

import 'dart:io';
import 'package:flutter/foundation.dart' show debugPrint;
import 'package:path_provider/path_provider.dart';
import 'package:sqlite3/sqlite3.dart';
import 'active_account.dart';

Database? _db;
String? _dbAccount;

Future<String> _dbPath(String account) async {
  final supportDir = await getApplicationSupportDirectory();
  return '${supportDir.path}/comm_messages_$account.db';
}

/// Exported (not just inlined into [messageDb] below) so `test/storage/
/// message_db_schema_test.dart` can apply the EXACT same schema/queries this
/// app actually runs against a plain `sqlite3.openInMemory()` — no
/// path_provider/platform-channel mocking needed, since this whole file's
/// only platform dependency is finding a directory to put the file in, not
/// the SQL itself. Keeping these as one shared source of truth means a test
/// exercising them can never silently drift out of sync with production.
const messagesTableSchemaSql = [
  '''
  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    sent_at TEXT NOT NULL,
    ciphertext BLOB NOT NULL
  );
  ''',
  'CREATE INDEX IF NOT EXISTS idx_messages_conv_sent ON messages(conversation_id, sent_at);',
];

const insertMessageSql =
    'INSERT OR IGNORE INTO messages (id, conversation_id, sent_at, ciphertext) VALUES (?, ?, ?, ?)';

const loadMessagesSql =
    'SELECT ciphertext FROM messages WHERE conversation_id = ? ORDER BY sent_at ASC';

/// Deletes every row for [conversationId] beyond its [max] most recent
/// (by `sent_at`) — a single indexed statement, not a read-modify-write of
/// anything. Shared between the real `_trim` in message_cache.dart and this
/// package's own schema test.
const trimMessagesSql = '''
  DELETE FROM messages
  WHERE conversation_id = ?1
    AND id NOT IN (
      SELECT id FROM messages
      WHERE conversation_id = ?1
      ORDER BY sent_at DESC
      LIMIT ?2
    )
  ''';

/// Opens (or reuses) the current account's message database, creating the
/// schema on first open. Re-opens a fresh handle whenever the active account
/// changes — mirrors every other per-account store in this app
/// (active_account.dart's own docstring on why: a phone signed into more than
/// one account over its lifetime must never have one account's data bleed
/// into another's).
Future<Database> messageDb() async {
  final account = getActiveAccount();
  final existing = _db;
  if (existing != null && _dbAccount == account) return existing;
  existing?.dispose();

  // TEMPORARY diagnostic — timing the cold-open path specifically (schema
  // creation only ever runs here, once), to find out whether this is
  // contributing to "still taking so much time to load" reported live after
  // shipping the SQLite-backed cache. Remove once the real bottleneck is
  // identified. debugPrint, not dart:developer's log() — the latter is
  // silently dropped with no debugger/DevTools attached, confirmed live: a
  // whole release-build logcat capture had zero output from it.
  final sw = Stopwatch()..start();
  final db = sqlite3.open(await _dbPath(account));
  // WAL mode: readers (rendering a thread) don't block on a writer (a live
  // message arriving mid-scroll) and vice versa — matters here specifically
  // because a chat can legitimately be read and written to at the same time.
  db.execute('PRAGMA journal_mode=WAL;');
  for (final statement in messagesTableSchemaSql) {
    db.execute(statement);
  }
  _db = db;
  _dbAccount = account;
  debugPrint('CommPerf: messageDb() cold open took ${sw.elapsedMilliseconds}ms');
  return db;
}

/// Called on logout/device-revoke/account-deletion (auth_controller.dart,
/// always alongside `blob_store.dart`'s own `wipeCryptoDb()`) — closes the
/// open handle for the CURRENT account (if any) and deletes its database
/// file outright, same scope `wipeCryptoDb()` has for everything else this
/// app stores locally. Must run before `clearActiveAccount()` (same
/// requirement `wipeCryptoDb()` already has), since this needs
/// `getActiveAccount()` to know which account's file to delete.
Future<void> wipeMessageDb() async {
  final account = getActiveAccount();
  if (_dbAccount == account) {
    _db?.dispose();
    _db = null;
    _dbAccount = null;
  }
  final base = await _dbPath(account);
  // The main file plus SQLite's own WAL-mode sidecar files — all three (or
  // however many exist) need to go, or a stale -wal file could resurrect
  // "deleted" rows the next time this account's database is reopened.
  for (final suffix in ['', '-wal', '-shm', '-journal']) {
    final file = File('$base$suffix');
    if (await file.exists()) await file.delete();
  }
}
