import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:package_info_plus/package_info_plus.dart';

import '../../api/api_client.dart';
import '../../storage/prefs.dart';
import 'auth_controller.dart';

class LoginScreen extends ConsumerStatefulWidget {
  const LoginScreen({super.key});
  @override
  ConsumerState<LoginScreen> createState() => _LoginScreenState();
}

class _LoginScreenState extends ConsumerState<LoginScreen> {
  final _usernameController = TextEditingController();
  final _passwordController = TextEditingController();
  String? _error;
  bool _submitting = false;
  // New-device login approval (docs/07-auth-architecture.md's device-approval
  // section) — set the instant login() reports pending_approval; _cancelled is
  // checked between poll retries so "Cancel" below can stop the wait without a
  // separate cancellation-token type.
  bool _waitingForApproval = false;
  bool _cancelled = false;
  // Surfaced here (a screen reachable pre-login, no digging through phone
  // Settings needed — Android's own App Info page only ever shows
  // versionName, which has stayed "1.0.0" across every build so far, not the
  // buildNumber that actually distinguishes releases) after a live update-loop
  // report was hard to diagnose with no way for the user to just read off
  // which build had actually landed.
  String? _buildLabel;

  @override
  void initState() {
    super.initState();
    getRememberedUsername().then((remembered) {
      if (remembered != null && mounted) _usernameController.text = remembered;
    });
    PackageInfo.fromPlatform().then((info) {
      if (mounted) setState(() => _buildLabel = 'v${info.version} (${info.buildNumber})');
    });
  }

  @override
  void dispose() {
    _usernameController.dispose();
    _passwordController.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    final username = _usernameController.text.trim();
    final password = _passwordController.text;
    if (username.isEmpty || password.isEmpty) {
      setState(() => _error = 'Enter a username and password.');
      return;
    }

    setState(() {
      _error = null;
      _submitting = true;
      _waitingForApproval = false;
      _cancelled = false;
    });
    try {
      await ref
          .read(authControllerProvider.notifier)
          .login(
            username,
            password,
            onPendingApproval: (_) {
              if (mounted) setState(() => _waitingForApproval = true);
            },
            isCancelled: () => _cancelled,
          );
      // Navigation happens automatically via routerProvider's redirect reacting to
      // the new AuthState — nothing to push here.
    } on ApiException catch (e) {
      setState(() => _error = e.message);
    } catch (e) {
      setState(() => _error = 'Something went wrong. Please try again.');
    } finally {
      if (mounted) {
        setState(() {
          _submitting = false;
          _waitingForApproval = false;
        });
      }
    }
  }

  void _cancelApproval() {
    setState(() {
      _cancelled = true;
      _waitingForApproval = false;
      _submitting = false;
    });
  }

  @override
  Widget build(BuildContext context) {
    if (_waitingForApproval) {
      // New-device login approval (docs/07-auth-architecture.md) — this device
      // sent its credentials but can't finish signing in until an
      // already-signed-in device approves it from its own Devices screen.
      return Scaffold(
        body: SafeArea(
          child: Center(
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 400),
              child: Padding(
                padding: const EdgeInsets.all(24),
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    const CircularProgressIndicator(),
                    const SizedBox(height: 24),
                    Text(
                      'Check your other device — approve this sign-in from its Devices screen to continue.',
                      textAlign: TextAlign.center,
                      style: Theme.of(context).textTheme.bodyMedium,
                    ),
                    const SizedBox(height: 8),
                    Text(
                      'This request expires in a few minutes if nobody responds.',
                      textAlign: TextAlign.center,
                      style: Theme.of(context).textTheme.bodySmall?.copyWith(
                        color: Theme.of(context).colorScheme.onSurfaceVariant,
                      ),
                    ),
                    const SizedBox(height: 24),
                    OutlinedButton(onPressed: _cancelApproval, child: const Text('Cancel')),
                  ],
                ),
              ),
            ),
          ),
        ),
      );
    }

    return Scaffold(
      body: SafeArea(
        child: Center(
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 400),
            child: SingleChildScrollView(
              padding: const EdgeInsets.all(24),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  Icon(Icons.forum_rounded, size: 56, color: Theme.of(context).colorScheme.primary),
                  const SizedBox(height: 12),
                  Text('Comm', style: Theme.of(context).textTheme.headlineMedium, textAlign: TextAlign.center),
                  const SizedBox(height: 32),
                  TextField(
                    controller: _usernameController,
                    decoration: const InputDecoration(labelText: 'Username'),
                    autocorrect: false,
                    textInputAction: TextInputAction.next,
                    enabled: !_submitting,
                  ),
                  const SizedBox(height: 16),
                  TextField(
                    controller: _passwordController,
                    decoration: const InputDecoration(labelText: 'Password'),
                    obscureText: true,
                    textInputAction: TextInputAction.done,
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
                        : const Text('Sign in'),
                  ),
                  if (_buildLabel != null) ...[
                    const SizedBox(height: 24),
                    Text(
                      _buildLabel!,
                      textAlign: TextAlign.center,
                      style: Theme.of(
                        context,
                      ).textTheme.bodySmall?.copyWith(color: Theme.of(context).colorScheme.onSurfaceVariant),
                    ),
                  ],
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}
