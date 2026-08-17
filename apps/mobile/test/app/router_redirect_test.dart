/// Exhaustive branch coverage of `computeAuthRedirect` — the pure function that
/// decides which screen every `AuthState` forces the router to. Pulled out of
/// `GoRouter`'s construction specifically so this doesn't need navigation or
/// platform-channel machinery to test (see router.dart's docstring on it).
library;

import 'package:flutter_test/flutter_test.dart';
import 'package:comm_mobile/api/dtos.dart';
import 'package:comm_mobile/app/router.dart';
import 'package:comm_mobile/features/auth/auth_state.dart';

const _profile = UserProfile(
  id: 'u1',
  username: 'alice',
  displayName: 'Alice',
  about: null,
  avatarObjectKey: null,
  status: 'active',
  createdAt: '2026-01-01T00:00:00.000Z',
);

void main() {
  group('computeAuthRedirect', () {
    test('AuthChecking never redirects — the shell itself renders a loading state', () {
      expect(computeAuthRedirect(const AuthChecking(), '/chats'), isNull);
      expect(computeAuthRedirect(const AuthChecking(), '/login'), isNull);
    });

    test('AuthSignedOut allows /login and /invite/:token, redirects everything else to /login', () {
      expect(computeAuthRedirect(const AuthSignedOut(), '/login'), isNull);
      expect(computeAuthRedirect(const AuthSignedOut(), '/invite/abc123'), isNull);
      expect(computeAuthRedirect(const AuthSignedOut(), '/chats'), '/login');
      expect(computeAuthRedirect(const AuthSignedOut(), '/chats/xyz'), '/login');
    });

    test('AuthNeedsUnlock forces /unlock from anywhere else', () {
      expect(computeAuthRedirect(const AuthNeedsUnlock(_profile), '/unlock'), isNull);
      expect(computeAuthRedirect(const AuthNeedsUnlock(_profile), '/chats'), '/unlock');
      expect(computeAuthRedirect(const AuthNeedsUnlock(_profile), '/login'), '/unlock');
    });

    test('AuthSignedIn with mustChangePassword forces /change-password from anywhere else', () {
      const state = AuthSignedIn(_profile, mustChangePassword: true);
      expect(computeAuthRedirect(state, '/change-password'), isNull);
      expect(computeAuthRedirect(state, '/chats'), '/change-password');
      expect(computeAuthRedirect(state, '/chats/xyz'), '/change-password');
    });

    test('AuthSignedIn (password OK) bounces away from auth screens, allows everything else', () {
      const state = AuthSignedIn(_profile, mustChangePassword: false);
      expect(computeAuthRedirect(state, '/login'), '/chats');
      expect(computeAuthRedirect(state, '/unlock'), '/chats');
      expect(computeAuthRedirect(state, '/change-password'), '/chats');
      expect(computeAuthRedirect(state, '/invite/abc123'), '/chats');
      expect(computeAuthRedirect(state, '/chats'), isNull);
      expect(computeAuthRedirect(state, '/chats/some-conversation-id'), isNull);
    });
  });
}
