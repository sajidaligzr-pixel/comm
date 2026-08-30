// Exercises message_db.dart's actual schema/query constants (not a copy of
// them) against a plain in-memory SQLite database — no path_provider/
// flutter_secure_storage platform-channel mocking needed, since
// sqlite3.openInMemory() has no Flutter plugin dependency at all. Covers the
// highest-risk part of the message_cache.dart rewrite off a single encrypted
// blob per conversation onto real per-message rows (found live to be the
// cause of "opening a big chat takes a while, shows a spinner" — see that
// file's own docstring): the trim-to-N-newest query, idempotent insert, and
// per-conversation isolation.
import 'package:flutter_test/flutter_test.dart';
import 'package:sqlite3/sqlite3.dart';
import 'package:comm_mobile/storage/message_db.dart';

Database _openTestDb() {
  final db = sqlite3.openInMemory();
  for (final statement in messagesTableSchemaSql) {
    db.execute(statement);
  }
  return db;
}

void _insert(Database db, String id, String conv, String sentAt) {
  db.execute(insertMessageSql, [id, conv, sentAt, <int>[1, 2, 3]]);
}

void _trim(Database db, String conv, int max) {
  db.execute(trimMessagesSql, [conv, max]);
}

List<String> _idsFor(Database db, String conv) {
  final rows = db.select(
    'SELECT id FROM messages WHERE conversation_id = ? ORDER BY sent_at ASC',
    [conv],
  );
  return rows.map((r) => r['id'] as String).toList();
}

void main() {
  group('message_db.dart schema', () {
    test('load query returns rows chronologically (oldest first)', () {
      final db = _openTestDb();
      _insert(db, 'm1', 'c1', '2024-01-01T00:00:00Z');
      _insert(db, 'm3', 'c1', '2024-01-03T00:00:00Z');
      _insert(db, 'm2', 'c1', '2024-01-02T00:00:00Z');

      final rows = db.select(loadMessagesSql, ['c1']);
      expect(rows.map((r) => r['ciphertext']).length, 3);
      expect(_idsFor(db, 'c1'), ['m1', 'm2', 'm3']);
      db.dispose();
    });

    test('insert is idempotent by message id (a duplicate WS/REST delivery is a no-op)', () {
      final db = _openTestDb();
      _insert(db, 'm1', 'c1', '2024-01-01T00:00:00Z');
      _insert(db, 'm1', 'c1', '2024-01-01T00:00:00Z'); // same id again

      final count = db.select(
        'SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ?',
        ['c1'],
      );
      expect(count.first['n'], 1);
      db.dispose();
    });

    test('trim keeps only the N newest rows for that conversation', () {
      final db = _openTestDb();
      for (var i = 1; i <= 5; i++) {
        _insert(db, 'm$i', 'c1', '2024-01-0${i}T00:00:00Z');
      }
      _trim(db, 'c1', 3);

      expect(_idsFor(db, 'c1'), ['m3', 'm4', 'm5']);
      db.dispose();
    });

    test('trimming one conversation never touches another conversation\'s rows', () {
      final db = _openTestDb();
      _insert(db, 'a1', 'convA', '2024-01-01T00:00:00Z');
      _insert(db, 'a2', 'convA', '2024-01-02T00:00:00Z');
      _insert(db, 'b1', 'convB', '2024-01-01T00:00:00Z');

      _trim(db, 'convA', 1);

      expect(_idsFor(db, 'convA'), ['a2']);
      expect(_idsFor(db, 'convB'), ['b1']); // untouched
      db.dispose();
    });

    test('delete-by-id (removeCachedMessage\'s shape) removes exactly that row', () {
      final db = _openTestDb();
      _insert(db, 'm1', 'c1', '2024-01-01T00:00:00Z');
      _insert(db, 'm2', 'c1', '2024-01-02T00:00:00Z');

      db.execute('DELETE FROM messages WHERE id = ?', ['m1']);

      expect(_idsFor(db, 'c1'), ['m2']);
      db.dispose();
    });

    test('update-by-id (markCachedMessageDeleted/updateCachedMessageStatus\'s shape) overwrites only that row', () {
      final db = _openTestDb();
      _insert(db, 'm1', 'c1', '2024-01-01T00:00:00Z');
      _insert(db, 'm2', 'c1', '2024-01-02T00:00:00Z');

      db.execute('UPDATE messages SET ciphertext = ? WHERE id = ?', [
        <int>[9, 9, 9],
        'm1',
      ]);

      final m1 = db.select('SELECT ciphertext FROM messages WHERE id = ?', ['m1']);
      final m2 = db.select('SELECT ciphertext FROM messages WHERE id = ?', ['m2']);
      expect(m1.first['ciphertext'], <int>[9, 9, 9]);
      expect(m2.first['ciphertext'], <int>[1, 2, 3]); // untouched
      db.dispose();
    });

    test('delete-by-conversation (clearCachedMessages\'s shape) wipes only that conversation', () {
      final db = _openTestDb();
      _insert(db, 'a1', 'convA', '2024-01-01T00:00:00Z');
      _insert(db, 'b1', 'convB', '2024-01-01T00:00:00Z');

      db.execute('DELETE FROM messages WHERE conversation_id = ?', ['convA']);

      expect(_idsFor(db, 'convA'), <String>[]);
      expect(_idsFor(db, 'convB'), ['b1']);
      db.dispose();
    });
  });
}
