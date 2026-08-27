/// `POST /api/auth/*` — mirrors `apps/web`'s auth routes (login, invite redeem,
/// logout, refresh, change password). See `packages/types/src/auth.ts` for the
/// authoritative request/response shapes this mirrors.
library;

import 'api_client.dart';
import 'dtos.dart';

class AuthApi {
  const AuthApi(this._client);
  final ApiClient _client;

  /// Returns `status: 'ok'` (a normal completed login) or `status:
  /// 'pending_approval'` (docs/07-auth-architecture.md's device-approval section —
  /// this device isn't signed in yet; the caller polls [pollPendingLogin] until an
  /// already-signed-in device approves/denies it).
  Future<LoginResult> login({
    required String username,
    required String password,
    NewDeviceRegistration? newDevice,
    String? deviceId,
  }) {
    return _client.request(
      '/api/auth/login',
      body: {
        'username': username,
        'password': password,
        if (newDevice != null) 'newDevice': newDevice.toJson(),
        if (deviceId != null) 'deviceId': deviceId,
      },
      parse: (data) => LoginResult.fromJson(data as Map<String, dynamic>),
    );
  }

  /// Polled every couple of seconds by the waiting new device
  /// (docs/07-auth-architecture.md) until it stops returning `status: 'pending'`.
  /// Public/unauthenticated on the server — the id itself is the bearer
  /// capability — so this deliberately does NOT go through the normal
  /// cookie-authenticated request path any differently; ApiClient sends whatever
  /// cookies exist regardless, which is fine (there are none yet for this device).
  Future<LoginResult> pollPendingLogin(String pendingLoginId) {
    return _client.request(
      '/api/auth/login/pending/$pendingLoginId',
      method: 'GET',
      parse: (data) => LoginResult.fromJson(data as Map<String, dynamic>),
    );
  }

  Future<InviteInfoResponse> getInviteInfo(String token) {
    return _client.request(
      '/api/auth/invite/$token',
      method: 'GET',
      parse: (data) => InviteInfoResponse.fromJson(data as Map<String, dynamic>),
    );
  }

  Future<AuthSessionResponse> redeemInvite({
    required String token,
    required String password,
    required NewDeviceRegistration device,
  }) {
    return _client.request(
      '/api/auth/invite/redeem',
      body: {'token': token, 'password': password, 'device': device.toJson()},
      parse: (data) => AuthSessionResponse.fromJson(data as Map<String, dynamic>),
    );
  }

  Future<void> logout() => _client.requestVoid('/api/auth/logout', method: 'POST');

  Future<void> refresh() => _client.requestVoid('/api/auth/refresh', method: 'POST');

  Future<void> changePassword({required String currentPassword, required String newPassword}) {
    return _client.requestVoid(
      '/api/auth/change-password',
      body: {'currentPassword': currentPassword, 'newPassword': newPassword},
    );
  }

  /// Apple App Store Review Guideline 5.1.1(v) — in-app account deletion. See
  /// server/modules/auth/service.ts's `deleteOwnAccount` docstring for exactly what
  /// this does server-side (soft-delete, not a row-level DELETE).
  Future<void> deleteAccount({required String password}) {
    return _client.requestVoid('/api/auth/delete-account', body: {'password': password});
  }
}
