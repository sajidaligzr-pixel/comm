/// A deliberate indirection so widely-imported app code (permissions_prompt.dart,
/// chats_list_screen.dart, auth_controller.dart — all reachable from many unit
/// tests) can trigger starting/stopping/refreshing live-location background
/// reporting without importing `location_service.dart` itself.
///
/// Kept even though the original reason for it (location_service.dart being
/// genuinely uncompilable under `flutter test`/`flutter analyze` because of
/// flutter_background_service's `DartPluginRegistrant.ensureInitialized()`
/// build-generated symbol — see git history around build 1.0.0+10 through +13)
/// no longer applies now that that package is gone: this is still the
/// established pattern every other call site already uses, and it keeps
/// location_service.dart's `MethodChannel`/platform-specific surface out of
/// test-reachable import graphs on general principle, not just this one past
/// incident. `main.dart` is the one place that imports `location_service.dart`
/// and wires these hooks to the real implementation; everything else goes
/// through this file instead.
library;

typedef AsyncVoidCallback = Future<void> Function();

Future<void> _noop() async {}

class LocationServiceHooks {
  LocationServiceHooks._();

  /// Replaced with `LocationService.ensureStarted`/`.stop`/`.refreshSession` by
  /// main.dart at startup. Default to no-ops so a call site (or a test) that
  /// runs before that wiring — or in a test process, which never runs
  /// main.dart at all — is harmless rather than a null-check crash.
  static AsyncVoidCallback ensureStarted = _noop;
  static AsyncVoidCallback stop = _noop;
  static AsyncVoidCallback refreshSession = _noop;
}
