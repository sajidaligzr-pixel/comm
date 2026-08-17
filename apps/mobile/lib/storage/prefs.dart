/// Small non-blob local preferences: the remembered device id per account (so a
/// returning login doesn't re-register a brand-new device every time) and the
/// last-used username (so the login screen can prefill it) — direct port of the two
/// `localStorage` keys `apps/web/components/login-form.tsx` uses. Kept on
/// `flutter_secure_storage` too rather than adding a second local-storage dependency
/// (shared_preferences) just for these two small values; a device id and a username
/// are not secrets the way session/identity blobs are, but there's no real cost to
/// keeping everything in one place.
library;

import 'package:flutter_secure_storage/flutter_secure_storage.dart';

const _storage = FlutterSecureStorage(
  aOptions: AndroidOptions(encryptedSharedPreferences: true),
  iOptions: IOSOptions(accessibility: KeychainAccessibility.first_unlock),
);

/// Scoped by username, not a single fixed key — mirrors login-form.tsx's
/// `deviceIdStorageKey`: a phone signed into more than one account over its
/// lifetime must not have the second account's login read/overwrite the first
/// account's remembered device id.
String _deviceIdKey(String username) => 'comm_device_id__${username.trim().toLowerCase()}';

Future<void> setRememberedDeviceId(String username, String deviceId) =>
    _storage.write(key: _deviceIdKey(username), value: deviceId);

Future<String?> getRememberedDeviceId(String username) => _storage.read(key: _deviceIdKey(username));

Future<void> clearRememberedDeviceId(String username) => _storage.delete(key: _deviceIdKey(username));

const _rememberedUsernameKey = 'comm_username';

Future<void> setRememberedUsername(String username) => _storage.write(key: _rememberedUsernameKey, value: username);

Future<String?> getRememberedUsername() => _storage.read(key: _rememberedUsernameKey);
