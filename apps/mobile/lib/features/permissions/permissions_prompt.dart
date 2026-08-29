/// One-time "allow permissions" card — mirrors
/// features/auth/biometric_enroll_prompt.dart's exact shape (mounted from
/// chats_list_screen.dart, the first signed-in screen, rather than the app
/// shell's top level — nothing here needs the KEK the way that prompt does, but
/// there's equally no reason to ask before the user has actually signed in).
///
/// Asks up front for everything the app can meaningfully use, instead of the
/// previous behavior of only prompting for microphone access the moment the
/// user first tried to place a call or record a voice note — confusing when it
/// happens mid-action, and easy to fumble into a permanent "don't ask again"
/// denial that then silently breaks calling. Requesting once, right after
/// sign-in, mirrors how WhatsApp/Signal/Telegram all front-load this.
///
/// - Microphone: voice/video calls (call_controller.dart, group_call_controller.dart)
///   and voice notes (thread_screen.dart's recorder). Both of those still call
///   `Permission.microphone.request()` themselves as a fallback — this card
///   doesn't replace that, it just means the OS dialog usually already has an
///   answer by the time either path runs.
/// - Bluetooth (Connect): needed on Android 12+ for call audio to route to a
///   connected headset (flutter_webrtc's own manifest pulls in
///   BLUETOOTH_CONNECT, but nothing in this app ever actually requested it at
///   runtime before now — a real, if minor, latent gap).
/// - Location (While Using only — see below): live location sharing
///   (docs/09-trust-boundaries.md's explicit exception, features/location/) —
///   this account's location is continuously shared with this app's admins (and
///   anyone they grant access to) once granted, including while the app is
///   backgrounded/closed. The card's own copy says so plainly.
///   Deliberately NOT also requesting "Always" (build 1.0.0+14 onward): the
///   background capture is a genuine Android foreground service
///   (LocationForegroundService.kt, foregroundServiceType="location") rather
///   than a background-without-a-foreground-service mechanism, and Android
///   grants a location-type foreground service access on "While Using" alone
///   for as long as it's running — "Always" would be a real permission this
///   design has no actual use for, which is exactly the kind of over-asking the
///   "permission strings must match what the app actually does" rule this
///   feature was built under rules out.
///
/// - Battery optimization exemption (Settings.ACTION_REQUEST_IGNORE_
///   BATTERY_OPTIMIZATIONS, via Permission.ignoreBatteryOptimizations):
///   without this, a real Android device (confirmed live via adb on a Samsung
///   phone — dumpsys deviceidle whitelist) can silently fail to actually show
///   the incoming-call screen for a closed/backgrounded app, even though the
///   FCM push itself demonstrably still arrives — Doze/App Standby throttles
///   what a backgrounded app's process is allowed to do once woken, separately
///   from whether it gets woken at all. Google Play's Battery policy names
///   VoIP/real-time-communication apps as the intended exception to "don't
///   request this permission" — this app's calling feature is exactly that,
///   not a battery-life workaround dressed up as one.
///
/// Notifications are deliberately NOT asked here — main.dart already requests
/// that unconditionally at process start (initLocalNotifications/
/// initPushNotifications), the earliest possible moment, so it's already
/// "up front" and asking again here would just be a redundant second dialog.
///
/// Versioned "already shown" check ([_currentOnboardingVersion] /
/// `getPermissionsOnboardingVersionSeen` in prefs.dart), not a plain one-shot
/// boolean — found live: build 10 added the location request above to this
/// card, but every existing install had already permanently dismissed/completed
/// it back when it only asked for microphone/Bluetooth, so the card silently
/// never showed again and location was never actually requested (confirmed on
/// a real device: the update installed, no location dialog ever appeared, and
/// Settings showed no location permission granted). Bump this constant whenever
/// the card starts asking for something new; anyone who last saw an older
/// version sees it again — re-requesting an already-granted or
/// already-permanently-denied permission is a harmless no-op dialog on both
/// platforms, so this never re-nags for the parts that didn't change.
library;

