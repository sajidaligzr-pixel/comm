library;

import 'api_client.dart';

class IceServer {
  final dynamic urls; // String or List<String>
  final String? username;
  final String? credential;
  const IceServer({required this.urls, this.username, this.credential});

  static IceServer fromJson(Map<String, dynamic> json) =>
      IceServer(urls: json['urls'], username: json['username'] as String?, credential: json['credential'] as String?);

  Map<String, dynamic> toJson() => {'urls': urls, if (username != null) 'username': username, if (credential != null) 'credential': credential};
}

class CallsApi {
  const CallsApi(this._client);
  final ApiClient _client;

  /// Empty list is a valid, expected response — it means no coturn deployment is
  /// configured and ICE will only gather host/reflexive candidates (fine on the same
  /// network, not guaranteed across arbitrary real-world NATs). Falls back to an
  /// empty list on any error too, same as the web client — a call attempt shouldn't
  /// hard-fail just because this best-effort fetch did.
  Future<List<IceServer>> turnCredentials() async {
    try {
      return await _client.request(
        '/api/calls/turn-credentials',
        parse: (data) => ((data as Map<String, dynamic>)['iceServers'] as List)
            .map((e) => IceServer.fromJson(e as Map<String, dynamic>))
            .toList(),
      );
    } on ApiException {
      return const [];
    }
  }
}
