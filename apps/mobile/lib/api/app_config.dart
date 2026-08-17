/// Runtime configuration. Defaults to the real, already-deployed backend
/// (https://apk4game.com) — this is the server the app talks to out of the box,
/// installed on a real phone with no setup. Override at build/run time for local
/// development against `npm run dev` instead:
///
///   flutter run --dart-define=API_BASE_URL=http://10.0.2.2:3000   # Android emulator
///   flutter run --dart-define=API_BASE_URL=http://localhost:3000  # iOS sim / macOS / web
///   flutter build apk --dart-define=API_BASE_URL=https://apk4game.com  # explicit prod build
library;

abstract final class AppConfig {
  static const String _override = String.fromEnvironment('API_BASE_URL');
  static const String _productionUrl = 'https://apk4game.com';

  static String get apiBaseUrl => _override.isNotEmpty ? _override : _productionUrl;

  /// wss://host or ws://host, derived from apiBaseUrl — see
  /// lib/realtime/ws_client.dart.
  static String get realtimeUrl {
    final uri = Uri.parse(apiBaseUrl);
    final scheme = uri.scheme == 'https' ? 'wss' : 'ws';
    return '$scheme://${uri.authority}/realtime';
  }
}
