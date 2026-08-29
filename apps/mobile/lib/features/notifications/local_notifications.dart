/// System notifications for MESSAGES — shown for a live WS event while the app is
/// foregrounded or backgrounded-but-still-running (message_notifier.dart), AND for a
/// push notification woken from a killed/deeply-backgrounded state
/// (push_notifications.dart's foreground listener and background handler both call
/// straight into `showNewMessageNotification` below) — one rendering path
/// regardless of which triggered it, so a notification looks the same either way.
///
/// Calls do NOT go through this file — see features/calls/call_kit.dart's own
/// docstring for why (this plugin's notification API can only ever play a sound
/// once per post; a phone-call-style ring needs a genuine system-level calling app
/// registration, which flutter_local_notifications doesn't provide).
library;

import 'dart:convert';
import 'dart:io' show Platform;
import 'package:flutter_local_notifications/flutter_local_notifications.dart';
import '../../storage/prefs.dart';

final FlutterLocalNotificationsPlugin _plugin =
    FlutterLocalNotificationsPlugin();

// "_v2": an Android notification channel's sound/importance/etc. are locked in by
// the OS the first time it's created — a later change to this file (like the
// custom `sound:` below, added after this channel already existed on test devices
// from earlier builds) never takes effect on an install that already has the old
// channel, no matter how the app is updated. Bumping the id is what actually forces
// Android to create a fresh channel with the new settings; an already-installed
// device without a fresh reinstall would otherwise silently keep chiming with the
// old (default) sound forever. Any future change to this channel's config needs the
// same bump.
const _channelId = 'comm_messages_v2';
const _channelName = 'Messages';
const _androidChannel = AndroidNotificationChannel(
  _channelId,
  _channelName,
  description: 'New message notifications',
  importance: Importance.high,
  sound: RawResourceAndroidNotificationSound('message'),
);

/// A tapped notification's payload, decoded — a message notification carries
/// `conversationId`.
class NotificationTap {
  final String? conversationId;
  const NotificationTap({this.conversationId});
}

NotificationTap? _decodeTapPayload(String? raw) {
  if (raw == null || raw.isEmpty) return null;
  try {
    final decoded = jsonDecode(raw);
    if (decoded is! Map<String, dynamic>) return null;
    final conversationId = decoded['conversationId'] as String?;
    if (conversationId == null || conversationId.isEmpty) return null;
    return NotificationTap(conversationId: conversationId);
  } catch (_) {
    return null;
  }
}

/// `onTap` is called with what the user tapped — wired to actual navigation by
/// whoever calls this (see main.dart), kept as a plain callback here so this file
/// has no dependency on go_router/Riverpod.
Future<void> initLocalNotifications({
  required void Function(NotificationTap tap) onTap,
}) async {
  const androidInit = AndroidInitializationSettings('@mipmap/ic_launcher');
  const iosInit = DarwinInitializationSettings(
    requestAlertPermission: false,
    requestBadgePermission: false,
    requestSoundPermission: false,
  );
  await _plugin.initialize(
    const InitializationSettings(android: androidInit, iOS: iosInit),
    onDidReceiveNotificationResponse: (response) {
      final tap = _decodeTapPayload(response.payload);
      if (tap != null) onTap(tap);
    },
  );

  // The tap that COLD-STARTS the app from a killed state never reaches the
  // callback above — flutter_local_notifications' own documented gap, since the
  // plugin isn't wired up yet at the instant that tap actually happened. This is
  // the other half: checked once, right here, after `initialize()` has resolved
  // (this function is called from main.dart before the first frame, same timing
  // guarantee `getNotificationAppLaunchDetails` needs to be reliable).
  //
  // De-duped against `getLastConsumedLaunchNotification`'s own stored payload —
  // see that function's docstring for the real Android quirk this guards
  // against: `didNotificationLaunchApp` can keep returning `true` with this EXACT
  // payload on later cold starts that were never actually a notification tap at
  // all, which without this guard re-fired `onTap` (auto-navigating into that
  // conversation) every single time the app was reopened. The payload's `n`
  // field (see `showNewMessageNotification`) is what makes two DIFFERENT
  // notifications for the same conversation distinguishable despite sharing a
  // `conversationId` — a raw string compare here is enough.
  final launchDetails = await _plugin.getNotificationAppLaunchDetails();
  final launchPayload = launchDetails?.notificationResponse?.payload;
  if ((launchDetails?.didNotificationLaunchApp ?? false) && launchPayload != null) {
    final alreadyConsumed = await getLastConsumedLaunchNotification();
    if (alreadyConsumed != launchPayload) {
      final tap = _decodeTapPayload(launchPayload);
      if (tap != null) onTap(tap);
      await setLastConsumedLaunchNotification(launchPayload);
    }
  }

  final androidImpl = _plugin
      .resolvePlatformSpecificImplementation<
        AndroidFlutterLocalNotificationsPlugin
      >();
  await androidImpl?.createNotificationChannel(_androidChannel);
  // Android 13+ (API 33) requires this to be requested at runtime, same as any
  // other dangerous permission — silently no-ops on older Android/other platforms.
  await androidImpl?.requestNotificationsPermission();

  final iosImpl = _plugin
      .resolvePlatformSpecificImplementation<
        IOSFlutterLocalNotificationsPlugin
      >();
  await iosImpl?.requestPermissions(alert: true, badge: true, sound: true);
}

