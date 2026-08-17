/// Password-only unlock for now (`AuthNeedsUnlock` — a still-valid server session
/// whose local KEK just needs re-deriving). Biometric unlock (local_auth, mirroring
/// apps/web/lib/crypto/biometric-unlock.ts) is tracked as a follow-up milestone, not
/// wired in this pass — see apps/mobile/README.md.
library;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../api/api_client.dart';
import 'auth_controller.dart';
import 'auth_state.dart';

class UnlockScreen extends ConsumerStatefulWidget {
  const UnlockScreen({super.key});
  @override
  ConsumerState<UnlockScreen> createState() => _UnlockScreenState();
}

class _UnlockScreenState extends ConsumerState<UnlockScreen> {
  final _passwordController = TextEditingController();
  String? _error;
  bool _submitting = false;

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
                    'Enter your password to unlock this device.',
                    style: Theme.of(context).textTheme.bodyMedium,
                    textAlign: TextAlign.center,
                  ),
                  const SizedBox(height: 24),
                  TextField(
                    controller: _passwordController,
                    decoration: const InputDecoration(labelText: 'Password'),
                    obscureText: true,
                    autofocus: true,
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
