import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../api/api_client.dart';
import '../../api/dtos.dart';
import '../../app/providers.dart';
import 'auth_controller.dart';

class InviteRedeemScreen extends ConsumerStatefulWidget {
  const InviteRedeemScreen({super.key, required this.token});
  final String token;

  @override
  ConsumerState<InviteRedeemScreen> createState() => _InviteRedeemScreenState();
}

class _InviteRedeemScreenState extends ConsumerState<InviteRedeemScreen> {
  final _passwordController = TextEditingController();
  final _confirmController = TextEditingController();
  String? _error;
  bool _submitting = false;
  InviteInfoResponse? _info;
  bool _loadingInfo = true;

  @override
  void initState() {
    super.initState();
    _loadInfo();
  }

  Future<void> _loadInfo() async {
    try {
      final info = await ref.read(authApiProvider).getInviteInfo(widget.token);
      if (mounted) setState(() => _info = info);
    } on ApiException catch (e) {
      if (mounted) setState(() => _error = e.message);
    } finally {
      if (mounted) setState(() => _loadingInfo = false);
    }
  }

  @override
  void dispose() {
    _passwordController.dispose();
    _confirmController.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    final password = _passwordController.text;
    if (password.length < 12) {
      setState(() => _error = 'Password must be at least 12 characters.');
      return;
    }
    if (password != _confirmController.text) {
      setState(() => _error = 'Passwords do not match.');
      return;
    }

    setState(() {
      _error = null;
      _submitting = true;
    });
    try {
      await ref.read(authControllerProvider.notifier).redeemInvite(widget.token, password);
    } on ApiException catch (e) {
      setState(() => _error = e.message);
    } finally {
      if (mounted) setState(() => _submitting = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    if (_loadingInfo) {
      return const Scaffold(body: Center(child: CircularProgressIndicator()));
    }
    if (_info == null) {
      return Scaffold(
        body: Center(
          child: Padding(
            padding: const EdgeInsets.all(24),
            child: Text(_error ?? 'This invite link is invalid or has expired.', textAlign: TextAlign.center),
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
                  Text('Welcome, ${_info!.displayName}', style: Theme.of(context).textTheme.headlineSmall, textAlign: TextAlign.center),
                  const SizedBox(height: 4),
                  Text('@${_info!.username}', style: Theme.of(context).textTheme.bodyMedium, textAlign: TextAlign.center),
                  const SizedBox(height: 24),
                  Text('Choose a password to finish setting up your account and this device.'),
                  const SizedBox(height: 16),
                  TextField(
                    controller: _passwordController,
                    decoration: const InputDecoration(labelText: 'Password'),
                    obscureText: true,
                    enabled: !_submitting,
                  ),
                  const SizedBox(height: 16),
                  TextField(
                    controller: _confirmController,
                    decoration: const InputDecoration(labelText: 'Confirm password'),
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
                        : const Text('Create account'),
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
