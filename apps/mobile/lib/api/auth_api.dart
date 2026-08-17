/// `POST /api/auth/*` — mirrors `apps/web`'s auth routes (login, invite redeem,
/// logout, refresh, change password). See `packages/types/src/auth.ts` for the
/// authoritative request/response shapes this mirrors.
library;

import 'api_client.dart';
import 'dtos.dart';

class AuthApi {
  const AuthApi(this._client);
  final ApiClient _client;

  Future<AuthSessionResponse> login({
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
      parse: (data) => AuthSessionResponse.fromJson(data as Map<String, dynamic>),
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
}
