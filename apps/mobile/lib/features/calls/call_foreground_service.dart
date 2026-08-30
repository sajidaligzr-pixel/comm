/// Bridges call_controller.dart to CallForegroundService.kt (Android only) — see
/// that native file's own docstring for the full "voice stops when the screen
/// locks/app backgrounds" root cause and fix. A plain `MethodChannel` call, same
/// shape as features/location/location_service.dart's own bridge to
/// LocationForegroundService: best-effort, wrapped in try/catch rather than
/// gated behind an explicit `Platform.isAndroid` check, since there's no native
/// handler registered for this channel on iOS at all (AppDelegate.swift never
/// registers it) — invoking it there simply throws a MissingPluginException,
/// which the try/catch turns into a harmless no-op. iOS doesn't need this fix:
/// its call audio already stays live in the background via CallKit + the
/// `voip`/`audio` UIBackgroundModes this app already declares (Info.plist).
library;

import 'package:flutter/services.dart' show MethodChannel;

const _channel = MethodChannel('comm/call_foreground_service');

class CallForegroundService {
  CallForegroundService._();

  /// Called the instant a call becomes genuinely active — this device accepting
  /// an incoming call, or the remote side answering this device's own outgoing
  /// call (call_controller.dart's own call sites) — never while merely ringing,
  /// so the "Call in progress" notification only ever appears once there's a
  /// real call to show it for.
  static Future<void> start() async {
    try {
      await _channel.invokeMethod<void>('start');
    } catch (_) {
      // Fail open — worst case this specific fix doesn't apply and the call
      // behaves as it did before, not a reason to fail the call itself.
    }
  }

  /// Called from CallController's own single call-teardown choke point
  /// (`_teardown`), so every way a call can end (answered elsewhere, rejected,
  /// hung up, ICE failure, ring timeout) reliably stops this too — a no-op if
  /// `start` was never called for this call (e.g. it never got past ringing).
  static Future<void> stop() async {
    try {
      await _channel.invokeMethod<void>('stop');
    } catch (_) {
      // Best-effort, same posture as start() above.
    }
  }
}
