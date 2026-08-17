/// Route table + auth-state-driven redirects — the mobile counterpart to
/// `apps/web`'s `(auth)`/`(app)` route-group split plus `(app)/layout.tsx`'s
/// server-side "must be signed in" redirect. Rebuilt (a cheap operation at this
/// app's route-table size) whenever `authControllerProvider`'s state changes, via
/// `routerProvider` watching it below — this is the mobile equivalent of that
/// server-side redirect, just evaluated client-side since there's no
/// server-rendered middle step here.
library;

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../features/auth/auth_controller.dart';
import '../features/auth/auth_state.dart';
import '../features/auth/login_screen.dart';
import '../features/auth/unlock_screen.dart';
import '../features/auth/invite_redeem_screen.dart';
import '../features/auth/change_password_screen.dart';
import '../features/chats/chats_list_screen.dart';
import '../features/chats/thread_screen.dart';

/// Pure redirect logic, factored out of the `GoRouter` construction below purely so
/// it's unit-testable without spinning up navigation/platform-channel machinery
/// (see test/app/router_redirect_test.dart) — every branch of "which screen does
/// this auth state force" is exercised there directly.
String? computeAuthRedirect(AuthState auth, String path) {
  final onInvite = path.startsWith('/invite/');

  switch (auth) {
    case AuthChecking():
      return null; // stay put — splash/loading is rendered by the shell itself
    case AuthSignedOut():
      return onInvite || path == '/login' ? null : '/login';
    case AuthNeedsUnlock():
      return path == '/unlock' ? null : '/unlock';
    case AuthSignedIn(mustChangePassword: final must):
      if (must) return path == '/change-password' ? null : '/change-password';
      if (path == '/login' || path == '/unlock' || path == '/change-password' || onInvite) return '/chats';
      return null;
  }
}

final routerProvider = Provider<GoRouter>((ref) {
  final auth = ref.watch(authControllerProvider);

  return GoRouter(
    initialLocation: '/chats',
    redirect: (context, state) => computeAuthRedirect(auth, state.matchedLocation),
    routes: [
      GoRoute(path: '/login', builder: (context, state) => const LoginScreen()),
      GoRoute(path: '/unlock', builder: (context, state) => const UnlockScreen()),
      GoRoute(
        path: '/invite/:token',
        builder: (context, state) => InviteRedeemScreen(token: state.pathParameters['token']!),
      ),
      GoRoute(path: '/change-password', builder: (context, state) => const ChangePasswordScreen()),
      GoRoute(path: '/chats', builder: (context, state) => const ChatsListScreen()),
      GoRoute(
        path: '/chats/:id',
        builder: (context, state) => ThreadScreen(conversationId: state.pathParameters['id']!),
      ),
    ],
  );
});
