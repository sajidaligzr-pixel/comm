library;

import 'api_client.dart';
import 'dtos.dart';

/// Blocked users (docs/13-roadmap.md) — mirrors apps/web's identical routes.
/// See blocking/service.ts's own docstring (server-side) for exactly what
/// blocking does and doesn't enforce.
class BlockingApi {
  const BlockingApi(this._client);
  final ApiClient _client;

  Future<List<BlockedUserDto>> list() {
    return _client.request(
      '/api/blocked-users',
      method: 'GET',
      parse: (data) => (data as List)
          .map((e) => BlockedUserDto.fromJson(e as Map<String, dynamic>))
          .toList(),
    );
  }

  Future<void> block(String username) =>
      _client.requestVoid('/api/blocked-users', body: {'username': username});

  Future<void> unblock(String userId) =>
      _client.requestVoid('/api/blocked-users/$userId', method: 'DELETE');
}
