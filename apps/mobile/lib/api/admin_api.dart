/// Mirrors `apps/web/app/api/admin/*` — account provisioning (the only way an
/// account comes into existence at all, docs/07-auth-architecture.md) and
/// suspension. Every route re-derives the admin role server-side via
/// `requireAdmin` regardless of anything this client sends or assumes — nothing
/// here is itself a security boundary, same caveat `isAdmin()` carries on the web
/// side (server/modules/admin/service.ts).
library;

import 'api_client.dart';
import 'dtos.dart';

class AdminApi {
  const AdminApi(this._client);
  final ApiClient _client;

  /// Also doubles as the client's own "am I an admin?" check (see
  /// features/admin/admin_screen.dart / chats_list_screen.dart): a non-admin
  /// caller gets a `FORBIDDEN` `ApiException` from `requireAdmin` before this ever
  /// resolves, so success alone implies the caller is an admin — a UI convenience
  /// only, never trusted as the actual authorization decision.
  Future<List<ProvisionedUserSummary>> listUsers() {
    return _client.request(
      '/api/admin/users',
      method: 'GET',
      parse: (data) => (data as List).map((e) => ProvisionedUserSummary.fromJson(e as Map<String, dynamic>)).toList(),
    );
  }

  Future<ProvisionUserResult> provisionUser({required String username, required String displayName, int? inviteTtlHours}) {
    return _client.request(
      '/api/admin/users',
      body: {'username': username, 'displayName': displayName, if (inviteTtlHours != null) 'inviteTtlHours': inviteTtlHours},
      parse: (data) => ProvisionUserResult.fromJson(data as Map<String, dynamic>),
    );
  }

  Future<void> suspendUser(String userId, String reason) {
    return _client.requestVoid('/api/admin/users/$userId/suspend', body: {'reason': reason});
  }
}
