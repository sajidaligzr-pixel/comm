/// Orchestrates login / invite-redeem / unlock / logout — the mobile counterpart to
/// `apps/web`'s `login-form.tsx` + `unlock-gate.tsx` + `invite-redeem-form.tsx`
/// combined into one controller, since there's no per-route server component split
/// here. Every local-identity/session-storage call below follows the exact sequence
/// those files establish: `setActiveAccount` first, always, before any blob-store
/// touch (see `storage/active_account.dart`).
library;

import 'dart:io' show Platform;
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../api/api_client.dart';
import '../../api/auth_api.dart';
import '../../api/dtos.dart';
import '../../api/users_api.dart';
import '../../app/providers.dart';
import '../../crypto/kek_holder.dart';
import '../../crypto/local_identity.dart';
import '../../storage/active_account.dart';
import '../../storage/blob_store.dart' show wipeCryptoDb;
import '../../storage/prefs.dart';
import 'auth_state.dart';
import 'biometric_unlock.dart' as biometric;

String _guessDeviceName() {
  if (Platform.isAndroid) return 'Android device';
  if (Platform.isIOS) return 'iPhone';
  return 'Mobile device';
}

class AuthController extends StateNotifier<AuthState> {
  AuthController(this._authApi, this._usersApi, this._apiClient) : super(const AuthChecking()) {
    bootstrap();
  }

  final AuthApi _authApi;
  final UsersApi _usersApi;
  final ApiClient _apiClient;

  /// Runs once at app start: is there already a valid session cookie (a previous
  /// launch that was never explicitly signed out of)? If so, this account's KEK
  /// still needs unlocking (never persisted — see kek_holder.dart) but the user
  /// shouldn't have to retype their username.
  Future<void> bootstrap() async {
    try {
      final profile = await _usersApi.me();
      setActiveAccount(profile.username);
      state = AuthNeedsUnlock(profile);
    } on ApiException {
      state = const AuthSignedOut();
    } catch (_) {
      state = const AuthSignedOut();
    }
  }

  /// The `AuthNeedsUnlock` path — re-derives the KEK from this device's already-
  /// stored identity, no server round trip needed for the crypto half.
  Future<void> unlock(String password) async {
    final current = state;
    if (current is! AuthNeedsUnlock) return;

    final unlocked = await unlockLocalIdentity(password);
    if (unlocked == null) {
      throw ApiException('AUTH_INVALID', "Could not unlock this device's local keys with that password.");
    }
    setUnlockedIdentity(unlocked.kek, unlocked.identity);
    state = AuthSignedIn(current.profile, mustChangePassword: false);
  }

  /// Same effect as `unlock(password)` but sourced from a successful biometric
  /// prompt instead of a typed password — see features/auth/biometric_unlock.dart.
  /// Returns `false` (never throws) on anything short of success, so the unlock
  /// screen can silently fall back to showing the password field.
  Future<bool> unlockWithBiometrics() async {
    final current = state;
    if (current is! AuthNeedsUnlock) return false;

    final unlocked = await biometric.unlockWithBiometrics();
    if (unlocked == null) return false;

    setUnlockedIdentity(unlocked.kek, unlocked.identity);
    state = AuthSignedIn(current.profile, mustChangePassword: false);
    return true;
  }

