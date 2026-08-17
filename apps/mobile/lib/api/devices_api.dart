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
      parse: (data) => LinkDeviceStartResponse.fromJson(data as Map<String, dynamic>),
    );
  }
}
