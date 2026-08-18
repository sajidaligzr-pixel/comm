/// System notifications — shown for a live WS event while the app is foregrounded
/// or backgrounded-but-still-running (message_notifier.dart), AND for a push
/// notification woken from a killed/deeply-backgrounded state
/// (push_notifications.dart's foreground listener and background handler both call
/// straight into the same `showNewMessageNotification`/`showIncomingCallNotification`
/// below) — one rendering path regardless of which triggered it, so a notification
/// looks the same either way.
library;

import 'dart:io' show Platform;
import 'package:flutter_local_notifications/flutter_local_notifications.dart';

final FlutterLocalNotificationsPlugin _plugin =
    FlutterLocalNotificationsPlugin();

const _channelId = 'comm_messages';
const _channelName = 'Messages';
const _androidChannel = AndroidNotificationChannel(
  _channelId,
  _channelName,
  description: 'New message notifications',
  importance: Importance.high,
);

// A separate, higher-urgency channel from messages — same reasoning WhatsApp's own
// two channels have: a call is time-sensitive in a way a text message isn't, and a
// user muting/downgrading message notifications shouldn't silently also downgrade
// "someone is calling you right now." No custom ringtone (Importance.max + default
// sound is already louder/more insistent than the message channel by itself);
// actual ringing while the call screen is open is handled elsewhere, this is only
// the "wake up and notice" half for when it isn't.
const _callChannelId = 'comm_calls';
const _callChannelName = 'Calls';
const _androidCallChannel = AndroidNotificationChannel(
  _callChannelId,
  _callChannelName,
  description: 'Incoming call notifications',
  importance: Importance.max,
);

/// `onTapConversationId` is called with the conversation id the user tapped a
/// notification for — wired to actual navigation by whoever calls this (see
/// main.dart), kept as a plain callback here so this file has no dependency on
/// go_router/Riverpod.
Future<void> initLocalNotifications({
  required void Function(String conversationId) onTapConversationId,
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
      final conversationId = response.payload;
      if (conversationId != null && conversationId.isNotEmpty) {
        onTapConversationId(conversationId);
      }
    },
  );

  final androidImpl = _plugin
      .resolvePlatformSpecificImplementation<
        AndroidFlutterLocalNotificationsPlugin
      >();
  await androidImpl?.createNotificationChannel(_androidChannel);
  await androidImpl?.createNotificationChannel(_androidCallChannel);
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
    payload: conversationId,
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

// Salted differently from `_notificationIdFor` (keyed by callId, not
// conversationId) so a ring notification and a message notification for the same
// conversation never collide and silently replace one another.
int _callNotificationIdFor(String callId) =>
    ('call:$callId').hashCode & 0x7fffffff;

/// The push path's answer to "ring even while closed" — see push_notifications.
/// dart's docstring on the overall scope/limits of this (a system notification, not
/// a full-screen locked-device calling UI). Tapping it opens the app to
/// `conversationId` the same way a message notification does; from there,
/// call_controller.dart's `checkPendingCall` (run on every reconnect) is what
/// actually surfaces the real incoming-call screen if the call is still live.
Future<void> showIncomingCallNotification({
  required String callId,
  required String conversationId,
  required String callerName,
}) async {
  const androidDetails = AndroidNotificationDetails(
    _callChannelId,
    _callChannelName,
    importance: Importance.max,
    priority: Priority.max,
    category: AndroidNotificationCategory.call,
    fullScreenIntent: false,
  );
  const iosDetails = DarwinNotificationDetails(
    interruptionLevel: InterruptionLevel.timeSensitive,
  );
  await _plugin.show(
    _callNotificationIdFor(callId),
    'Incoming call',
    '$callerName is calling you',
    const NotificationDetails(android: androidDetails, iOS: iosDetails),
    payload: conversationId,
  );
}

/// Called once the call is answered/declined/timed out (call_controller.dart), so
/// the tray notification doesn't linger advertising a call that's already over.
Future<void> clearCallNotification(String callId) async {
  if (Platform.isAndroid || Platform.isIOS) {
    await _plugin.cancel(_callNotificationIdFor(callId));
  }
}

/// The FCM background handler (push_notifications.dart) runs in its own fresh Dart
/// isolate — no shared state with the app's main isolate, including whatever this
/// same plugin instance did there — so it needs its own minimal
/// `initialize()` call before `showNewMessageNotification`/
/// `showIncomingCallNotification` will actually work. No tap handler and no
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
