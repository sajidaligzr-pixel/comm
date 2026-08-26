/// Mirrors `apps/web/app/api/locations/*` — live location sharing
/// (docs/09-trust-boundaries.md's "Live location sharing" exception). Every
/// viewing route re-derives `requireLocationAccess`/`requireAdmin` server-side
/// regardless of anything this client sends or assumes; `listLive()` doubles as
/// this client's own "can I see the map?" check the same way `AdminApi.listUsers`
/// doubles as its "am I an admin?" check — a UI convenience only, never the real
/// authorization boundary.
library;

import 'api_client.dart';
import 'dtos.dart';

class LocationsApi {
  const LocationsApi(this._client);
  final ApiClient _client;

  /// Any signed-in device may report its OWN location — no special privilege
  /// needed to share, only to view (see the server-side service's docstring).
  Future<void> reportMyLocation({
    required double latitude,
    required double longitude,
    double? accuracyM,
    double? headingDeg,
    double? speedMps,
    required DateTime recordedAt,
  }) {
    return _client.requestVoid(
      '/api/locations',
      body: {
        'latitude': latitude,
        'longitude': longitude,
        'accuracyM': accuracyM,
        'headingDeg': headingDeg,
        'speedMps': speedMps,
        'recordedAt': recordedAt.toUtc().toIso8601String(),
      },
    );
  }

  Future<List<LiveLocationDto>> listLive() {
    return _client.request(
      '/api/locations',
      method: 'GET',
      parse: (data) => (data as List).map((e) => LiveLocationDto.fromJson(e as Map<String, dynamic>)).toList(),
    );
  }

  Future<List<LocationViewerDto>> listViewers() {
    return _client.request(
      '/api/locations/viewers',
      method: 'GET',
      parse: (data) => (data as List).map((e) => LocationViewerDto.fromJson(e as Map<String, dynamic>)).toList(),
    );
  }

  Future<LocationViewerDto> grantViewer(String username) {
    return _client.request(
      '/api/locations/viewers',
      body: {'username': username},
      parse: (data) => LocationViewerDto.fromJson(data as Map<String, dynamic>),
    );
  }

  Future<void> revokeViewer(String userId) {
    return _client.requestVoid('/api/locations/viewers/$userId', method: 'DELETE');
  }
}
