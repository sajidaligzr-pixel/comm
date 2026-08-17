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
      parse: (data) => (data as List).map((e) => ConversationSummary.fromJson(e as Map<String, dynamic>)).toList(),
    );
  }

  Future<ConversationSummary> get(String id) {
    return _client.request(
      '/api/conversations/$id',
      method: 'GET',
      parse: (data) => ConversationSummary.fromJson(data as Map<String, dynamic>),
    );
  }

  Future<ConversationSummary> createOrGetDirect(String withUsername) {
    return _client.request(
      '/api/conversations/direct',
      body: {'withUsername': withUsername},
      parse: (data) => ConversationSummary.fromJson(data as Map<String, dynamic>),
    );
  }

  Future<void> markRead(String conversationId, String upToMessageId) {
    return _client.requestVoid('/api/conversations/$conversationId/read', body: {'upToMessageId': upToMessageId});
  }

  Future<void> updateSettings(String conversationId, {String? disappearingTimer, bool? archived}) {
    return _client.requestVoid(
      '/api/conversations/$conversationId',
      method: 'PATCH',
      body: {if (disappearingTimer != null) 'disappearingTimer': disappearingTimer, if (archived != null) 'archived': archived},
    );
  }

  /// The primary (most-recently-active) device id for the other member of a direct
  /// conversation — what `SendMessageRequest.recipientDeviceId` must target. Null if
  /// the other member has no active device at all (shouldn't happen in practice —
  /// every account has at least the device it was created on, unless fully revoked).
  Future<({String userId, String deviceId})?> recipientDevice(String conversationId) {
    return _client.request(
      '/api/conversations/$conversationId/recipient-device',
      method: 'GET',
      parse: (data) {
        if (data == null) return null;
        final map = data as Map<String, dynamic>;
        return (userId: map['userId'] as String, deviceId: map['deviceId'] as String);
      },
    );
  }
}
