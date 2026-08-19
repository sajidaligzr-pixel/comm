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

/// Snooze state for the one-time "turn on biometric unlock?" prompt (see
/// features/auth/biometric_enroll_prompt.dart) — mirrors the
/// `comm-biometric-dismissed-at` `localStorage` key `biometric-enroll-prompt.tsx`
/// uses. Scoped by username, same reasoning as the device-id key above: dismissing
/// this on one account shouldn't silently suppress it for a different account later
/// signed into on the same phone.
String _biometricDismissedKey(String username) => 'comm_biometric_dismissed__${username.trim().toLowerCase()}';

Future<void> setBiometricPromptDismissedNow(String username) =>
    _storage.write(key: _biometricDismissedKey(username), value: DateTime.now().toUtc().toIso8601String());

Future<DateTime?> getBiometricPromptDismissedAt(String username) async {
  final raw = await _storage.read(key: _biometricDismissedKey(username));
  if (raw == null) return null;
  return DateTime.tryParse(raw);
}

/// Snooze state for the in-app update banner (features/update/update_prompt.dart)
/// — NOT scoped by username, unlike the two keys above: which build is installed
/// is a property of this device's copy of the app itself, the same for every
/// account signed into it, not something a second account should see fresh again.
/// Tapping "Not now" records the build being offered so the banner doesn't nag on
/// every single app open — but a genuinely NEWER build later (a higher number
/// than whatever was last dismissed) still shows, since dismissing isn't the same
/// as "never tell me about updates again."
const _updateDismissedBuildKey = 'comm_update_dismissed_build';

Future<void> setUpdateDismissedBuildNumber(int buildNumber) =>
    _storage.write(key: _updateDismissedBuildKey, value: buildNumber.toString());

Future<int?> getUpdateDismissedBuildNumber() async {
  final raw = await _storage.read(key: _updateDismissedBuildKey);
  if (raw == null) return null;
  return int.tryParse(raw);
}
