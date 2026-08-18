import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'api/api_client.dart';
import 'app/app.dart';
import 'app/router.dart';
import 'features/notifications/local_notifications.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  // Must resolve before any widget builds — every provider in app/providers.dart
  // reads `ApiClient.instance` synchronously, which throws until this has run (see
  // that class's own guard).
  await ApiClient.initialize();

  // An explicit ProviderContainer (rather than a plain `ProviderScope`) so
  // initLocalNotifications' tap handler below — a plugin callback with no
  // BuildContext/WidgetRef of its own — has a way to reach the router and
  // navigate to the tapped conversation. Standard Riverpod pattern for "a
  // non-widget callback needs provider access."
  final container = ProviderContainer();
  runApp(UncontrolledProviderScope(container: container, child: const CommApp()));

  // Deliberately not awaited: this includes the system notification-permission
  // prompt, which shouldn't hold up the very first frame — the app is fully usable
  // long before this resolves, same reasoning as everything else in this app that
  // fails closed rather than blocking on a capability check (biometric_unlock.dart,
  // admin nav gating).
  initLocalNotifications(
    onTapConversationId: (conversationId) => container.read(routerProvider).push('/chats/$conversationId'),
  );
}
