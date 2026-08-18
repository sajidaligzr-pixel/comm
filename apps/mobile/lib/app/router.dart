/// Route table + auth-state-driven redirects — the mobile counterpart to
/// `apps/web`'s `(auth)`/`(app)` route-group split plus `(app)/layout.tsx`'s
/// server-side "must be signed in" redirect. Rebuilt (a cheap operation at this
/// app's route-table size) whenever `authControllerProvider`'s state changes, via
/// `routerProvider` watching it below — this is the mobile equivalent of that
/// server-side redirect, just evaluated client-side since there's no
/// server-rendered middle step here.
library;

import 'package:flutter/widgets.dart' show PageRoute, RouteObserver;
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../features/auth/auth_controller.dart';
import '../features/auth/auth_state.dart';
import '../features/auth/login_screen.dart';
import '../features/auth/unlock_screen.dart';
import '../features/auth/invite_redeem_screen.dart';
import '../features/auth/change_password_screen.dart';
import '../features/calls/call_history_screen.dart';
import '../features/chats/archived_chats_screen.dart';
import '../features/chats/chats_list_screen.dart';
import '../features/chats/thread_screen.dart';
import '../features/devices/devices_screen.dart';
import '../features/groups/new_group_screen.dart';
import '../features/groups/group_info_screen.dart';
import '../features/admin/admin_screen.dart';
import 'splash_screen.dart';

/// Pure redirect logic, factored out of the `GoRouter` construction below purely so
/// it's unit-testable without spinning up navigation/platform-channel machinery
/// (see test/app/router_redirect_test.dart) — every branch of "which screen does
/// this auth state force" is exercised there directly.
String? computeAuthRedirect(AuthState auth, String path) {
  final onInvite = path.startsWith('/invite/');

  switch (auth) {
    case AuthChecking():
      // Force every path to the splash screen until it's known whether this
      // device needs to unlock, log in, or is already signed in — /chats and
      // /chats/:id show real account content (conversation names, fetched live)
      // that must never render even briefly before authentication is resolved.
      // Found live: this used to return null with initialLocation pointed at
      // /chats, so the chats list rendered — and fired its own network fetch —
      // for a moment before bootstrap() resolved and forced /unlock.
      return path == '/splash' ? null : '/splash';
    case AuthSignedOut():
      return onInvite || path == '/login' ? null : '/login';
    case AuthNeedsUnlock():
      return path == '/unlock' ? null : '/unlock';
    case AuthSignedIn(mustChangePassword: final must):
      if (must) return path == '/change-password' ? null : '/change-password';
      if (path == '/login' ||
          path == '/unlock' ||
          path == '/change-password' ||
          path == '/splash' ||
          onInvite) {
        return '/chats';
      }
      return null;
  }
}

/// Lets a screen notice it became visible again after another route was popped
/// off on top of it — chats_list_screen.dart subscribes (`RouteAware`) so
/// returning from an open thread (which may have just marked messages read,
/// changed archive state, etc.) refreshes the list instead of showing whatever
/// was on screen before that thread was opened. A single app-wide instance,
/// same as any `RouteObserver` — there's only ever one Navigator here to watch.
final chatsRouteObserver = RouteObserver<PageRoute<dynamic>>();

final routerProvider = Provider<GoRouter>((ref) {
  final auth = ref.watch(authControllerProvider);

  return GoRouter(
    initialLocation: '/splash',
    redirect: (context, state) =>
        computeAuthRedirect(auth, state.matchedLocation),
    observers: [chatsRouteObserver],
    routes: [
      GoRoute(
        path: '/splash',
        builder: (context, state) => const SplashScreen(),
      ),
      GoRoute(path: '/login', builder: (context, state) => const LoginScreen()),
      GoRoute(
        path: '/unlock',
        builder: (context, state) => const UnlockScreen(),
      ),
      GoRoute(
        path: '/invite/:token',
        builder: (context, state) =>
            InviteRedeemScreen(token: state.pathParameters['token']!),
      ),
      GoRoute(
        path: '/change-password',
        builder: (context, state) => const ChangePasswordScreen(),
      ),
      GoRoute(
        path: '/chats',
        builder: (context, state) => const ChatsListScreen(),
      ),
      // MUST come before '/chats/:id' below — go_router's RouteConfiguration
      // walks top-level routes in declaration order and returns the first match
      // (see go_router's configuration.dart, `_getLocRouteMatches`), so a literal
      // path only wins over a sibling ':id' pattern by being listed first, not by
      // any built-in literal-over-param precedence.
      GoRoute(
        path: '/chats/archived',
        builder: (context, state) => const ArchivedChatsScreen(),
      ),
      GoRoute(
        path: '/devices',
        builder: (context, state) => const DevicesScreen(),
      ),
      GoRoute(
        path: '/calls',
        builder: (context, state) => const CallHistoryScreen(),
      ),
      GoRoute(path: '/admin', builder: (context, state) => const AdminScreen()),
      GoRoute(
        path: '/new-group',
        builder: (context, state) => const NewGroupScreen(),
      ),
      GoRoute(
        path: '/groups/:groupId/info',
        builder: (context, state) =>
            GroupInfoScreen(groupId: state.pathParameters['groupId']!),
      ),
      GoRoute(
        path: '/chats/:id',
        builder: (context, state) =>
            ThreadScreen(conversationId: state.pathParameters['id']!),
      ),
    ],
  );
});
