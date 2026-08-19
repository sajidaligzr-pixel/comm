library;

import 'api_client.dart';
import 'dtos.dart';

class ConversationsApi {
  const ConversationsApi(this._client);
  final ApiClient _client;

  Future<List<ConversationSummary>> list() {
    return _client.request(
      '/api/conversations',
      method: 'GET',
      parse: (data) => (data as List)
          .map((e) => ConversationSummary.fromJson(e as Map<String, dynamic>))
          .toList(),
    );
  }

  Future<ConversationSummary> get(String id) {
    return _client.request(
      '/api/conversations/$id',
      method: 'GET',
      parse: (data) =>
          ConversationSummary.fromJson(data as Map<String, dynamic>),
    );
  }

  Future<ConversationSummary> createOrGetDirect(String withUsername) {
    return _client.request(
      '/api/conversations/direct',
      body: {'withUsername': withUsername},
      parse: (data) =>
          ConversationSummary.fromJson(data as Map<String, dynamic>),
    );
  }

  Future<void> markRead(String conversationId, String upToMessageId) {
    return _client.requestVoid(
      '/api/conversations/$conversationId/read',
      body: {'upToMessageId': upToMessageId},
    );
  }

  Future<void> updateSettings(
    String conversationId, {
    String? disappearingTimer,
    bool? archived,
    bool? pinned,
  }) {
    return _client.requestVoid(
      '/api/conversations/$conversationId',
      method: 'PATCH',
      body: {
        if (disappearingTimer != null) 'disappearingTimer': disappearingTimer,
        if (archived != null) 'archived': archived,
        if (pinned != null) 'pinned': pinned,
      },
    );
  }

  /// Every OTHER member's active device — what a `direct`-conversation send needs
  /// to encrypt for (one `encryptForDevice` call each), for real multi-device sync.
  /// Combined client-side with the caller's own other active devices
  /// (`DevicesApi.list()`, filtered to `!isCurrentDevice`) for self-fan-out — see
  /// `thread_screen.dart`'s send flow. Was a singular "primary device" guess before
  /// this; replaced outright, not kept alongside, since there's no longer a single
  /// correct device to guess.
  Future<List<({String userId, String deviceId})>> recipientDevices(
    String conversationId,
  ) {
    return _client.request(
      '/api/conversations/$conversationId/recipient-devices',
      method: 'GET',
      parse: (data) => (data as List)
          .map((e) => e as Map<String, dynamic>)
          .map(
            (m) => (
              userId: m['userId'] as String,
              deviceId: m['deviceId'] as String,
            ),
          )
          .toList(),
    );
  }
}
