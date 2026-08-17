/// `AuthNeedsUnlock` — a still-valid server session whose local KEK just needs
/// re-deriving. Password is always the fallback; when biometric unlock has been
/// enrolled on this device (Devices screen) and the hardware is available, this
/// also offers a biometric prompt — auto-triggered once on entry (matches the
/// common native pattern, e.g. WhatsApp/Signal desktop) plus a manual retry button,
/// mirroring apps/web/components/unlock-gate.tsx's own "try biometrics first, real
/// password field always still right there" layout.
library;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../api/api_client.dart';
import 'auth_controller.dart';
import 'auth_state.dart';
import 'biometric_unlock.dart' as biometric;

class UnlockScreen extends ConsumerStatefulWidget {
  const UnlockScreen({super.key});
  @override
  ConsumerState<UnlockScreen> createState() => _UnlockScreenState();
}

class _UnlockScreenState extends ConsumerState<UnlockScreen> {
  final _passwordController = TextEditingController();
  String? _error;
  bool _submitting = false;
  bool _biometricOffered = false;
  bool _biometricAttempting = false;

  @override
  void initState() {
    super.initState();
    _checkBiometricAndMaybeAutoPrompt();
  }

  Future<void> _checkBiometricAndMaybeAutoPrompt() async {
    try {
      final available = await biometric.isBiometricAvailable();
      final enabled = available && await biometric.isBiometricUnlockEnabled();
      if (!mounted) return;
      setState(() => _biometricOffered = enabled);
      if (enabled) await _tryBiometricUnlock(auto: true);
    } catch (_) {
      // Fail closed, matching biometric_unlock.dart itself — worst case the button
      // just never offers itself, never a crash on this screen.
    }
  }

  Future<void> _tryBiometricUnlock({bool auto = false}) async {
    if (_biometricAttempting || _submitting) return;
    setState(() {
      _biometricAttempting = true;
      _error = null;
    });
    try {
      final ok = await ref.read(authControllerProvider.notifier).unlockWithBiometrics();
      // A failed *auto* attempt (e.g. the user just didn't want to scan right now)
      // shouldn't plant an error message before they've even looked at the screen —
      // only a failure from an explicit tap gets surfaced.
      if (!ok && !auto && mounted) {
        setState(() => _error = "Couldn't unlock with biometrics — try your password instead.");
      }
    } finally {
      if (mounted) setState(() => _biometricAttempting = false);
    }
  }

  @override
  void dispose() {
    _passwordController.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    final password = _passwordController.text;
    if (password.isEmpty) return;

    setState(() {
      _error = null;
      _submitting = true;
    });
    try {
      await ref.read(authControllerProvider.notifier).unlock(password);
    } on ApiException catch (e) {
      setState(() => _error = e.message);
    } finally {
      if (mounted) setState(() => _submitting = false);
    }
  }

  Future<void> _signInAsSomeoneElse() async {
    await ref.read(authControllerProvider.notifier).logout();
  }

  @override
  Widget build(BuildContext context) {
    final state = ref.watch(authControllerProvider);
    final username = state is AuthNeedsUnlock ? state.profile.username : '';

    return Scaffold(
      body: SafeArea(
        child: Center(
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 400),
            child: Padding(
              padding: const EdgeInsets.all(24),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  Icon(Icons.lock_outline_rounded, size: 48, color: Theme.of(context).colorScheme.primary),
                  const SizedBox(height: 12),
                  Text('Welcome back, @$username', style: Theme.of(context).textTheme.titleLarge, textAlign: TextAlign.center),
                  const SizedBox(height: 8),
                  Text(
                    _biometricOffered ? 'Unlock this device to continue.' : 'Enter your password to unlock this device.',
                    style: Theme.of(context).textTheme.bodyMedium,
                    textAlign: TextAlign.center,
                  ),
                  if (_biometricOffered) ...[
                    const SizedBox(height: 20),
                    OutlinedButton.icon(
                      onPressed: _biometricAttempting || _submitting ? null : () => _tryBiometricUnlock(),
                      icon: _biometricAttempting
                          ? const SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2))
                          : const Icon(Icons.fingerprint),
                      label: const Text('Unlock with biometrics'),
                    ),
                    const SizedBox(height: 16),
                    Row(
                      children: [
                        const Expanded(child: Divider()),
                        Padding(
                          padding: const EdgeInsets.symmetric(horizontal: 12),
                          child: Text('or', style: Theme.of(context).textTheme.bodySmall),
                        ),
                        const Expanded(child: Divider()),
                      ],
                    ),
                    const SizedBox(height: 8),
                  ] else
                    const SizedBox(height: 24),
                  TextField(
                    controller: _passwordController,
                    decoration: const InputDecoration(labelText: 'Password'),
                    obscureText: true,
                    autofocus: !_biometricOffered,
                    enabled: !_submitting,
                    onSubmitted: (_) => _submit(),
                  ),
                  if (_error != null) ...[
                    const SizedBox(height: 12),
                    Text(_error!, style: TextStyle(color: Theme.of(context).colorScheme.error)),
                  ],
                  const SizedBox(height: 24),
                  FilledButton(
                    onPressed: _submitting ? null : _submit,
                    child: _submitting
                        ? const SizedBox(width: 20, height: 20, child: CircularProgressIndicator(strokeWidth: 2))
                        : const Text('Unlock'),
                  ),
                  const SizedBox(height: 8),
                  TextButton(onPressed: _submitting ? null : _signInAsSomeoneElse, child: const Text('Sign in as someone else')),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}
