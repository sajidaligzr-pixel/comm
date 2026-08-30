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

/// Has this device already been shown the "allow permissions" card
/// (features/permissions/permissions_prompt.dart), for the CURRENT set of
/// permissions it asks for? NOT scoped by username, same reasoning as the
/// update-dismissed key above — microphone/Bluetooth/location access is granted
/// to the app itself (this device's install), not to whichever account happens to
/// be signed in, so a second account on the same phone shouldn't see it again.
///
/// Versioned, not a plain boolean — found live: the card originally only asked
/// for microphone/Bluetooth, and everyone who'd already dismissed/completed it
/// under that version permanently had the flag set, so when location sharing
/// was added later, the card silently never showed again for any existing
/// install and location was simply never requested (build 10 shipped this way,
/// discovered from a real device — the update installed but no location
/// permission dialog ever appeared). `_currentPermissionsOnboardingVersion`
/// (permissions_prompt.dart) bumps whenever the card starts asking for something
/// new; anyone who last saw an older version sees it again — asking again for a
/// permission already granted/permanently-denied is a harmless no-op dialog on
/// both platforms, so this never double-nags for the parts that didn't change.
const _permissionsOnboardingVersionKey = 'comm_permissions_onboarding_version';

Future<void> setPermissionsOnboardingVersionSeen(int version) =>
    _storage.write(key: _permissionsOnboardingVersionKey, value: version.toString());

/// Returns 0 (never shown) if the key has never been written. A legacy `'true'`
/// value (written by the pre-versioning boolean flag) is read back as `1` — the
/// version that card corresponds to — so an existing install that already saw
/// the mic/Bluetooth-only card is asked again exactly once for what's new since,
/// not from scratch.
Future<int> getPermissionsOnboardingVersionSeen() async {
  final raw = await _storage.read(key: _permissionsOnboardingVersionKey);
  if (raw == null) return 0;
  if (raw == 'true') return 1;
  return int.tryParse(raw) ?? 0;
}

/// De-dupes `flutter_local_notifications`' own `getNotificationAppLaunchDetails()`
/// against a real, documented Android quirk (see local_notifications.dart's
/// `initLocalNotifications`): `didNotificationLaunchApp` can keep reporting `true`
/// — with the exact same stale payload — across LATER cold starts that were not
/// actually triggered by tapping a notification at all (just reopening the app
/// after it was killed), because Android can hand the Activity back its
/// last-used launch Intent instead of a fresh one. Found live as the reported
/// bug: the app kept auto-navigating into a conversation on every subsequent
/// launch as though its notification had just been tapped, with nothing actually
/// new waiting there. NOT scoped by username, same reasoning as the
/// permissions-onboarding key above — this dedupes one specific OS-level Intent
/// replay, not per-account state, and needs to be readable before any account is
/// known (this runs from main(), before sign-in resolves).
const _lastConsumedLaunchNotificationKey = 'comm_last_consumed_launch_notification';

Future<void> setLastConsumedLaunchNotification(String payload) =>
    _storage.write(key: _lastConsumedLaunchNotificationKey, value: payload);

Future<String?> getLastConsumedLaunchNotification() =>
    _storage.read(key: _lastConsumedLaunchNotificationKey);

/// Marks that THIS device has, at least once, walked a conversation's full
/// local cache through `syncHistoryEntry` (history_sync.dart) — closes the gap
/// where `thread_screen.dart`'s catch-up loop only ever calls `syncHistoryEntry`
/// for a message it *newly* decrypts (`if (cachedIds.contains(dto.id)) continue`
/// skips straight past anything already cached), so a message this device
/// already had before this backfill existed — or from before multi-device
/// history sync shipped at all — never got a `message_history_entries` row
/// written for it by anyone, ever. A brand-new device added later then
/// correctly, but unhelpfully, can't decrypt it: no device had ever contributed
/// it to the account's shared history archive. Reported live exactly this way:
/// a new device's "old message can't be decrypted." NOT scoped by username —
/// a conversationId is already globally unique to the specific accounts in it,
/// so there's no cross-account collision risk from leaving it unscoped, and
/// unscoped is simpler.
///
/// Deliberately a durable per-conversation marker, not "always resync on every
/// open": `writeMessageHistoryEntry` (server/modules/history/service.ts) is a
/// real `upsert` (a write every call, not a cheap existence check), so
/// resyncing an already-backfilled conversation's full history on every single
/// open would be pure waste at any real conversation size. One full pass per
/// device per conversation is enough — after that, the normal live/catch-up
/// path already keeps new messages covered.
String _historyBackfillDoneKey(String conversationId) => 'comm_history_backfill_done__$conversationId';

Future<void> setHistoryBackfillDone(String conversationId) =>
    _storage.write(key: _historyBackfillDoneKey(conversationId), value: '1');

Future<bool> getHistoryBackfillDone(String conversationId) async =>
    (await _storage.read(key: _historyBackfillDoneKey(conversationId))) != null;
