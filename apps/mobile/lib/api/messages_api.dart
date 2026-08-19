library;

import 'api_client.dart';
import 'dtos.dart';

class MessagesApi {
  const MessagesApi(this._client);
  final ApiClient _client;

  Future<CursorPage<MessageDto>> list(
    String conversationId, {
    String? cursor,
    int limit = 50,
  }) {
    return _client.request(
      '/api/conversations/$conversationId/messages',
      method: 'GET',
      query: {if (cursor != null) 'cursor': cursor, 'limit': limit},
      parse: (data) => CursorPage.fromJson(
        data as Map<String, dynamic>,
        MessageDto.fromJson,
      ),
    );
  }

  /// This is the ONLY send path the shipped web client actually uses (guaranteed
  /// delivery regardless of socket state — see the REST route's own comment); the
  /// mobile client follows the same convention rather than trying WS `message.send`
  /// first, matching `apps/web/components/chat/message-thread.tsx`'s behavior.
  Future<MessageDto> send(String conversationId, SendMessageRequest req) {
    return _client.request(
      '/api/conversations/$conversationId/messages',
      body: req.toJson(),
      parse: (data) => MessageDto.fromJson(data as Map<String, dynamic>),
    );
  }

  Future<void> markDelivered(String messageId) =>
      _client.requestVoid('/api/messages/$messageId/delivered', method: 'POST');

  Future<void> delete(String messageId) =>
      _client.requestVoid('/api/messages/$messageId', method: 'DELETE');

  /// See `StarredMessage`'s doc comment in schema.prisma — a plain per-user
  /// metadata flag, cross-device synced, never routed through the E2E
  /// message pipeline the way reactions are.
  Future<void> star(String messageId) =>
      _client.requestVoid('/api/messages/$messageId/star', method: 'POST');

  Future<void> unstar(String messageId) =>
      _client.requestVoid('/api/messages/$messageId/star', method: 'DELETE');

  Future<List<StarredMessageDto>> listStarred() {
    return _client.request(
      '/api/messages/starred',
      method: 'GET',
      parse: (data) => (data as List)
          .map((e) => StarredMessageDto.fromJson(e as Map<String, dynamic>))
          .toList(),
    );
  }
}
