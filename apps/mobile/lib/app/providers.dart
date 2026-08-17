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
import '../realtime/ws_client.dart';

/// Set once in main.dart after `ApiClient.initialize()` resolves — every other
/// provider below derives from it. A `Provider` (not `FutureProvider`) because by
/// the time the widget tree builds, initialization has already completed; see
/// main.dart's `runApp` call.
final apiClientProvider = Provider<ApiClient>((ref) => ApiClient.instance);

final authApiProvider = Provider<AuthApi>((ref) => AuthApi(ref.watch(apiClientProvider)));
final usersApiProvider = Provider<UsersApi>((ref) => UsersApi(ref.watch(apiClientProvider)));
final keysApiProvider = Provider<KeysApi>((ref) => KeysApi(ref.watch(apiClientProvider)));
final conversationsApiProvider = Provider<ConversationsApi>((ref) => ConversationsApi(ref.watch(apiClientProvider)));
final messagesApiProvider = Provider<MessagesApi>((ref) => MessagesApi(ref.watch(apiClientProvider)));
final devicesApiProvider = Provider<DevicesApi>((ref) => DevicesApi(ref.watch(apiClientProvider)));
final mediaApiProvider = Provider<MediaApi>((ref) => MediaApi(ref.watch(apiClientProvider)));

final realtimeClientProvider = Provider<RealtimeClient>((ref) {
  final client = RealtimeClient(ref.watch(apiClientProvider).cookieJar);
  ref.onDispose(client.disconnect);
  return client;
});
