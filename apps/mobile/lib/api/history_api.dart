/// Multi-device message history sync (docs/07-auth-architecture.md's history-key
/// section) — mirrors packages/types/src/history.ts. See lib/crypto/history_key.dart
/// (account-level bootstrap) and lib/crypto/history_sync.dart (per-message upload/
/// fallback decrypt) for how these are actually used.
library;

import 'api_client.dart';

class UserHistoryKeyResponse {
  final String wrappedKey;
  final String salt;
  const UserHistoryKeyResponse({required this.wrappedKey, required this.salt});
  static UserHistoryKeyResponse fromJson(Map<String, dynamic> json) =>
      UserHistoryKeyResponse(
        wrappedKey: json['wrappedKey'] as String,
        salt: json['salt'] as String,
      );
}

class HistoryApi {
  const HistoryApi(this._client);
  final ApiClient _client;

  /// Throws `ApiException('NOT_FOUND', ...)` if this account has no History Key
  /// yet — the caller's cue to generate+create one (see history_key.dart).
  Future<UserHistoryKeyResponse> getHistoryKey() {
    return _client.request(
      '/api/account/history-key',
      method: 'GET',
      parse: (data) =>
          UserHistoryKeyResponse.fromJson(data as Map<String, dynamic>),
    );
  }

  /// Create-if-absent — the response is the CANONICAL row after this call, which
  /// may differ from what was submitted if another of this account's own devices
  /// won a concurrent create first (see history_key.dart's own handling).
  Future<UserHistoryKeyResponse> createHistoryKey({
    required String wrappedKey,
    required String salt,
  }) {
    return _client.request(
      '/api/account/history-key',
      body: {'wrappedKey': wrappedKey, 'salt': salt},
      parse: (data) =>
          UserHistoryKeyResponse.fromJson(data as Map<String, dynamic>),
    );
  }

  Future<void> uploadHistoryCopy(String messageId, String ciphertext) {
    return _client.requestVoid(
      '/api/messages/$messageId/history-copy',
      body: {'ciphertext': ciphertext},
    );
  }
}
