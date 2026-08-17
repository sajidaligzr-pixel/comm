import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../api/api_client.dart';
import '../../app/providers.dart';
import 'auth_controller.dart';

class ChangePasswordScreen extends ConsumerStatefulWidget {
  const ChangePasswordScreen({super.key});
  @override
  ConsumerState<ChangePasswordScreen> createState() => _ChangePasswordScreenState();
}

class _ChangePasswordScreenState extends ConsumerState<ChangePasswordScreen> {
  final _currentController = TextEditingController();
  final _newController = TextEditingController();
  String? _error;
  bool _submitting = false;

  @override
  void dispose() {
    _currentController.dispose();
    _newController.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    if (_newController.text.length < 12) {
      setState(() => _error = 'New password must be at least 12 characters.');
      return;
    }
    setState(() {
      _error = null;
      _submitting = true;
    });
    try {
      await ref.read(authApiProvider).changePassword(currentPassword: _currentController.text, newPassword: _newController.text);
      await ref.read(authControllerProvider.notifier).markPasswordChanged();
    } on ApiException catch (e) {
      setState(() => _error = e.message);
    } finally {
      if (mounted) setState(() => _submitting = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Set a new password')),
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
                  const Text('Your account requires a new password before continuing.'),
                  const SizedBox(height: 16),
                  TextField(
                    controller: _currentController,
                    decoration: const InputDecoration(labelText: 'Current password'),
                    obscureText: true,
                    enabled: !_submitting,
                  ),
                  const SizedBox(height: 16),
                  TextField(
                    controller: _newController,
                    decoration: const InputDecoration(labelText: 'New password'),
                    obscureText: true,
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
                        : const Text('Update password'),
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}
