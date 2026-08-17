/// Which account's local crypto storage is in scope right now — direct port of
/// `apps/web/lib/crypto/active-account.ts`. See that file's docstring for the real,
/// live cross-account corruption bug this closes (a second account signing in on the
/// same browser/device silently overwriting the first account's identity). Mobile
/// installs are normally single-account, but nothing stops a user from signing out
/// and into a different account on the same phone, so the same discipline applies
/// here: every blob key is namespaced by whichever account is currently active,
/// never a single fixed store shared across accounts.
library;

String? _activeAccount;

/// Same normalization as the TS original — usernames are already
/// lowercase-constrained server-side, so this is defensive, not a real source of
/// collisions in practice.
String _normalize(String usernameOrUserId) => usernameOrUserId.trim().toLowerCase();

void setActiveAccount(String usernameOrUserId) {
  final normalized = _normalize(usernameOrUserId);
  if (normalized.isEmpty) throw ArgumentError('setActiveAccount: empty account identifier.');
  _activeAccount = normalized;
}

String getActiveAccount() {
  final account = _activeAccount;
  if (account == null) {
    throw StateError(
      'No active account set for local crypto storage — setActiveAccount(username) must '
      'run before any identity/session/cache call. See active_account.dart.',
    );
  }
  return account;
}

/// Test/logout-only — the TS original has no equivalent (a page reload clears its
/// module state for free); a long-lived mobile process needs an explicit reset.
void clearActiveAccount() {
  _activeAccount = null;
}
