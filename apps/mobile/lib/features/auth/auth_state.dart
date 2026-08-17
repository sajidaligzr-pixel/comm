/// The app-shell-level session state — mirrors the three real states
/// `apps/web`'s `(app)/layout.tsx` (server-side redirect) + `unlock-gate.tsx`
/// (client-side KEK gate) jointly represent, collapsed into one enum here since a
/// native app has no server-rendered middle step: there's no cookie-authenticated
/// server session for the OS to check before the app's own code runs.
library;

import '../../api/dtos.dart';

sealed class AuthState {
  const AuthState();
}

/// Still figuring out whether a persisted session cookie is valid — the very first
/// frame, before `AuthController.bootstrap()` resolves.
class AuthChecking extends AuthState {
  const AuthChecking();
}

/// No valid session — show the login/invite-redeem screens.
class AuthSignedOut extends AuthState {
  const AuthSignedOut();
}

/// The server session cookie is valid (this account is who's signed in), but the
/// local KEK isn't in memory yet (fresh process start — the KEK is deliberately
/// never persisted, see kek_holder.dart) — show a password/biometric unlock prompt,
/// not the full login form (no need to re-enter a username the server already
/// confirmed).
class AuthNeedsUnlock extends AuthState {
  const AuthNeedsUnlock(this.profile);
  final UserProfile profile;
}

class AuthSignedIn extends AuthState {
  const AuthSignedIn(this.profile, {required this.mustChangePassword});
  final UserProfile profile;
  final bool mustChangePassword;
}
