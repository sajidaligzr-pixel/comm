/// Riverpod wiring for every API/realtime dependency — one place that constructs
/// them, so screens/controllers depend on `ref.watch`/`ref.read` rather than
/// reaching for a global singleton directly (the crypto layer's storage modules are
/// the one deliberate exception — see their own docstrings for why a plain
/// module-level holder is the right shape there, mirroring the TS originals).
library;

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../api/api_client.dart';
import '../api/auth_api.dart';
import '../api/users_api.dart';
import '../api/keys_api.dart';
import '../api/conversations_api.dart';
import '../api/messages_api.dart';
import '../api/devices_api.dart';
import '../api/media_api.dart';
import '../api/calls_api.dart';
import '../api/groups_api.dart';
import '../api/blocking_api.dart';
import '../api/admin_api.dart';
import '../api/push_api.dart';
import '../features/groups/group_session_controller.dart';
import '../features/notifications/message_notifier.dart';
import '../realtime/ws_client.dart';

/// Set once in main.dart after `ApiClient.initialize()` resolves — every other
/// provider below derives from it. A `Provider` (not `FutureProvider`) because by
/// the time the widget tree builds, initialization has already completed; see
/// main.dart's `runApp` call.
final apiClientProvider = Provider<ApiClient>((ref) => ApiClient.instance);

final authApiProvider = Provider<AuthApi>(
  (ref) => AuthApi(ref.watch(apiClientProvider)),
);
final usersApiProvider = Provider<UsersApi>(
  (ref) => UsersApi(ref.watch(apiClientProvider)),
);
final keysApiProvider = Provider<KeysApi>(
  (ref) => KeysApi(ref.watch(apiClientProvider)),
);
final conversationsApiProvider = Provider<ConversationsApi>(
  (ref) => ConversationsApi(ref.watch(apiClientProvider)),
);
final messagesApiProvider = Provider<MessagesApi>(
  (ref) => MessagesApi(ref.watch(apiClientProvider)),
);
final devicesApiProvider = Provider<DevicesApi>(
  (ref) => DevicesApi(ref.watch(apiClientProvider)),
);
final mediaApiProvider = Provider<MediaApi>(
  (ref) => MediaApi(ref.watch(apiClientProvider)),
);
final callsApiProvider = Provider<CallsApi>(
  (ref) => CallsApi(ref.watch(apiClientProvider)),
);
final groupsApiProvider = Provider<GroupsApi>(
  (ref) => GroupsApi(ref.watch(apiClientProvider)),
);
final blockingApiProvider = Provider<BlockingApi>(
  (ref) => BlockingApi(ref.watch(apiClientProvider)),
);
final adminApiProvider = Provider<AdminApi>(
  (ref) => AdminApi(ref.watch(apiClientProvider)),
);
final pushApiProvider = Provider<PushApi>(
  (ref) => PushApi(ref.watch(apiClientProvider)),
);

/// Mounted once for the app's lifetime (a plain `Provider`, not tied to any one
/// screen) — mirrors `GroupSessionProvider`'s app-shell-level placement in
/// apps/web's layout, since a `group.key-share`/`group.members-changed` event has to
/// be handled no matter which screen is open, not just while a group thread happens
/// to be mounted.
final groupSessionControllerProvider = Provider<GroupSessionController>((ref) {
  final controller = GroupSessionController(
    groupsApi: ref.watch(groupsApiProvider),
    keysApi: ref.watch(keysApiProvider),
    realtime: ref.watch(realtimeClientProvider),
  );
  controller.start();
  ref.onDispose(controller.dispose);
  return controller;
});

final realtimeClientProvider = Provider<RealtimeClient>((ref) {
  final client = RealtimeClient(ref.watch(apiClientProvider).cookieJar);
  ref.onDispose(client.disconnect);
  return client;
});

/// Which conversation's thread is on screen right now, if any — set/cleared by
/// thread_screen.dart's own initState/dispose. Read by `messageNotifierProvider`
/// so a live message for the conversation the user is already looking at doesn't
/// also pop a redundant system notification.
final currentOpenConversationIdProvider = StateProvider<String?>((ref) => null);

/// Mounted once for the app's lifetime, same placement reasoning as
/// `groupSessionControllerProvider` above — see message_notifier.dart's own
/// docstring for what this does and deliberately does not do.
final messageNotifierProvider = Provider<MessageNotifier>((ref) {
  final notifier = MessageNotifier(
    realtime: ref.watch(realtimeClientProvider),
    getOpenConversationId: () => ref.read(currentOpenConversationIdProvider),
  );
  notifier.start();
  ref.onDispose(notifier.dispose);
  return notifier;
});
