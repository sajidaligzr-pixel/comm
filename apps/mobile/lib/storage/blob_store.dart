/// Opaque byte-blob storage, account-scoped — the mobile counterpart to
/// `apps/web/lib/crypto/db.ts`'s per-account IndexedDB. Backed by
/// `flutter_secure_storage` (iOS Keychain / Android Keystore) rather than a database
/// file: every value this app ever stores through here is small (key material,
/// serialized ratchet state, cached message history — nothing bulk-media-sized), so
/// there's no reason to give up Keychain/Keystore-backed at-rest protection for
/// SQLite's query features, which nothing here needs (lookups are always by exact
/// key). Deliberately NOT cryptographic code itself, same as db.ts — every blob
/// reaching this module has already been wrapped (encrypted) by crypto/storage/wrap.dart
/// before it gets here.
library;

import 'dart:convert';
import 'dart:typed_data';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'active_account.dart';

const _storage = FlutterSecureStorage(
  aOptions: AndroidOptions(encryptedSharedPreferences: true),
  iOptions: IOSOptions(accessibility: KeychainAccessibility.first_unlock),
);

/// Every key is namespaced by the currently active account, mirroring db.ts's
/// per-account *database* (not just per-key prefix) — the effect is the same: two
/// accounts signed into on the same device can never read or clobber each other's
/// blobs, by construction.
String _scopedKey(String key) => 'comm_blob__${getActiveAccount()}__$key';

Future<void> putBlob(String key, Uint8List value) async {
  await _storage.write(key: _scopedKey(key), value: base64Encode(value));
}

Future<Uint8List?> getBlob(String key) async {
  final raw = await _storage.read(key: _scopedKey(key));
  if (raw == null) return null;
  return base64Decode(raw);
}

Future<void> deleteBlob(String key) async {
  await _storage.delete(key: _scopedKey(key));
}

/// Wipes every locally-stored key/session for the CURRENTLY ACTIVE account only —
/// called on logout/device revoke. `flutter_secure_storage` has no "delete by
/// prefix" primitive, so this reads all keys and filters, unlike db.ts's cheap
/// "delete the whole per-account database" — an accepted cost of trading a real
/// per-account database for Keychain/Keystore-backed storage.
Future<void> wipeCryptoDb() async {
  final all = await _storage.readAll();
  final prefix = 'comm_blob__${getActiveAccount()}__';
  for (final key in all.keys) {
    if (key.startsWith(prefix)) {
      await _storage.delete(key: key);
    }
  }
}
