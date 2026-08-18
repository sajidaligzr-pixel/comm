/// System notifications — shown for a live WS event while the app is foregrounded
/// or backgrounded-but-still-running (message_notifier.dart), AND for a push
/// notification woken from a killed/deeply-backgrounded state
/// (push_notifications.dart's foreground listener and background handler both call
/// straight into the same `showNewMessageNotification`/`showIncomingCallNotification`
/// below) — one rendering path regardless of which triggered it, so a notification
/// looks the same either way.
library;

import 'dart:async' show unawaited;
import 'dart:convert';
import 'dart:io' show Platform;
import 'package:flutter_local_notifications/flutter_local_notifications.dart';

import '../../api/api_client.dart';
import '../../api/calls_api.dart';

final FlutterLocalNotificationsPlugin _plugin =
    FlutterLocalNotificationsPlugin();

// Ids sent back in a `NotificationResponse.actionId` when the corresponding button
// (below, on the call notification) is tapped — never used for anything else, so a
// plain notification-body tap always arrives with `actionId == null`.
const _acceptActionId = 'accept';
const _declineActionId = 'decline';

// "_v2" on both ids: an Android notification channel's sound/importance/etc. are
// locked in by the OS the first time it's created — a later change to this file
// (like the custom `sound:` below, added after both channels already existed on
// test devices from earlier builds) never takes effect on an install that already
// has the old channel, no matter how the app is updated. Bumping the id is what
// actually forces Android to create a fresh channel with the new settings; an
// already-installed device without a fresh reinstall would otherwise silently keep
// ringing/chiming with the old (default) sound forever. Any future change to either
// channel's config needs the same bump.
const _channelId = 'comm_messages_v2';
const _channelName = 'Messages';
const _androidChannel = AndroidNotificationChannel(
  _channelId,
  _channelName,
  description: 'New message notifications',
  importance: Importance.high,
  sound: RawResourceAndroidNotificationSound('message'),
);

// A separate, higher-urgency channel from messages — same reasoning WhatsApp's own
// two channels have: a call is time-sensitive in a way a text message isn't, and a
// user muting/downgrading message notifications shouldn't silently also downgrade
// "someone is calling you right now." `sound`/`audioAttributesUsage` here are what
// make the tray notification itself actually ring — previously this channel had no
// custom sound at all (just the OS's generic one-shot "ding," same as any other
// notification), which is exactly what was reported ("ringtone only rings when the
// app is opened, not from the notification"): the real looping ringtone
// (call_controller.dart's `_ringtonePlayer`) only ever runs once Dart/CallController
// is actually alive and in the incoming-call state, which a bare tray notification
// alone never triggers. This can't loop indefinitely the way a real phone dialer
// does — Android's notification sound API is one-shot per post, full continuous
// ringing needs registering as a system-level calling app (ConnectionService), a
// much larger undertaking — but it now plays the actual ringtone audio, routed to
// the ring volume stream via `notificationRingtone` (matching a real call's audio
// behavior), the instant the notification posts. Combined with `fullScreenIntent`
// (below) actually launching the app over a locked/off screen, THAT case — the one
// that matters most — gets the real, fully-looping in-app ringtone too, same as
// tapping the notification by hand always did.
const _callChannelId = 'comm_calls_v2';
const _callChannelName = 'Calls';
const _androidCallChannel = AndroidNotificationChannel(
  _callChannelId,
  _callChannelName,
  description: 'Incoming call notifications',
  importance: Importance.max,
  sound: RawResourceAndroidNotificationSound('ringtone'),
  audioAttributesUsage: AudioAttributesUsage.notificationRingtone,
);

/// A tapped notification's payload, decoded — `isCall` is the whole reason this
/// exists as a class instead of the bare conversation-id string the payload used
/// to be: a call and a message tap need genuinely different handling (main.dart),
/// and there was no way to tell them apart before this. `callId` is only present
/// for a call tap — needed to call `clearCallNotification`/pass through to
/// `checkPendingCall`'s caller if it ever wants it, though today's handling
/// (main.dart) only needs `isCall` itself to decide what to do.
class NotificationTap {
  final String conversationId;
  final bool isCall;
  final String? callId;

  /// Which action button was tapped, if any — `'accept'` (see main.dart's `onTap`
  /// wiring) or null for a plain tap on the notification body itself. `'decline'`
  /// is never seen here: that action has `showsUserInterface: false` and is instead
  /// handled entirely by `_backgroundNotificationResponseHandler` below, which
  /// fires without ever launching/resuming this app at all — exactly the point.
  final String? actionId;
  const NotificationTap({
    required this.conversationId,
    required this.isCall,
    this.callId,
    this.actionId,
  });
}

NotificationTap? _decodeTapPayload(String? raw, {String? actionId}) {
  if (raw == null || raw.isEmpty) return null;
  try {
    final decoded = jsonDecode(raw);
    if (decoded is! Map<String, dynamic>) return null;
    final conversationId = decoded['conversationId'] as String?;
    if (conversationId == null || conversationId.isEmpty) return null;
    return NotificationTap(
      conversationId: conversationId,
      isCall: decoded['type'] == 'call',
      callId: decoded['callId'] as String?,
      actionId: actionId,
    );
  } catch (_) {
    return null;
  }
}

/// Best-effort decline fired straight from the background isolate Android spawns
/// for the "Decline" action — no app UI involved at all, matching WhatsApp's own
/// notification-decline behavior. Uses the REST path (`POST /api/calls/decline`),
/// not a WS send: there is no live socket in this isolate to send one over, the
/// exact reasoning push_notifications.dart's `_ackDelivered` already established
/// for delivery acks. `ApiClient.initialize()` builds a fresh instance backed by
/// the same on-disk persisted cookie jar here — same per-isolate re-init this file's
/// `ensurePluginInitializedForBackgroundIsolate` already does for the plugin itself.
Future<void> _declineFromBackground(
  String conversationId,
  String callId,
) async {
  try {
    final client = await ApiClient.initialize();
    await CallsApi(client).decline(conversationId, callId, 'declined');
  } catch (_) {
    // Best-effort — a missed decline here just means the call keeps ringing until
    // the caller's own 45s no-answer timeout gives up, not a broken experience.
  }
}

