/// In-memory-only holder for the current process's local-storage KEK — direct port
/// of `apps/web/lib/crypto/kek-holder.ts`. Derived once at unlock (login/invite
/// redeem/device link), used to wrap/unwrap sessions for the rest of the app's
/// lifetime, never itself persisted: "the KEK lives only in memory for the session."
/// An app kill/restart clears this by construction — the user unlocks again via
/// `unlockLocalIdentity` (crypto/local_identity.dart), same as a page reload on web.
library;

import 'dart:typed_data';
import 'identity/keys.dart';
import 'primitives.dart';

Uint8List? _currentKek;
IdentityKeyPair? _currentIdentity;

void setUnlockedIdentity(Uint8List kek, IdentityKeyPair identity) {
  _currentKek = kek;
  _currentIdentity = identity;
}

Uint8List? getCurrentKek() => _currentKek;

IdentityKeyPair? getCurrentIdentity() => _currentIdentity;

void clearUnlockedIdentity() {
  final kek = _currentKek;
  if (kek != null) wipe(kek);
  _currentKek = null;
  _currentIdentity = null;
}
