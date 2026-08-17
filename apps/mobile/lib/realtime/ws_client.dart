/// Client-side WebSocket connection to the realtime channel — mobile counterpart to
/// `apps/web/lib/realtime-client.ts`. A browser tab rides its auth cookie to the `/realtime`
/// upgrade automatically; there's no browser here, so the access-token cookie is read
/// out of the same persisted jar `api_client.dart` uses and sent explicitly as a
/// `Cookie` header on the WS handshake (`IOWebSocketChannel.connect` supports custom
/// headers on native platforms). Reconnects with exponential backoff + jitter, same
/// as the web client; consumers subscribe to event types rather than touching the
/// wire format directly.
library;

import 'dart:async';
import 'dart:convert';
import 'dart:math';
import 'package:cookie_jar/cookie_jar.dart';
import 'package:web_socket_channel/io.dart';
import 'package:web_socket_channel/web_socket_channel.dart';

import '../api/app_config.dart';

typedef RealtimeListener = void Function(Map<String, dynamic> payload);

class RealtimeClient {
  RealtimeClient(this._cookieJar);

  final CookieJar _cookieJar;

  WebSocketChannel? _channel;
  StreamSubscription<dynamic>? _sub;
  int _reconnectAttempt = 0;
  bool _intentionallyClosed = false;
  Timer? _reconnectTimer;

  final Map<String, List<RealtimeListener>> _listeners = {};

  void on(String type, RealtimeListener listener) {
    (_listeners[type] ??= []).add(listener);
  }

  void off(String type, RealtimeListener listener) {
    _listeners[type]?.remove(listener);
  }

  void _emit(String type, Map<String, dynamic> payload) {
    for (final l in List.of(_listeners[type] ?? const [])) {
      l(payload);
    }
  }

  void send(Map<String, dynamic> payload) {
    final channel = _channel;
    if (channel == null) return;
    // A dropped/reconnecting socket silently drops the send here — callers that need
    // guaranteed delivery (message sending) go through the REST endpoint instead
    // (messages_api.dart), matching the web client's own convention exactly.
    try {
      channel.sink.add(jsonEncode(payload));
    } catch (_) {
      // socket not actually open yet/anymore — same silent-drop contract as above.
    }
  }

  Future<void> connect() async {
    if (_channel != null) return;
    _intentionallyClosed = false;

    final uri = Uri.parse(AppConfig.apiBaseUrl);
    final cookies = await _cookieJar.loadForRequest(uri);
    final cookieHeader = cookies.map((c) => '${c.name}=${c.value}').join('; ');

    final wsUri = Uri.parse(AppConfig.realtimeUrl);
    final channel = IOWebSocketChannel.connect(wsUri, headers: {'Cookie': cookieHeader});
    _channel = channel;

    try {
      await channel.ready;
    } catch (_) {
      _channel = null;
      _scheduleReconnect();
      return;
    }

    _reconnectAttempt = 0;
    _emit('connection.open', const {});

    _sub = channel.stream.listen(
      (data) {
        try {
          final parsed = jsonDecode(data as String);
          if (parsed is Map<String, dynamic> && parsed['type'] is String) {
            _emit(parsed['type'] as String, parsed);
          }
        } catch (_) {
          // Malformed frame — ignored rather than crashing the connection.
        }
      },
      onDone: () {
        final code = channel.closeCode;
        _emit('connection.close', {'code': code});
        _channel = null;
        // 4001 = device_revoked (server/realtime/ws-server.ts) — don't reconnect
        // into a session that's been explicitly torn down.
        if (code == 4001) {
          _intentionallyClosed = true;
          return;
        }
        _scheduleReconnect();
      },
      onError: (_) {
        // onDone always follows an error for a WebSocket — reconnect scheduling
        // happens there, not duplicated here.
      },
      cancelOnError: false,
    );
  }

  void _scheduleReconnect() {
    if (_intentionallyClosed) return;
    final delayMs = min(1000 * pow(2, _reconnectAttempt).toInt(), 30000) + Random().nextInt(500);
    _reconnectAttempt += 1;
    _reconnectTimer?.cancel();
    _reconnectTimer = Timer(Duration(milliseconds: delayMs), connect);
  }

  Future<void> disconnect() async {
    _intentionallyClosed = true;
    _reconnectTimer?.cancel();
    await _sub?.cancel();
    await _channel?.sink.close(1000, 'client_disconnect');
    _channel = null;
  }
}
