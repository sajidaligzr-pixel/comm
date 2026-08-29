/// Native "ring like an actual phone call" UI, for exactly the case local
/// notifications (features/notifications/local_notifications.dart) can't cover: a
/// call push arriving while the app is fully closed, or backgrounded with the
/// screen already on and unlocked. Android's notification API only ever plays a
/// sound once per post — there is no way to loop it indefinitely from a plain
/// notification without the app being registered as a system-level calling app.
/// `flutter_callkit_incoming` wraps exactly that registration (Telecom
/// ConnectionService + a foreground service on Android, CallKit on iOS) rather than
/// this app hand-rolling the notoriously fragile PhoneAccount/ConnectionService
/// plumbing directly — see pubspec.yaml's own comment on why.
///
/// iOS closed-app ringing (docs/13-roadmap.md's iOS closed-app-ringing pass) works
/// through a genuinely different mechanism from Android's, and most of it never
/// touches this file at all: an incoming call arrives as an Apple PushKit VoIP
/// push, handled entirely natively in ios/Runner/AppDelegate.swift
/// (`didReceiveIncomingPushWith`), which reports straight to CallKit — Flutter
/// isn't even running yet at that point, so there's no Dart code to call into. What
/// DOES belong here for iOS: the VoIP device-token bookkeeping below
/// (`_uploadVoipToken`/the `actionDidUpdateDevicePushTokenVoip` case), and
/// `initCallKit`'s Accept/Decline event listener, which fires once Flutter is
/// running again — CallKit answering a call always brings this app to the
/// foreground per Apple's own design, so that's guaranteed by the time the user
/// actually taps Accept/Decline on the native UI. `showIncomingCall` stays
/// Android-only below: iOS never receives the FCM `type: 'call'` push
/// `showIncomingCall` reacts to once its VoIP token is registered (see
/// apps/worker's `handleCallRing`), so there's no scenario where iOS needs it.
///
/// Scope, stated plainly, same spirit as push_notifications.dart's own: this covers
/// the call notification/ringing UI a push (or a cold/background app) shows. The
/// live in-app incoming-call screen (CallOverlay, driven by CallController's own
/// state machine) is untouched — this file never runs while that's what's on
/// screen, only when nothing else is telling the user a call is coming in.
library;

import 'dart:async' show unawaited;
import 'dart:io' show Platform;

import 'package:flutter_callkit_incoming/entities/entities.dart';
import 'package:flutter_callkit_incoming/flutter_callkit_incoming.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../api/api_client.dart';
import '../../api/calls_api.dart';
import '../../app/providers.dart' show pushApiProvider;
import 'call_controller.dart' show callControllerProvider;

/// Matches `CallController._ringTimeout` (call_controller.dart) — after this long
/// with no answer, flutter_callkit_incoming fires `Event.actionCallTimeout` and
/// shows its own missed-call notification on this device. No separate server call
/// needed here: the caller's own ring timer (`startCall`'s `_ringTimer`) already
/// gives up and sends `call.end` independently after the same 45s, so this device
/// timing out locally doesn't need to tell anyone anything.
const _ringTimeoutMs = 45000;

/// Best-effort decline straight to the server — deliberately NOT routed through
/// `CallController.rejectCall()`, which requires `state.call` to already be
/// populated. The whole point of this file is covering the case where nothing has
/// told `CallController` about this call at all yet (app was killed/backgrounded,
/// no live WS delivery) — going through the REST path directly (same one
/// local_notifications.dart's old background-isolate Decline handler used) works
/// regardless of whatever CallController's local state happens to be.
Future<void> _declineFromEvent(String conversationId, String callId) async {
  try {
    final client = await ApiClient.initialize();
    await CallsApi(client).decline(conversationId, callId, 'declined');
  } catch (_) {
    // Same reasoning as every other best-effort notification side effect in this
    // app: a missed decline here just means the call rings out to the caller's own
    // no-answer timeout instead of stopping immediately, not a broken experience.
  }
}

/// Uploads a freshly-issued/rotated VoIP device token to this app's own server
/// (POST /api/push/voip-token, apps/worker's handleCallRing is what actually sends
/// through it) — mirrors push_notifications.dart's own FCM-token upload, just a
/// separate route/table (see VoipPushToken's own schema doc comment for why).
/// Best-effort: a transient failure here just means this device stays on the FCM
/// call-push fallback (handleCallRing's own docstring) until the next token event
/// or app launch retries it, not a broken call path.
Future<void> _uploadVoipToken(ProviderContainer container, String token) async {
  if (token.isEmpty) return; // didInvalidatePushTokenFor's empty-string case — nothing to upload
  try {
    await container.read(pushApiProvider).subscribeVoip(token);
  } catch (_) {}
}

