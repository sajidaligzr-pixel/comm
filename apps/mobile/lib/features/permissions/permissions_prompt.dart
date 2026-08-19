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
///
/// Notifications are deliberately NOT asked here — main.dart already requests
/// that unconditionally at process start (initLocalNotifications/
/// initPushNotifications), the earliest possible moment, so it's already
/// "up front" and asking again here would just be a redundant second dialog.
library;

import 'package:flutter/material.dart';
import 'package:permission_handler/permission_handler.dart';

import '../../storage/prefs.dart';

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
      final alreadyShown = await getPermissionsOnboardingShown();
      if (!alreadyShown && mounted) setState(() => _visible = true);
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
    } finally {
      await setPermissionsOnboardingShown();
      if (mounted) setState(() => _visible = false);
    }
  }

  Future<void> _skip() async {
    await setPermissionsOnboardingShown();
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
                      child: Icon(Icons.mic, color: theme.colorScheme.primary),
                    ),
                    const SizedBox(width: 12),
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          const Text('Allow microphone access?', style: TextStyle(fontWeight: FontWeight.w600)),
                          const SizedBox(height: 4),
                          Text(
                            "Needed for voice/video calls and voice notes. You'll only be asked once — "
                            'you can change this anytime in your phone\'s Settings.',
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
