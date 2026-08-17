/// Biometric (Face ID / Touch ID / Android biometrics, falling back to device
/// PIN/pattern) unlock — the mobile counterpart to
/// `apps/web/lib/crypto/biometric-unlock.ts`. Referenced from
/// `crypto/storage/key_derivation.dart`'s own docstring: this is layered on top of
/// the real password-derived KEK, never a replacement for it — a device without
/// biometric unlock enabled, or where it fails for any reason, always still has the
/// password field as the actual fallback (see unlock_screen.dart).
///
/// The web version uses WebAuthn's PRF extension, where the authenticator hardware
/// itself derives the unlocking secret — evaluating it requires a fresh biometric
/// check by construction. `local_auth` has no equivalent primitive available to Dart
/// code: it only answers a yes/no "did the OS confirm this device's owner", it never
/// hands back any hardware-derived secret bytes. So this file uses the standard
/// native-app pattern instead: a random 32-byte wrap key is generated once and
/// stored in Keychain/Keystore-backed `flutter_secure_storage`
/// (storage/blob_store.dart — already at-rest encrypted by the OS, same as every
/// other blob this app stores), and wraps the already-Argon2id-derived KEK exactly
/// the way `wrapBytes`/`unwrapBytes` wrap every other piece of local key material.
/// Every read of that wrap key is gated behind a fresh `local_auth` prompt first.
/// Honest trade-off versus the web path: secrecy here rests on the OS
/// Keychain/Keystore protection plus this app's own gate check running first, not on
/// the biometric hardware itself refusing to release the secret without a fresh scan
/// — the same trade-off most native apps offering a "biometric unlock" convenience
/// layer make (true hardware-bound key auth would need its own native
/// platform-channel per OS, out of scope for what this layer is trying to do: skip
/// retyping a password, not replace the OS's own device-level biometric security
/// model).
///
/// Every function here fails closed, mirroring biometric-unlock.ts exactly: no
/// hardware, no enrollment, a cancelled prompt, a stale/corrupt wrap all resolve to
/// `false`/`null`, never a thrown error a caller has to specially handle.
library;

import 'dart:typed_data';
import 'package:local_auth/local_auth.dart';

import '../../crypto/local_identity.dart';
import '../../crypto/primitives.dart';
import '../../crypto/storage/wrap.dart';
import '../../storage/blob_store.dart';

const _wrapKeyBlobKey = 'biometric-wrap-key';
const _wrappedKekBlobKey = 'biometric-wrapped-kek';
const _wrapKeyLength = 32;

final LocalAuthentication _localAuth = LocalAuthentication();

/// Whether this device even offers a usable authenticator (biometric OR a device
/// PIN/pattern/passcode fallback) — checked before ever showing a "set up biometric
/// unlock" option, mirroring `isPlatformAuthenticatorAvailable()`.
Future<bool> isBiometricAvailable() async {
  try {
    if (!await _localAuth.isDeviceSupported()) return false;
    if (await _localAuth.canCheckBiometrics) return true;
    final enrolled = await _localAuth.getAvailableBiometrics();
    return enrolled.isNotEmpty;
  } catch (_) {
    return false;
  }
}

Future<bool> isBiometricUnlockEnabled() async => (await getBlob(_wrappedKekBlobKey)) != null;

Future<bool> _promptBiometric(String reason) async {
  try {
    return await _localAuth.authenticate(
      localizedReason: reason,
      options: const AuthenticationOptions(stickyAuth: true, useErrorDialogs: true),
    );
  } catch (_) {
    // Includes the user cancelling the OS prompt, no hardware, nothing enrolled —
    // none of these are actionable differently by the caller, same as the web
    // version's `evaluatePrf`.
    return false;
  }
}

/// Must be called right after a real password unlock — this never has its own path
/// to the account password or a fresh KEK derivation, it only ever wraps a KEK
/// that's already been derived elsewhere. Returns `false` (never throws) for every
/// failure mode: no authenticator, the user cancelling the confirmation prompt,
/// anything else.
Future<bool> enableBiometricUnlock(Uint8List kek) async {
  try {
    final confirmed = await _promptBiometric('Confirm your identity to enable biometric unlock');
    if (!confirmed) return false;

    final wrapKey = randomBytes(_wrapKeyLength);
    final wrapped = await wrapBytes(wrapKey, kek);
    await putBlob(_wrapKeyBlobKey, wrapKey);
    await putBlob(_wrappedKekBlobKey, wrapped);
    return true;
  } catch (_) {
    return false;
  }
}

Future<void> disableBiometricUnlock() async {
  await deleteBlob(_wrapKeyBlobKey);
  await deleteBlob(_wrappedKekBlobKey);
}

/// The actual unlock — prompts for biometrics, and on success returns exactly what
/// `unlockLocalIdentity(password)` returns for a real password unlock, so callers
/// (auth_controller.dart) can treat the two paths identically from this point on.
/// Returns `null` for every failure, including a wrap that no longer matches
/// anything real (e.g. the account password was changed elsewhere since this was
/// enrolled — the same "stale local data" case `sessions.ts#loadSession` already
/// handles gracefully rather than throwing, applied here too).
Future<UnlockedIdentity?> unlockWithBiometrics() async {
  final wrapKey = await getBlob(_wrapKeyBlobKey);
  final wrappedKek = await getBlob(_wrappedKekBlobKey);
  if (wrapKey == null || wrappedKek == null) return null;

  final confirmed = await _promptBiometric('Unlock Comm');
  if (!confirmed) return null;

  try {
    final kek = await unwrapBytes(wrapKey, wrappedKek);
    final local = await loadStoredIdentity(kek);
    if (local == null) return null;
    return UnlockedIdentity(identity: local.identity, signedPreKey: local.signedPreKey, oneTimePreKeys: local.oneTimePreKeys, kek: kek);
  } catch (_) {
    return null;
  }
}
