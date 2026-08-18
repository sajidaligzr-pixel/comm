/// FCM (Firebase Cloud Messaging) — the piece that makes "notified about a message
/// or an incoming call while this app is fully closed" real, not just backgrounded-
/// but-still-running (which local_notifications.dart's live-WS-driven path already
/// covered). See apps/worker/src/realtime/push-dispatch.ts's own docstring for the
/// server half and why every push here is data-only rather than a `notification`
/// payload: Android auto-displays (and never wakes this app's own code for) a
/// `notification` message while backgrounded, which would work fine for a plain
/// message banner but can't run the code an incoming call needs. Both cases funnel
/// through the exact same `showNewMessageNotification`/`showIncomingCallNotification`
/// (local_notifications.dart) a live WS event uses, so a notification looks
/// identical regardless of which path produced it.
///
/// Scope, stated plainly: this makes the phone actually notify/ring while closed —
/// it does not build a full-screen, over-the-lock-screen calling UI the way a phone
/// app's native dialer gets to (that needs a bespoke Android `ConnectionService` +
/// full-screen-intent Activity, a much larger, separate undertaking). Tapping the
/// call notification opens this app; from there, `CallController.checkPendingCall`
/// (run on every WS reconnect) surfaces the real in-app ringing screen if the call
/// is still within its window — a real, working answer within that window, just not
/// a lock-screen takeover.
///
/// Split into two entry points, called from two different moments (main.dart /
/// chats_list_screen.dart) rather than one: the pieces below need Firebase itself,
/// never an authenticated session, and must run before `runApp` regardless of
/// whether anyone is signed in yet; [registerPushToken] needs `POST /api/push/
/// subscribe`, which does need one, and re-runs every time a signed-in session
/// starts (this device's remembered login, or a fresh one), not just once ever.
library;

import 'package:firebase_core/firebase_core.dart';
import 'package:firebase_messaging/firebase_messaging.dart';
import 'package:flutter/widgets.dart' show WidgetsFlutterBinding;
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../api/push_api.dart';
import '../calls/call_controller.dart' show callControllerProvider;
import '../calls/call_state.dart' show CallPhase;
import 'local_notifications.dart';

/// Registered from main.dart, before `runApp` — required by firebase_messaging so
/// this top-level function is reachable from the separate isolate Android spawns to
/// run it while the app's own process may not even exist right now. `@pragma('vm:
/// entry-point')` is load-bearing: without it, AOT tree-shaking on a release build
/// can strip this function since nothing in the normal call graph appears to
/// reference it (the reference only exists via a native callback registration).
@pragma('vm:entry-point')
Future<void> firebaseMessagingBackgroundHandler(RemoteMessage message) async {
  WidgetsFlutterBinding.ensureInitialized();
  await Firebase.initializeApp();
  await ensurePluginInitializedForBackgroundIsolate();
  await _showFromData(message.data);
}

Future<void> _showFromData(Map<String, dynamic> data) async {
  final type = data['type'] as String?;
  if (type == 'call') {
    final callId = data['callId'] as String?;
    final conversationId = data['conversationId'] as String?;
    if (callId == null || conversationId == null) return;
    await showIncomingCallNotification(
      callId: callId,
      conversationId: conversationId,
      callerName: data['fromDisplayName'] as String? ?? 'Someone',
    );
  } else if (type == 'message') {
    final conversationId = data['conversationId'] as String?;
    if (conversationId == null) return;
    await showNewMessageNotification(
      conversationId: conversationId,
      title: data['title'] as String? ?? 'Comm',
      body: data['body'] as String? ?? 'New message',
    );
  }
}

/// Firebase init + the background handler registration + the foreground listener —
/// called once from main.dart, before sign-in is known one way or the other (same
/// "the app is usable long before this resolves" reasoning `initLocalNotifications`
/// already documents there; this doesn't block the first frame either). `container`
/// is the same app-wide `ProviderContainer` main.dart already threads through to
/// `initLocalNotifications`'s tap handler — used here only to check, in the
/// foreground listener below, whether a live WS `call.ring` already put
/// `CallController` into the incoming-call state before this push's data arrived,
/// so a call that's already ringing on screen doesn't ALSO pop a redundant tray
/// notification over it.
Future<void> initPushNotifications(ProviderContainer container) async {
  await Firebase.initializeApp();
  FirebaseMessaging.onBackgroundMessage(firebaseMessagingBackgroundHandler);

  FirebaseMessaging.onMessage.listen((message) async {
    final type = message.data['type'] as String?;
    if (type == 'call' &&
        container.read(callControllerProvider).phase != CallPhase.idle) {
      // The live WS call.ring already handled this (or this device is already on a
      // different call and would just reject as busy) — showing a tray notification
      // on top of the ringing screen already on screen would be redundant, not
      // informative.
      return;
    }
    await _showFromData(message.data);
  });
}

/// Requests notification permission and registers this device's current FCM token
/// — called once a session is actually signed in (chats_list_screen.dart's
/// initState, alongside the other "now that we know who's signed in" bootstrap
/// calls it already makes), since `POST /api/push/subscribe` needs an authenticated
/// device. Safe to call again on every subsequent app launch/sign-in — re-
/// registering the same still-valid token is a harmless no-op server-side (push/
/// service.ts's `savePushSubscription` upserts by device id).
Future<void> registerPushToken(PushApi pushApi) async {
  final messaging = FirebaseMessaging.instance;
  final settings = await messaging.requestPermission(
    alert: true,
    badge: true,
    sound: true,
  );
  if (settings.authorizationStatus == AuthorizationStatus.denied) return;

  Future<void> register(String? token) async {
    if (token == null) return;
    try {
      await pushApi.subscribeFcm(token);
    } catch (_) {
      // Best-effort, same as every other "nice to have, not load-bearing for core
      // functionality" background call in this app (message read receipts, etc.) —
      // a failed registration here means push notifications don't work until the
      // next successful attempt, never a broken chat experience.
    }
  }

  await register(await messaging.getToken());
  // A token can rotate at any time (app reinstall, restored-from-backup, FCM's own
  // periodic rotation) — re-registering keeps the server's copy from silently going
  // stale, the same reason apps/web's own subscription re-subscribes on browser
  // rotation.
  messaging.onTokenRefresh.listen(register);
}
