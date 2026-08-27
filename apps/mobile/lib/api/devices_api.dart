library;

import 'api_client.dart';
import 'dtos.dart';

class DevicesApi {
  const DevicesApi(this._client);
  final ApiClient _client;

  Future<List<DeviceSummary>> list() {
    return _client.request(
      '/api/devices',
      method: 'GET',
      parse: (data) => (data as List).map((e) => DeviceSummary.fromJson(e as Map<String, dynamic>)).toList(),
    );
  }

  Future<void> revoke(String deviceId) => _client.requestVoid('/api/devices/$deviceId', method: 'DELETE');

  Future<LinkDeviceStartResponse> startLink() {
    return _client.request(
      '/api/devices/link/start',
      method: 'POST',
      parse: (data) => LinkDeviceStartResponse.fromJson(data as Map<String, dynamic>),
    );
  }

  /// New-device login approval (docs/07-auth-architecture.md's device-approval
  /// section) — the durable "did I miss the live push" catch-up, same
  /// REST-is-durable/WS-is-just-the-fast-path relationship group key-shares
  /// already have.
  Future<List<PendingDeviceLoginSummary>> listPendingLogins() {
    return _client.request(
      '/api/devices/pending',
      method: 'GET',
      parse: (data) => (data as List)
          .map((e) => PendingDeviceLoginSummary.fromJson(e as Map<String, dynamic>))
          .toList(),
    );
  }

  Future<void> respondToPendingLogin(String pendingLoginId, {required bool approve}) {
    return _client.requestVoid(
      '/api/devices/pending/$pendingLoginId',
      body: {'approve': approve},
    );
  }
}