/// Re-reads the plugin's natively-cached VoIP token and uploads it — used by
/// `actionDidUpdateDevicePushTokenVoip`'s handler above, since 3.x's version of
/// that event no longer carries the token value inline (see that case's own
/// comment).
Future<void> _refreshAndUploadVoipToken(ProviderContainer container) async {
  final token = await FlutterCallkitIncoming.getDevicePushTokenVoIP();
  if (token != null) unawaited(_uploadVoipToken(container, token));
}

/// Registers the Accept/Decline event listener (and, on Android, the extra runtime
/// permissions `showIncomingCall` needs) — call once from main.dart, alongside
/// `initPushNotifications`/`initLocalNotifications`. Runs on iOS too now (see this
/// file's own docstring on what iOS actually needs from here) — only the
/// Android-specific permission requests below stay platform-gated.
Future<void> initCallKit(ProviderContainer container) async {
  // 3.x replaced the old `Event` enum + generic `.event`/`.body` map with a
  // sealed `CallEvent` class hierarchy — one concrete subtype per event,
  // matched below with Dart 3 pattern-matching cases instead of a plain enum
  // switch. Functionally equivalent to the old handling, just typed.
  FlutterCallkitIncoming.onEvent.listen((event) {
    if (event == null) return;
    switch (event) {
      case CallEventActionCallAccept():
        // Same entry point the old notification "Accept" action button used —
        // catches CallController up via REST if nothing has told it about this
        // call yet, then answers immediately. Safe to call even if a live WS
        // call.ring already got here first.
        unawaited(
          container.read(callControllerProvider.notifier).acceptPendingCall(),
        );
        break;
      case CallEventActionCallDecline(:final callKitParams):
        final callId = callKitParams.id;
        final conversationId =
            callKitParams.extra?['conversationId'] as String?;
        if (conversationId != null) {
          unawaited(_declineFromEvent(conversationId, callId));
        }
        // Belt-and-suspenders: if a live WS call.ring also independently put
        // CallController into its own `incoming` state for this exact call (a
        // race with the push/callkit path, same kind of race `_onRing`'s own
        // busy-guard handles at the source), clear its local ring/UI too — the
        // REST decline above already told the server regardless of this.
        final controller = container.read(callControllerProvider.notifier);
        if (container.read(callControllerProvider).call?.callId == callId) {
          controller.rejectCall('declined');
        }
        break;
      case CallEventActionDidUpdateDevicePushTokenVoip():
        // iOS only — AppDelegate.swift forwards PKPushRegistry's token here
        // (fired at launch, and again whenever Apple rotates it). Android
        // never emits this event at all. Unlike 2.x, the event itself no
        // longer carries the token value — re-fetch it from the plugin's own
        // native cache instead (same call initCallKit already makes below for
        // the cold-start case).
        unawaited(_refreshAndUploadVoipToken(container));
        break;
      case CallEventActionCallTimeout():
      case CallEventActionCallEnded():
      case CallEventActionCallIncoming():
      case CallEventActionCallStart():
      case CallEventActionCallConnected():
      case CallEventActionCallCallback():
      case CallEventActionCallToggleHold():
      case CallEventActionCallToggleMute():
      case CallEventActionCallToggleDmtf():
      case CallEventActionCallToggleGroup():
      case CallEventActionCallToggleAudioSession():
      case CallEventActionCallCustom():
        break;
    }
  });

  if (Platform.isIOS) {
    // Catch-up for the real race on cold start: PKPushRegistry registration (and
    // its didUpdate credentials callback) happens in AppDelegate's
    // didFinishLaunchingWithOptions, which can fire before Flutter's own Dart-side
    // listener above ever subscribes — getDevicePushTokenVoIP() returns whatever
    // the plugin already cached natively regardless of the event having fired
    // first, same "REST is the durable catch-up, the event is just the fast path"
    // relationship checkPendingCall (call_controller.dart) already has.
    final existing = await FlutterCallkitIncoming.getDevicePushTokenVoIP();
    if (existing != null) unawaited(_uploadVoipToken(container, existing));
  }

  if (!Platform.isAndroid) return;

  // Android 13+/14+ runtime permissions this UI needs — same two-step shape as
  // local_notifications.dart's own requestNotificationsPermission/
  // requestFullScreenIntentPermission, just through this plugin's own channel
  // (its internal permission bookkeeping is separate from
  // flutter_local_notifications', so both plugins request independently). iOS has
  // no equivalent runtime-permission step: PushKit/CallKit registration
  // (AppDelegate.swift) is all it needs.
  await FlutterCallkitIncoming.requestNotificationPermission({
    'title': 'Notification permission',
    'rationaleMessagePermission':
        'Notification permission is required to show incoming calls.',
    'postNotificationMessageRequired':
        'Notification permission is required — please allow it from Settings.',
  });
  final canUseFullScreen =
      await FlutterCallkitIncoming.canUseFullScreenIntent() as bool? ?? false;
  if (!canUseFullScreen) {
    await FlutterCallkitIncoming.requestFullIntentPermission();
  }
}

