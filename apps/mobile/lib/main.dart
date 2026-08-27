import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'api/api_client.dart';
import 'app/app.dart';
import 'app/router.dart';
import 'features/calls/call_kit.dart' show initCallKit;
import 'features/location/location_service.dart';
import 'features/location/location_service_hooks.dart';
import 'features/notifications/local_notifications.dart';
import 'features/notifications/push_notifications.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  // Must resolve before any widget builds — every provider in app/providers.dart
  // reads `ApiClient.instance` synchronously, which throws until this has run (see
  // that class's own guard).
  await ApiClient.initialize();

  // Wires the real implementation behind the hooks indirection widely-imported
  // app code (permissions_prompt.dart, chats_list_screen.dart, auth_controller.dart)
  // actually calls — see location_service_hooks.dart's own docstring for why this
  // indirection exists (in short: location_service.dart is only safely importable
  // from here, never from anything a unit test might reach).
  LocationServiceHooks.ensureStarted = LocationService.ensureStarted;
  LocationServiceHooks.stop = LocationService.stop;
  LocationServiceHooks.refreshSession = LocationService.refreshSession;

  // An explicit ProviderContainer (rather than a plain `ProviderScope`) so
  // initLocalNotifications' tap handler below — a plugin callback with no
  // BuildContext/WidgetRef of its own — has a way to reach the router and
  // navigate to the tapped conversation. Standard Riverpod pattern for "a
  // non-widget callback needs provider access."
  final container = ProviderContainer();
  runApp(
    UncontrolledProviderScope(container: container, child: const CommApp()),
  );

  // Deliberately not awaited: this includes the system notification-permission
  // prompt, which shouldn't hold up the very first frame — the app is fully usable
  // long before this resolves, same reasoning as everything else in this app that
  // fails closed rather than blocking on a capability check (biometric_unlock.dart,
  // admin nav gating).
  //
  // Only message taps arrive here now — calls have their own native UI/event stream
  // (features/calls/call_kit.dart's initCallKit, below), not a flutter_local_
  // notifications tap at all.
  initLocalNotifications(
    onTap: (tap) {
      if (tap.openDevices) {
        // New-device login approval (docs/07-auth-architecture.md) — no
        // conversation to jump to, just the Devices screen where the pending
        // request itself lives.
        container.read(routerProvider).push('/devices');
      } else if (tap.conversationId != null) {
        container.read(routerProvider).push('/chats/${tap.conversationId}');
      }
    },
  );
  // Same "deliberately not awaited" reasoning as initLocalNotifications above —
  // Firebase init + registering the background handler shouldn't hold up the first
  // frame either. Token registration itself needs a signed-in device and happens
  // separately (chats_list_screen.dart's initState, once auth is actually known).
  initPushNotifications(container);
  // Accept/Decline on the native incoming-call UI (features/calls/call_kit.dart) —
  // independent of the two calls above, its own event stream rather than a
  // notification tap.
  initCallKit(container);
}