  /// Full username+password login — handles both a returning device (this phone has
  /// already registered before, we have a remembered deviceId) and a brand-new one
  /// (register a fresh device + identity as part of this call).
  Future<void> login(String username, String password) async {
    setActiveAccount(username);
    final knownDeviceId = await getRememberedDeviceId(username);
    // Local identity persists independently of the remembered device-id hint — if
    // this app's storage was cleared but the hint somehow survived, fall back to
    // registering fresh, same as a brand-new device.
    final returning = knownDeviceId != null ? await hasLocalIdentity() : false;

    CreatedIdentity? newIdentity;
    if (!returning) {
      newIdentity = await createLocalIdentity(password);
    }

    final AuthSessionResponse result;
    try {
      result = returning
          ? await _authApi.login(username: username, password: password, deviceId: knownDeviceId)
          : await _authApi.login(
              username: username,
              password: password,
              newDevice: NewDeviceRegistration(name: _guessDeviceName(), deviceType: deviceTypeMobile, keyBundle: newIdentity!.keyBundle),
            );
    } on ApiException catch (e) {
      if (e.code == 'DEVICE_REVOKED') {
        // The remembered device id is no longer valid (revoked elsewhere) — drop it
        // so the next attempt registers a fresh device instead of looping forever.
        await clearRememberedDeviceId(username);
      }
      rethrow;
    }

    await setRememberedDeviceId(username, result.deviceId);
    await setRememberedUsername(username);

    if (returning) {
      final unlocked = await unlockLocalIdentity(password);
      if (unlocked == null) {
        // The account's password was changed elsewhere without this device's local
        // identity being re-wrapped to match — surfaced as an error rather than
        // silently regenerating a new identity, which would orphan every session
        // built on the old one.
        throw ApiException('AUTH_INVALID', "Could not unlock this device's local keys with that password.");
      }
      setUnlockedIdentity(unlocked.kek, unlocked.identity);
    } else {
      setUnlockedIdentity(newIdentity!.kek, newIdentity.identity);
    }

    final profile = await _usersApi.me();
    state = AuthSignedIn(profile, mustChangePassword: result.mustChangePassword);
  }

  Future<void> redeemInvite(String token, String password) async {
    final info = await _authApi.getInviteInfo(token);
    setActiveAccount(info.username);

    final newIdentity = await createLocalIdentity(password);
    final result = await _authApi.redeemInvite(
      token: token,
      password: password,
      device: NewDeviceRegistration(name: _guessDeviceName(), deviceType: deviceTypeMobile, keyBundle: newIdentity.keyBundle),
    );

    await setRememberedDeviceId(info.username, result.deviceId);
    await setRememberedUsername(info.username);
    setUnlockedIdentity(newIdentity.kek, newIdentity.identity);

    final profile = await _usersApi.me();
    state = AuthSignedIn(profile, mustChangePassword: result.mustChangePassword);
  }

  Future<void> markPasswordChanged() async {
    final current = state;
    if (current is AuthSignedIn) {
      state = AuthSignedIn(current.profile, mustChangePassword: false);
    }
  }

  /// Ends the server session and clears the in-memory KEK, but deliberately does
  /// NOT wipe this device's locally-stored identity — logging back in on the same
  /// phone should still be a "returning device" (password only, no new key
  /// registration), exactly like the web client's own logout leaves IndexedDB
  /// intact. `wipeLocalIdentity`/`wipeCryptoDb` are reserved for an explicit
  /// "forget this device" action (devices settings screen — not yet built), the
  /// same distinction the web app draws in server/modules/devices/service.ts
  /// between session logout and device revocation.
  Future<void> logout() async {
    try {
      await _authApi.logout();
    } on ApiException {
      // Best-effort — proceed to clear local state regardless (matches the web
      // client: a failed logout call shouldn't trap the user in a signed-in UI they
      // can no longer act on).
    }
    await _apiClient.clearCookies();
    clearUnlockedIdentity();
    clearActiveAccount();
    state = const AuthSignedOut();
  }

  /// "Forget this device" — explicit, destructive, separate from logout. Wipes the
  /// local identity/session cache (crypto/local_identity.dart, storage/blob_store.dart)
  /// so a future login on this phone registers as a brand-new device.
  Future<void> forgetThisDevice(String username) async {
    await wipeLocalIdentity();
    await wipeCryptoDb();
    await clearRememberedDeviceId(username);
  }
}

final authControllerProvider = StateNotifierProvider<AuthController, AuthState>((ref) {
  return AuthController(ref.watch(authApiProvider), ref.watch(usersApiProvider), ref.watch(apiClientProvider));
});