/// Shows the native incoming-call UI — called from push_notifications.dart's
/// `_showFromData`, the one place a call notification is ever posted (see that
/// file's docstring for why the live-WS path never needs this: `CallOverlay`
/// already covers it while the app is genuinely in front). No-ops on iOS (see this
/// file's own docstring).
Future<void> showIncomingCall({
  required String callId,
  required String conversationId,
  required String callerName,
}) async {
  if (!Platform.isAndroid) return;
  await FlutterCallkitIncoming.showCallkitIncoming(
    CallKitParams(
      id: callId,
      nameCaller: callerName,
      appName: 'Comm',
      type: 0, // audio call — this app has no video calling
      duration: _ringTimeoutMs,
      extra: {'conversationId': conversationId},
      missedCallNotification: const NotificationParams(
        showNotification: true,
        // No "Call back" action wired up here — this file only has the caller's
        // display name and this conversation's id on hand, not enough to place a
        // fresh outgoing call from a cold background isolate the way
        // CallController.startCall needs (otherUserId, a live mic prompt, etc.).
        // Tapping the notification body still opens the app normally.
        isShowCallback: false,
        subtitle: 'Missed call',
      ),
      android: const AndroidParams(
        isCustomNotification: true,
        // Moved here from CallKitParams's own top-level fields — 3.x relocated
        // these two onto AndroidParams (iOS never had a text-accept/decline
        // concept in the first place, CallKit renders its own localized labels).
        textAccept: 'Accept',
        textDecline: 'Decline',
        ringtonePath: 'ringtone', // android/app/src/main/res/raw/ringtone.wav —
        // the same file local_notifications.dart's own (non-looping) call channel
        // sound already uses, kept as one shared asset rather than two.
        backgroundColor:
            '#075E54', // matches WhatsAppColors.appBar (app/app.dart)
        actionColor: '#25D366', // matches WhatsAppColors.green (app/app.dart)
        incomingCallNotificationChannelName: 'Incoming call',
        missedCallNotificationChannelName: 'Missed call',
        isShowFullLockedScreen: true,
      ),
    ),
  );
}

/// Called once a call is resolved through any path (answered, declined, ended,
/// timed out) — same "one choke point clears it regardless of how the call ended"
/// reasoning `CallController._teardown`'s own docstring already states for the
/// local ringtone/tray notification it also clears. Runs on iOS too now: if this
/// particular call arrived via a VoIP push, there's a real native CallKit session
/// to end; if it didn't (live in-app WS call, no CallKit session ever shown), this
/// is a harmless no-op — the try/catch below already treats a failure here as
/// best-effort regardless of why it failed.
Future<void> endCallKit(String callId) async {
  try {
    await FlutterCallkitIncoming.endCall(callId);
  } catch (_) {
    // Best-effort, same as clearCallNotification's own reasoning — a failure here
    // just means a stale ring/notification lingers until its own timeout, not a
    // broken call.
  }
}

/// Purely cosmetic: updates the native call UI/history entry to reflect that
/// WebRTC actually connected, per flutter_callkit_incoming's own README ("call this
/// when WebRTC/P2P is established"). Safe to skip on failure — nothing in this
/// app's own call state depends on it. Same "harmless no-op if there's no matching
/// native session" reasoning as endCallKit above now that this runs on iOS too.
Future<void> setCallKitConnected(String callId) async {
  try {
    await FlutterCallkitIncoming.setCallConnected(callId);
  } catch (_) {}
}