import 'package:flutter/material.dart';
import 'package:permission_handler/permission_handler.dart';

import '../../storage/prefs.dart';
import '../location/location_service_hooks.dart';

const _currentOnboardingVersion = 3;

class PermissionsOnboardingPrompt extends StatefulWidget {
  const PermissionsOnboardingPrompt({super.key});

  @override
  State<PermissionsOnboardingPrompt> createState() => _PermissionsOnboardingPromptState();
}

class _PermissionsOnboardingPromptState extends State<PermissionsOnboardingPrompt> {
  bool _visible = false;
  bool _busy = false;

  @override
  void initState() {
    super.initState();
    _check();
  }

  Future<void> _check() async {
    try {
      final seenVersion = await getPermissionsOnboardingVersionSeen();
      if (seenVersion < _currentOnboardingVersion && mounted) setState(() => _visible = true);
    } catch (_) {
      // Fail closed, same as biometric_enroll_prompt.dart's identical check —
      // worst case this card just never offers itself, never a crash.
    }
  }

  Future<void> _allow() async {
    setState(() => _busy = true);
    try {
      // Fired one after another rather than via Future.wait — two system
      // permission dialogs stacking/racing on screen at once is exactly the
      // kind of native-UI edge case worth just not risking.
      await Permission.microphone.request();
      await Permission.bluetoothConnect.request();
      final whileInUse = await Permission.locationWhenInUse.request();
      if (whileInUse.isGranted) {
        // No follow-up "Always" request — see this file's own docstring for
        // why "While Using" is genuinely sufficient for this feature's design.
        await LocationServiceHooks.ensureStarted();
      }
      // No-op on iOS (permission_handler only wires this up for Android) and a
      // harmless already-granted no-op on a device that's already exempted —
      // see this file's own docstring for why this is asked at all.
      await Permission.ignoreBatteryOptimizations.request();
    } finally {
      await setPermissionsOnboardingVersionSeen(_currentOnboardingVersion);
      if (mounted) setState(() => _visible = false);
    }
  }

  Future<void> _skip() async {
    await setPermissionsOnboardingVersionSeen(_currentOnboardingVersion);
    if (mounted) setState(() => _visible = false);
  }

  @override
  Widget build(BuildContext context) {
    if (!_visible) return const SizedBox.shrink();
    final theme = Theme.of(context);

    return Align(
      alignment: Alignment.bottomCenter,
      child: SafeArea(
        child: Padding(
          padding: const EdgeInsets.all(12),
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 420),
            child: Material(
              elevation: 4,
              borderRadius: BorderRadius.circular(16),
              color: theme.colorScheme.surfaceContainerHigh,
              child: Padding(
                padding: const EdgeInsets.all(12),
                child: Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    CircleAvatar(
                      backgroundColor: theme.colorScheme.primaryContainer,
                      child: Icon(Icons.shield_outlined, color: theme.colorScheme.primary),
                    ),
                    const SizedBox(width: 12),
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          const Text('Allow app permissions?', style: TextStyle(fontWeight: FontWeight.w600)),
                          const SizedBox(height: 4),
                          Text(
                            'Microphone, for calls and voice notes. Location, visible live to this app\'s '
                            "admins — even while it's closed. Battery, so calls and messages still arrive "
                            "when it's closed. Asked once; change any of it anytime in Settings.",
                            style: theme.textTheme.bodySmall,
                          ),
                          const SizedBox(height: 8),
                          Row(
                            children: [
                              FilledButton(
                                onPressed: _busy ? null : _allow,
                                child: _busy
                                    ? const SizedBox(width: 14, height: 14, child: CircularProgressIndicator(strokeWidth: 2))
                                    : const Text('Continue'),
                              ),
                              const SizedBox(width: 8),
                              TextButton(onPressed: _busy ? null : _skip, child: const Text('Not now')),
                            ],
                          ),
                        ],
                      ),
                    ),
                    IconButton(icon: const Icon(Icons.close, size: 18), onPressed: _busy ? null : _skip, tooltip: 'Dismiss'),
                  ],
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}
