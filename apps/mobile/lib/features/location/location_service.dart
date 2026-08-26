/// Background capture + reporting for live location sharing
/// (docs/09-trust-boundaries.md's "Live location sharing" exception) — the one
/// place this app deliberately keeps running (as a real Android foreground
/// service, mirroring features/calls/call_kit.dart's own native foreground-service
/// registration) to post a fix even while backgrounded/closed, matching the
/// "background/always-on" tracking mode this feature was built for.
///
/// `flutter_background_service`'s callback runs in its own headless isolate, not
/// the app's main one — `WidgetsFlutterBinding.ensureInitialized()` at the top of
/// each entrypoint is what that isolate needs before touching any plugin's
/// platform channel (path_provider/dio's bits, transitively via
/// `ApiClient.initialize()`), the same real, working pattern
/// `push_notifications.dart`'s `firebaseMessagingBackgroundHandler` already uses
/// for its own headless isolate. (The package's own README instead shows
/// `DartPluginRegistrant.ensureInitialized()` — tried first, but it made even a
/// real `flutter build apk` fail outright with "Undefined name" on this Flutter
/// version, not just a test/analyze-only quirk, so it's a real incompatibility
/// here, not a style choice — removed.) A fresh `ApiClient`/cookie jar is
/// (re)initialized inside that isolate rather than reused from the main one — Dart
/// isolates don't share static state — but it reads the same on-disk persisted
/// cookie file (api/api_client.dart's `PersistCookieJar`), so it picks up whatever
/// session is already signed in without a separate bootstrap.
///
/// Real platform constraint, not a gap: iOS throttles arbitrary-interval background
/// GPS hard regardless of what this requests — `IosConfiguration.onBackground`
/// below is best-effort there (the OS decides how often it actually runs), while
/// Android's real foreground service can sustain the fixed interval reliably.
library;

import 'dart:async';

import 'package:flutter/widgets.dart' show WidgetsFlutterBinding;
import 'package:flutter_background_service/flutter_background_service.dart';
import 'package:geolocator/geolocator.dart';
import 'package:permission_handler/permission_handler.dart';

import '../../api/api_client.dart';
import '../../api/locations_api.dart';

const _reportInterval = Duration(seconds: 60);
const _notificationChannelId = 'comm_location';
const _foregroundNotificationId = 4200;

/// Emergency kill switch — flipped off after a live report that the app was
/// crashing immediately on open (not just at login as the previous,
/// narrower ProGuard-only fix addressed). The most likely remaining cause is
/// Android itself throwing inside the native Service's onStartCommand/
/// startForeground callback when it actually spins up — a failure that
/// happens *after* the awaited `startService()` call below returns, in a
/// native callback outside anything a Dart `try/catch` in this file can
/// reach, so the existing try/catch was never going to catch it. Disabling
/// the start entirely (rather than guessing further at the native cause
/// blind) is the fast, safe way to get the app usable again; re-enable only
/// after reproducing and confirming a fix with real device logs.
const _kBackgroundLocationEnabled = false;

class LocationService {
  LocationService._();

  static bool _started = false;

  /// Idempotent and safe to call speculatively (right after the permissions card
  /// resolves, and again on every app resume) — does nothing if location was never
  /// granted, and never starts a second background service instance.
  static Future<void> ensureStarted() async {
    if (!_kBackgroundLocationEnabled) return;
    if (_started) return;
    final status = await Permission.locationWhenInUse.status;
    if (!status.isGranted) return;

    // Wrapped defensively, unlike the rest of this class's calls — this is the
    // one call in the whole login path that spins up a brand-new native
    // FlutterEngine (BackgroundService.java's runService()) and re-registers
    // every plugin into it; found live as the actual cause of a real app crash
    // right after login (com.baseflow.geolocator had no ProGuard keep rule —
    // see android/app/proguard-rules.pro's own note — so its release-build
    // registration into that second engine threw). The real fix is the keep
    // rule; this is defense in depth so a future plugin-registration problem
    // degrades to "location sharing doesn't start" instead of taking the whole
    // app down again.
    try {
      final service = FlutterBackgroundService();
      await service.configure(
        androidConfiguration: AndroidConfiguration(
          onStart: _onStart,
          autoStart: true,
          isForegroundMode: true,
          autoStartOnBoot: false,
          notificationChannelId: _notificationChannelId,
          initialNotificationTitle: 'Comm',
          initialNotificationContent: 'Sharing your location',
          foregroundServiceNotificationId: _foregroundNotificationId,
          foregroundServiceTypes: [AndroidForegroundType.location],
        ),
        iosConfiguration: IosConfiguration(
          autoStart: true,
          onForeground: _onStart,
          onBackground: _onIosBackground,
        ),
      );
      await service.startService();
      _started = true;
    } catch (_) {
      // Fail closed — location sharing just doesn't start this launch; every
      // other feature in the app keeps working normally.
    }
  }

  /// Called on sign-out (features/auth/auth_controller.dart) — sharing a
  /// signed-out device's location makes no sense, and the persisted cookie jar the
  /// background isolate reads is about to be cleared anyway.
  static Future<void> stop() async {
    if (!_started) return;
    FlutterBackgroundService().invoke('stop');
    _started = false;
  }
}

@pragma('vm:entry-point')
Future<bool> _onIosBackground(ServiceInstance service) async {
  WidgetsFlutterBinding.ensureInitialized();
  return true;
}

@pragma('vm:entry-point')
void _onStart(ServiceInstance service) {
  WidgetsFlutterBinding.ensureInitialized();

  service.on('stop').listen((event) => service.stopSelf());

  Timer.periodic(_reportInterval, (timer) async {
    try {
      final permission = await Geolocator.checkPermission();
      if (permission == LocationPermission.denied || permission == LocationPermission.deniedForever) {
        return;
      }
      final position = await Geolocator.getCurrentPosition(
        locationSettings: const LocationSettings(accuracy: LocationAccuracy.high),
      );
      final client = await ApiClient.initialize();
      await LocationsApi(client).reportMyLocation(
        latitude: position.latitude,
        longitude: position.longitude,
        accuracyM: position.accuracy,
        // -1 is geolocator's "unavailable" sentinel on some platforms for both of
        // these — normalized to null (the DTO/server schema's own "unknown" value)
        // rather than forwarding a meaningless negative number.
        headingDeg: position.heading >= 0 ? position.heading : null,
        speedMps: position.speed >= 0 ? position.speed : null,
        recordedAt: position.timestamp,
      );
    } catch (_) {
      // Best-effort — a single failed tick (no signal, offline, not signed in,
      // location toggled off since the last tick) just waits for the next one,
      // same posture as every other periodic background task in this app.
    }
  });
}