int _notificationIdFor(String conversationId) =>
    conversationId.hashCode & 0x7fffffff;

/// Shows one notification for a conversation, replacing any still-showing
/// notification for that same conversation (same id derived from the conversation
/// id) rather than stacking one per message — matches how a chat app's
/// notifications are normally grouped per-conversation, not per-message.
Future<void> showNewMessageNotification({
  required String conversationId,
  required String title,
  required String body,
}) async {
  const androidDetails = AndroidNotificationDetails(
    _channelId,
    _channelName,
    importance: Importance.high,
    priority: Priority.high,
    category: AndroidNotificationCategory.message,
  );
  const iosDetails = DarwinNotificationDetails();
  await _plugin.show(
    _notificationIdFor(conversationId),
    title,
    body,
    const NotificationDetails(android: androidDetails, iOS: iosDetails),
    // `n`: a per-post nonce, not read by `_decodeTapPayload` — its only job is
    // making two distinct notifications for the same conversation distinguishable
    // by their raw payload string, which is what
    // `getLastConsumedLaunchNotification`'s dedup check (initLocalNotifications)
    // compares against. Without it, a genuinely fresh tap on a NEW message for a
    // conversation whose PREVIOUS notification was already consumed would look
    // byte-identical to that already-consumed one and get silently skipped.
    payload: jsonEncode({
      'type': 'message',
      'conversationId': conversationId,
      'n': DateTime.now().microsecondsSinceEpoch,
    }),
  );
}

/// Clears this conversation's notification — called when the user opens that
/// thread (thread_screen.dart), so a notification never sits there for a message
/// they've already seen. `Platform`-guarded the same way the rest of this file
/// implicitly is via the plugin's own no-ops on unsupported platforms; imported
/// directly here only because dismissing needs no platform-specific branch.
Future<void> clearNotificationFor(String conversationId) async {
  if (Platform.isAndroid || Platform.isIOS) {
    await _plugin.cancel(_notificationIdFor(conversationId));
  }
}

/// The FCM background handler (push_notifications.dart) runs in its own fresh Dart
/// isolate — no shared state with the app's main isolate, including whatever this
/// same plugin instance did there — so it needs its own minimal `initialize()` call
/// before `showNewMessageNotification` will actually work. No tap handler and no
/// permission prompts here (deliberately): a background isolate has no navigation
/// to hand a tapped conversation id to anyway (tapping cold-starts the app into
/// `main()`, where `initLocalNotifications`'s own handler takes over), and
/// permissions were already granted (or not) the first time the app was ever
/// opened in the foreground — nothing to (re-)request from here.
Future<void> ensurePluginInitializedForBackgroundIsolate() async {
  const androidInit = AndroidInitializationSettings('@mipmap/ic_launcher');
  const iosInit = DarwinInitializationSettings();
  await _plugin.initialize(
    const InitializationSettings(android: androidInit, iOS: iosInit),
  );
}