/// Handles ONLY the "Decline" action button — see `NotificationTap.actionId`'s own
/// docstring for why "Accept" never reaches this function at all.
@pragma('vm:entry-point')
void _backgroundNotificationResponseHandler(NotificationResponse response) {
  if (response.actionId != _declineActionId) return;
  final tap = _decodeTapPayload(response.payload, actionId: response.actionId);
  if (tap == null || !tap.isCall || tap.callId == null) return;
  unawaited(_declineFromBackground(tap.conversationId, tap.callId!));
}

/// `onTap` is called with what the user tapped — wired to actual navigation/call
/// handling by whoever calls this (see main.dart), kept as a plain callback here
/// so this file has no dependency on go_router/Riverpod.
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
      final tap = _decodeTapPayload(
        response.payload,
        actionId: response.actionId,
      );
      if (tap != null) onTap(tap);
    },
    // Only ever actually invoked for the "Decline" action (see that handler's own
    // docstring) — "Accept" has `showsUserInterface: true`, which routes through
    // the callback above (or the cold-start check below) instead, same as a plain
    // tap on the notification body.
    onDidReceiveBackgroundNotificationResponse:
        _backgroundNotificationResponseHandler,
  );

  // The tap that COLD-STARTS the app from a killed state never reaches the
  // callback above — flutter_local_notifications' own documented gap, since the
  // plugin isn't wired up yet at the instant that tap actually happened. This is
  // the other half: checked once, right here, after `initialize()` has resolved
  // (this function is called from main.dart before the first frame, same timing
  // guarantee `getNotificationAppLaunchDetails` needs to be reliable). Found live
  // as exactly the reported bug: a tapped call notification opened the app but
  // never showed the incoming-call screen — because nothing had told the app a
  // notification was even tapped in the first place.
  final launchDetails = await _plugin.getNotificationAppLaunchDetails();
  if (launchDetails?.didNotificationLaunchApp ?? false) {
    final tap = _decodeTapPayload(
      launchDetails?.notificationResponse?.payload,
      actionId: launchDetails?.notificationResponse?.actionId,
    );
    if (tap != null) onTap(tap);
  }

  final androidImpl = _plugin
      .resolvePlatformSpecificImplementation<
        AndroidFlutterLocalNotificationsPlugin
      >();
  await androidImpl?.createNotificationChannel(_androidChannel);
  await androidImpl?.createNotificationChannel(_androidCallChannel);
  // Android 13+ (API 33) requires this to be requested at runtime, same as any
  // other dangerous permission — silently no-ops on older Android/other platforms.
  await androidImpl?.requestNotificationsPermission();
  // Android 14+ (API 34) separately gates `fullScreenIntent` (showIncomingCallNotification
  // below) behind this — declaring USE_FULL_SCREEN_INTENT in the manifest is no longer
  // enough by itself. On older Android this is granted automatically at install time and
  // this call is a no-op; no-ops on non-Android platforms too.
  await androidImpl?.requestFullScreenIntentPermission();

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
/// a full-screen locked-device calling UI). Tapping the notification body opens the
/// app and — unlike a message notification, which navigates to the conversation —
/// triggers `CallController.checkPendingCall` directly (main.dart's `onTap`
/// handling), which is what actually surfaces the real, full-screen incoming-call
/// overlay if the call is still live. No navigation needed for that: `CallOverlay`
/// is mounted app-wide (app/app.dart) and shows itself the instant the call state
/// changes, on top of whatever screen happens to be underneath.
///
/// Also carries WhatsApp's own Accept/Decline action buttons, right on the
/// notification itself — Decline (`showsUserInterface: false`) fires and dismisses
/// without ever opening the app at all (`_backgroundNotificationResponseHandler`
/// above); Accept (`showsUserInterface: true`) opens the app straight into
/// `CallController.acceptPendingCall` (main.dart's `onTap` handling), answering
/// immediately rather than just showing the incoming-call screen for a second tap.
///
/// `fullScreenIntent: true` is what actually wakes a sleeping/locked phone for this
/// one notification specifically (every other notification in this app leaves the
/// screen alone) — combined with MainActivity's `showWhenLocked`/`turnScreenOn`
/// manifest flags and the `USE_FULL_SCREEN_INTENT` permission (AndroidManifest.xml),
/// Android turns the screen on and launches the app directly over the lock screen,
/// same as a real incoming call. Without this, a call notification while the screen
/// is off just sits there unseen until the phone is unlocked some other way — exactly
/// the reported "phone doesn't turn on/show the call" gap.
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
    fullScreenIntent: true,
    actions: [
      AndroidNotificationAction(
        _declineActionId,
        'Decline',
        showsUserInterface: false,
        cancelNotification: true,
      ),
      AndroidNotificationAction(
        _acceptActionId,
        'Accept',
        showsUserInterface: true,
        cancelNotification: true,
      ),
    ],
  );
  const iosDetails = DarwinNotificationDetails(
    interruptionLevel: InterruptionLevel.timeSensitive,
  );
  await _plugin.show(
    _callNotificationIdFor(callId),
    'Incoming call',
    '$callerName is calling you',
    const NotificationDetails(android: androidDetails, iOS: iosDetails),
    payload: jsonEncode({
      'type': 'call',
      'conversationId': conversationId,
      'callId': callId,
    }),
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
