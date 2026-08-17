/// `/api/keys/*` — a device fetching a stranger's public key bundle to start an X3DH
/// session, and topping up/rotating its own published keys.
library;

import 'api_client.dart';
import 'dtos.dart';

class KeysApi {
  const KeysApi(this._client);
  final ApiClient _client;

  Future<KeyBundleResponse> fetchBundle(String userId, String deviceId) {
    return _client.request(
      '/api/keys/bundle/$userId/$deviceId',
      method: 'GET',
      parse: (data) => KeyBundleResponse.fromJson(data as Map<String, dynamic>),
    );
  }

  Future<void> uploadSignedPreKey(SignedPreKeyUpload signedPreKey) {
    return _client.requestVoid('/api/keys/signed-prekey', body: signedPreKey.toJson());
  }

  Future<void> uploadOneTimePreKeys(List<OneTimePreKeyUpload> keys) {
    return _client.requestVoid(
      '/api/keys/one-time-prekeys',
      body: {'oneTimePreKeys': keys.map((k) => k.toJson()).toList()},
    );
  }

  Future<int> remainingOneTimePreKeyCount() {
    return _client.request(
      '/api/keys/one-time-prekeys/count',
      method: 'GET',
      parse: (data) => (data as Map<String, dynamic>)['remaining'] as int,
    );
  }
}
