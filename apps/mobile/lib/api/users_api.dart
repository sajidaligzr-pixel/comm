library;

import 'api_client.dart';
import 'dtos.dart';

class UsersApi {
  const UsersApi(this._client);
  final ApiClient _client;

  Future<UserProfile> me() =>
      _client.request('/api/users/me', method: 'GET', parse: (data) => UserProfile.fromJson(data as Map<String, dynamic>));

  Future<UserProfile> updateProfile({String? displayName, String? about}) {
    return _client.request(
      '/api/users/me',
      method: 'PATCH',
      body: {if (displayName != null) 'displayName': displayName, if (about != null) 'about': about},
      parse: (data) => UserProfile.fromJson(data as Map<String, dynamic>),
    );
  }

  /// Enumeration-guarded on the server (single-username lookup only) — used to
  /// resolve a username before starting a direct conversation.
  Future<UserProfile?> byUsername(String username) async {
    try {
      return await _client.request(
        '/api/users/$username',
        method: 'GET',
        parse: (data) => UserProfile.fromJson(data as Map<String, dynamic>),
      );
    } on ApiException catch (e) {
      if (e.code == 'NOT_FOUND') return null;
      rethrow;
    }
  }
}
