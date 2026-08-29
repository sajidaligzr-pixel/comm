/// FCM (Firebase Cloud Messaging) — the piece that makes "notified about a message
/// or an incoming call while this app is fully closed" real, not just backgrounded-
/// but-still-running (which local_notifications.dart's live-WS-driven path already
/// covered). See apps/worker/src/realtime/push-dispatch.ts's own docstring for the
/// server half and why every push here is data-only rather than a `notification`
/// payload: Android auto-displays (and never wakes this app's own code for) a
/// `notification` message while backgrounded, which would work fine for a plain
/// message banner but can't run the code an incoming call needs. Both cases funnel
/// through `showNewMessageNotification` (local_notifications.dart, messages) or
/// `showIncomingCall` (features/calls/call_kit.dart, calls) — the same rendering
/// each of those uses for a live WS-driven notification too (message_notifier.dart),
/// so a notification looks identical regardless of which path produced it.
///
/// Calls specifically: `showIncomingCall` is a genuine phone-call-style ring (Telecom
/// ConnectionService on Android via flutter_callkit_incoming — see that file's own
/// docstring), not just a tray notification — it wakes a locked/off screen and rings
/// continuously until answered/declined/timed out, matching a real incoming call.
///
/// Split into two entry points, called from two different moments (main.dart /
/// chats_list_screen.dart) rather than one: the pieces below need Firebase itself,
/// never an authenticated session, and must run before `runApp` regardless of
/// whether anyone is signed in yet; [registerPushToken] needs `POST /api/push/
/// subscribe`, which does need one, and re-runs every time a signed-in session
/// starts (this device's remembered login, or a fresh one), not just once ever.
library;

import 'dart:async' show unawaited;

import 'package:firebase_core/firebase_core.dart';
import 'package:firebase_messaging/firebase_messaging.dart';
import 'package:flutter/widgets.dart' show WidgetsFlutterBinding;
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../api/api_client.dart';
import '../../api/messages_api.dart';
import '../../api/push_api.dart';
import '../../app/providers.dart' show realtimeClientProvider, currentOpenConversationIdProvider;
import '../calls/call_controller.dart' show callControllerProvider;
import '../calls/call_kit.dart' show showIncomingCall;
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
    await showIncomingCall(
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
    final messageId = data['messageId'] as String?;
    if (messageId != null) unawaited(_ackDelivered(messageId));
  }
}

/// Best-effort delivered-ack fired the instant this device is proven to have the
/// message — receiving the push at all (background isolate or foreground) already
/// means it reached this device, the same "this device has the ciphertext" signal
/// thread_screen.dart's own `markDelivered` call is built on (see its docstring).
/// This closes the one gap that had no equivalent before: a message arriving while
/// the app is fully closed/backgrounded previously went unacked until the recipient
/// happened to open a screen with a live WS listener (chats_list_screen.dart/
/// thread_screen.dart) — which could be much later than "delivered" should mean, or
/// never if they only ever glance at the tray notification. Found live as exactly
/// the reported bug: the sender stayed on a single tick even after the recipient's
/// phone had visibly already shown the notification.
///
/// Safe to call from EITHER isolate: `ApiClient.initialize()` is idempotent in the
/// main isolate (returns the already-initialized singleton) and builds a fresh
/// instance backed by the same on-disk persisted cookie jar when called from the
/// background isolate — mirrors `ensurePluginInitializedForBackgroundIsolate`'s own
/// per-isolate re-init, same reasoning.
Future<void> _ackDelivered(String messageId) async {
  try {
    final client = await ApiClient.initialize();
    await MessagesApi(client).markDelivered(messageId);
  } catch (_) {
    // Best-effort — a missed ack here just means the tick catches up the next time
    // this device opens a screen with a live WS listener, same as before this existed.
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
    // A conversation already open on screen has its own live WS listener
    // (message_notifier.dart, thread_screen.dart) rendering/acking this exact
    // message directly — a tray notification on top of it would be pure noise.
    // Only skips the notification itself; the reconnect logic below still runs
    // regardless, since a push arriving at all means the live socket missed
    // something, and the open thread needs that resync just as much as any
    // other screen would.
    if (type == 'message' &&
        message.data['conversationId'] == container.read(currentOpenConversationIdProvider)) {
      return;
    }
    if (type == 'call' &&
        container.read(callControllerProvider).phase != CallPhase.idle) {
      // The live WS call.ring already handled this (or this device is already on a
      // different call and would just reject as busy) — showing a tray notification
      // on top of the ringing screen already on screen would be redundant, not
      // informative.
      return;
    }

    // This listener only ever fires while the app is genuinely foregrounded — but a
    // push arriving at all is itself proof something happened server-side that this
    // device's own live WS connection apparently never delivered (a 'new'/'call.ring'
    // event chats_list_screen.dart/call_controller.dart never saw). Found live as
    // exactly the reported bug: a call/message notification appears in the tray
    // while the app sits right there behind it showing nothing new — the tray
    // notification was the only thing this listener ever did, with no path back
    // into the app's own state. `ws_client.dart`'s `reconnect` docstring covers why
    // this happens (Android/iOS can freeze a backgrounded socket without this app
    // ever finding out); `didChangeAppLifecycleState` already applies the identical
    // fix at the resume instant (app/app.dart) — this applies it again here, at the
    // moment there's direct evidence of a miss rather than only at resume. Once the
    // fresh socket's 'connection.open' fires, chats_list_screen's and
    // call_controller's own listeners resync everything exactly as a resume would;
    // nothing new needs wiring here for that part.
    //
    // Skipped mid-call (re-read, not reused from the guard above — a call could have
    // been answered via another path in the moment since): tearing the socket down
    // while ICE signaling is live could delay/drop a candidate. Also lightly
    // debounced — a burst of several pushes in the same couple of seconds (e.g.
    // someone sending 3 messages in a row) only needs one reconnect to catch the
    // whole burst up, not one each.
    final callIdle =
        container.read(callControllerProvider).phase == CallPhase.idle;
    final now = DateTime.now();
    final recentlyReconnected =
        _lastForcedReconnect != null &&
        now.difference(_lastForcedReconnect!) < const Duration(seconds: 3);
    if (callIdle && !recentlyReconnected) {
      _lastForcedReconnect = now;
      unawaited(container.read(realtimeClientProvider).reconnect());
    }

    await _showFromData(message.data);
  });
}

DateTime? _lastForcedReconnect;

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
