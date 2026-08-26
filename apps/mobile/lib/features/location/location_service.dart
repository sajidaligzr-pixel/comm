/// Background capture + reporting for live location sharing
/// (docs/09-trust-boundaries.md's "Live location sharing" exception).
///
/// Rewritten for build 1.0.0+14 — through +13 this used `flutter_background_service`,
/// which crashed the app the instant it opened (not just at login, as the narrower
/// build +12 ProGuard fix addressed). Read directly from
/// `flutter_background_service_android`'s own `BackgroundService.java`
/// (`runService()`): starting its background isolate constructs a brand-new
/// `FlutterEngine`, which automatically re-registers *every* plugin this app
/// uses (`flutter_webrtc`, `local_auth`, `flutter_callkit_incoming`, etc.) with no
/// Activity ever attached to that engine — and `runService()`'s own try/catch only
/// ever catches `UnsatisfiedLinkError`, nothing else. Any other exception thrown by
/// any plugin's registration propagates straight up through `Service.onCreate()`
/// and kills the process, entirely outside anything a Dart `try/catch` (this file's
/// old defense-in-depth included) can reach. This isn't a guess this time — it's
/// read straight out of that plugin's own source.
///
/// The fix is to never create a second `FlutterEngine` at all. Actual location
/// capture + the HTTP POST now happen entirely natively, in a small hand-written
/// Android foreground service
/// (`android/app/src/main/kotlin/com/comm/comm_mobile/LocationForegroundService.kt`)
/// that only ever touches `com.google.android.gms.location` + a plain
/// `HttpURLConnection` — no Flutter, no plugin registry, nothing this bug could
/// recur from. This file's job shrinks to three things: (1) tell that native
/// service to start/stop, (2) hand it a snapshot of the current session (cookie +
/// CSRF value) since it has no Dart cookie jar of its own to read, and (3) refresh
/// that snapshot whenever the session actually rotates (`ApiClient.onTokensRefreshed`,
/// wired in auth_controller.dart) — the native service does *not* attempt its own
/// token refresh (a real, deliberate limitation: refresh tokens rotate
/// single-use-per-refresh, per docs/07-auth-architecture.md, so a second,
/// independent refresh attempt from native racing this app's own would risk the
/// server's reuse-detection treating it as theft and revoking the whole session —
/// a much worse failure than a location update briefly going stale). In practice
/// this means background reporting stays live for as long as the access token
/// remains valid since the app was last actually used (~15 minutes — the same
/// window every other part of this app's session already runs on), and resumes
/// automatically the next time the app is opened, rather than ever risking a
/// surprise forced sign-out.
library;

import 'dart:io' show Cookie;

import 'package:flutter/services.dart' show MethodChannel;
import 'package:permission_handler/permission_handler.dart';

import '../../api/api_client.dart';
import '../../api/app_config.dart';

const _channel = MethodChannel('comm/location_service');
const _csrfCookieName = 'comm_csrf'; // mirrors api_client.dart's private constant

class LocationService {
  LocationService._();

  static bool _started = false;

  /// Idempotent and safe to call speculatively (right after the permissions card
  /// resolves, and again on every app resume) — does nothing if location was never
  /// granted, and never starts a second instance of the native service. Always
  /// re-pushes the session snapshot even if already started, so a call here after
  /// sign-in-as-a-different-account (or any other cookie change) still reaches the
  /// native side.
  static Future<void> ensureStarted() async {
    final status = await Permission.locationWhenInUse.status;
    if (!status.isGranted) return;

    try {
      await _pushSessionSnapshot();
      if (!_started) {
        await _channel.invokeMethod<void>('start');
        _started = true;
      }
    } catch (_) {
      // Fail closed — location sharing just doesn't (re)start this call; every
      // other feature in the app keeps working normally.
    }
  }

  /// Called via `ApiClient.onTokensRefreshed` every time a refresh actually
  /// rotates the session — keeps the native service's copy of the cookie/CSRF
  /// value from going stale while the app is in active use. A no-op if the
  /// service was never started (nothing native is listening for it yet).
  static Future<void> refreshSession() async {
    if (!_started) return;
    try {
      await _pushSessionSnapshot();
    } catch (_) {
      // Best-effort, same posture as everywhere else in this file — the native
      // side just keeps using its last-known-good snapshot until the next
      // successful push.
    }
  }

  /// Called on sign-out (features/auth/auth_controller.dart) — sharing a
  /// signed-out device's location makes no sense, and the cookies the snapshot
  /// was built from are about to be cleared anyway.
  static Future<void> stop() async {
    _started = false;
    try {
      await _channel.invokeMethod<void>('clearSession');
      await _channel.invokeMethod<void>('stop');
    } catch (_) {
      // Best-effort — worst case the native service notices the cleared
      // session on its next tick and simply stops posting.
    }
  }

  static Future<void> _pushSessionSnapshot() async {
    final client = await ApiClient.initialize();
    final uri = Uri.parse(AppConfig.apiBaseUrl);
    final cookies = await client.cookieJar.loadForRequest(uri);
    if (cookies.isEmpty) return;

    final cookieHeader = cookies.map((c) => '${c.name}=${c.value}').join('; ');
    final csrf = cookies
        .firstWhere(
          (c) => c.name == _csrfCookieName,
          orElse: () => Cookie(_csrfCookieName, ''),
        )
        .value;

    await _channel.invokeMethod<void>('setSession', {
      'cookieHeader': cookieHeader,
      'csrfToken': csrf,
      'baseUrl': AppConfig.apiBaseUrl,
    });
  }
}
