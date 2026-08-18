/// `POST /api/push/subscribe` / `POST /api/push/unsubscribe` — registers this
/// device's FCM token so apps/worker can push to it while this app is closed/
/// backgrounded (push_notifications.dart is what calls this, on first launch after
/// sign-in and again on every token refresh). Mirrors apps/web's own
/// notification-prompt.tsx call to the same route, just with `provider: 'fcm'` and
/// a bare registration token instead of a Web Push subscription object — see
/// packages/types/src/push.ts's `AnyPushSubscriptionRequest` for why the server
/// accepts either shape on the same endpoint.
library;

import 'api_client.dart';

class PushApi {
  const PushApi(this._client);
  final ApiClient _client;

  Future<void> subscribeFcm(String token) => _client.requestVoid(
    '/api/push/subscribe',
    method: 'POST',
    body: {'provider': 'fcm', 'token': token},
  );

  Future<void> unsubscribe() =>
      _client.requestVoid('/api/push/unsubscribe', method: 'POST');
}
