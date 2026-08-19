/// Opt-in biometric-unlock prompt — mirrors
/// `apps/web/components/biometric-enroll-prompt.tsx`'s exact shape (ask once,
/// snooze on dismiss for two weeks — storage/prefs.dart's
/// `setBiometricPromptDismissedNow`). Mounted from chats_list_screen.dart (the
/// first signed-in screen) rather than the app shell's top level: enrolling wraps
/// the real KEK (`biometric_unlock.dart#enableBiometricUnlock`), which only exists
/// in memory once the device is actually unlocked — showing this any earlier would
/// have nothing to wrap.
///
/// Deliberately waits for `PermissionsOnboardingPrompt` (features/permissions/) to
/// have already been resolved before ever offering itself — both cards render
/// `Align(bottom)` in the same Stack (chats_list_screen.dart), and both being
/// visible at once would just paint one directly on top of the other. Since this
/// only re-checks on mount, denying/completing the permissions card mid-session
/// won't make this one appear until the next cold start — an acceptable one-launch
/// delay in exchange for never risking the overlap.
library;

import 'package:flutter/material.dart';

import '../../crypto/kek_holder.dart';
import '../../storage/prefs.dart';
import 'biometric_unlock.dart' as biometric;

const _snooze = Duration(days: 14);

class BiometricEnrollPrompt extends StatefulWidget {
  const BiometricEnrollPrompt({super.key, required this.username});
  final String username;

  @override
  State<BiometricEnrollPrompt> createState() => _BiometricEnrollPromptState();
}

class _BiometricEnrollPromptState extends State<BiometricEnrollPrompt> {
  bool _visible = false;
  bool _busy = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    _check();
  }

  Future<void> _check() async {
    try {
      if (!await getPermissionsOnboardingShown()) return;
      final dismissedAt = await getBiometricPromptDismissedAt(widget.username);
      if (dismissedAt != null && DateTime.now().toUtc().difference(dismissedAt) < _snooze) return;
      final available = await biometric.isBiometricAvailable();
      final alreadyEnabled = available && await biometric.isBiometricUnlockEnabled();
      if (available && !alreadyEnabled && mounted) setState(() => _visible = true);
    } catch (_) {
      // Fail closed, same as every other capability check in this feature — worst
      // case the prompt just never offers itself, never a crash.
    }
  }

  Future<void> _dismiss() async {
    await setBiometricPromptDismissedNow(widget.username);
    if (mounted) setState(() => _visible = false);
  }

  Future<void> _enable() async {
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final kek = getCurrentKek();
      if (kek == null) {
        // Shouldn't happen given where this is mounted, but this widget makes no
        // assumption about its caller beyond "rendered somewhere signed-in" — it
        // checks rather than trusts its own placement.
        setState(() => _error = 'This device needs to be unlocked first.');
        return;
      }
      final ok = await biometric.enableBiometricUnlock(kek);
      if (!ok) {
        setState(() => _error = "Couldn't turn this on right now. You can try again later from Devices.");
        return;
      }
      if (mounted) setState(() => _visible = false);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
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
                      child: Icon(Icons.fingerprint, color: theme.colorScheme.primary),
                    ),
                    const SizedBox(width: 12),
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          const Text('Unlock with your fingerprint?', style: TextStyle(fontWeight: FontWeight.w600)),
                          const SizedBox(height: 4),
                          Text(
                            'Skip typing your password on this device from now on. Your account password still '
                            'works everywhere else.',
                            style: theme.textTheme.bodySmall,
                          ),
                          if (_error != null) ...[
                            const SizedBox(height: 4),
                            Text(_error!, style: TextStyle(color: theme.colorScheme.error, fontSize: 12)),
                          ],
                          const SizedBox(height: 8),
                          Row(
                            children: [
                              FilledButton(
                                onPressed: _busy ? null : _enable,
                                child: _busy
                                    ? const SizedBox(width: 14, height: 14, child: CircularProgressIndicator(strokeWidth: 2))
                                    : const Text('Enable'),
                              ),
                              const SizedBox(width: 8),
                              TextButton(onPressed: _busy ? null : _dismiss, child: const Text('Not now')),
                            ],
                          ),
                        ],
                      ),
                    ),
                    IconButton(icon: const Icon(Icons.close, size: 18), onPressed: _busy ? null : _dismiss, tooltip: 'Dismiss'),
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
