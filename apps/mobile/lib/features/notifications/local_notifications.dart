/// Local (in-process) system notifications — the buildable-now half of "get
/// notified about a new message." A full push path (delivery while the app is
/// fully killed, not just backgrounded) needs FCM (Android) / APNs (iOS) device
/// tokens and a server-side dispatch addition — real, separate work blocked on
/// Firebase/Apple accounts this project doesn't have credentials for yet (see
/// README's "Not built yet"). This covers what's real without either: the moment a
/// `new` WS event arrives (message_notifier.dart) for a conversation that isn't
/// the one currently on screen, show a real system notification via
/// `flutter_local_notifications` — works while the app is foregrounded or
/// backgrounded-but-still-running, same as any other app's local notification.
library;

import 'dart:io' show Platform;
import 'package:flutter_local_notifications/flutter_local_notifications.dart';

final FlutterLocalNotificationsPlugin _plugin = FlutterLocalNotificationsPlugin();

const _channelId = 'comm_messages';
const _channelName = 'Messages';
const _androidChannel = AndroidNotificationChannel(
  _channelId,
  _channelName,
  description: 'New message notifications',
  importance: Importance.high,
);

/// `onTapConversationId` is called with the conversation id the user tapped a
/// notification for — wired to actual navigation by whoever calls this (see
/// main.dart), kept as a plain callback here so this file has no dependency on
/// go_router/Riverpod.
Future<void> initLocalNotifications({required void Function(String conversationId) onTapConversationId}) async {
  const androidInit = AndroidInitializationSettings('@mipmap/ic_launcher');
  const iosInit = DarwinInitializationSettings(requestAlertPermission: false, requestBadgePermission: false, requestSoundPermission: false);
  await _plugin.initialize(
    const InitializationSettings(android: androidInit, iOS: iosInit),
    onDidReceiveNotificationResponse: (response) {
      final conversationId = response.payload;
      if (conversationId != null && conversationId.isNotEmpty) onTapConversationId(conversationId);
    },
  );

  final androidImpl = _plugin.resolvePlatformSpecificImplementation<AndroidFlutterLocalNotificationsPlugin>();
  await androidImpl?.createNotificationChannel(_androidChannel);
  // Android 13+ (API 33) requires this to be requested at runtime, same as any
  // other dangerous permission — silently no-ops on older Android/other platforms.
  await androidImpl?.requestNotificationsPermission();

  final iosImpl = _plugin.resolvePlatformSpecificImplementation<IOSFlutterLocalNotificationsPlugin>();
  await iosImpl?.requestPermissions(alert: true, badge: true, sound: true);
}

int _notificationIdFor(String conversationId) => conversationId.hashCode & 0x7fffffff;

/// Shows one notification for a conversation, replacing any still-showing
/// notification for that same conversation (same id derived from the conversation
/// id) rather than stacking one per message — matches how a chat app's
/// notifications are normally grouped per-conversation, not per-message.
Future<void> showNewMessageNotification({required String conversationId, required String title, required String body}) async {
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
