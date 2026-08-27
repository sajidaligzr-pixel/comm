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

/// A tapped notification's payload, decoded — either a message (has
/// `conversationId`) or a new-device login approval request (`openDevices`,
/// docs/07-auth-architecture.md's device-approval section; that notification
/// carries no conversation to jump to, just "go see the Devices screen").
class NotificationTap {
  final String? conversationId;
  final bool openDevices;
  const NotificationTap({this.conversationId, this.openDevices = false});
}

NotificationTap? _decodeTapPayload(String? raw) {
  if (raw == null || raw.isEmpty) return null;
  try {
    final decoded = jsonDecode(raw);
    if (decoded is! Map<String, dynamic>) return null;
    if (decoded['type'] == 'login_pending') {
      return const NotificationTap(openDevices: true);
    }
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
  final launchDetails = await _plugin.getNotificationAppLaunchDetails();
  if (launchDetails?.didNotificationLaunchApp ?? false) {
    final tap = _decodeTapPayload(launchDetails?.notificationResponse?.payload);
    if (tap != null) onTap(tap);
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
    payload: jsonEncode({'type': 'message', 'conversationId': conversationId}),
  );
}

/// New-device login approval (docs/07-auth-architecture.md's device-approval
/// section) — the one notification that has to reach an EXISTING device even
/// fully backgrounded/closed, since that's the only way most people will ever
/// notice a sign-in attempt they didn't just make. Uses the same messages
/// channel/importance as `showNewMessageNotification` above (still just a plain
/// tray notification, not a call-style ring) but its own fixed id — unlike a
/// per-conversation message, there's only ever one meaningful "you have a pending
/// sign-in request" notification at a time, so a second one replaces the first
/// rather than stacking.
Future<void> showLoginPendingNotification({
  required String title,
  required String body,
}) async {
  const androidDetails = AndroidNotificationDetails(
    _channelId,
    _channelName,
    importance: Importance.high,
    priority: Priority.high,
  );
  const iosDetails = DarwinNotificationDetails();
  await _plugin.show(
    0x6c6f676e, // 'logn' — fixed, distinct from any conversationId-derived id
    title,
    body,
    const NotificationDetails(android: androidDetails, iOS: iosDetails),
    payload: jsonEncode({'type': 'login_pending'}),
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
