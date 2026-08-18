/// Lists every device linked to this account and lets the user revoke any of
/// them — the mobile counterpart to `apps/web`'s devices settings page. Revoking
/// this device itself signs it out immediately (mirrors
/// server/modules/devices/service.ts's `revokeDevice`: it kills the session too),
/// so that case routes back through logout rather than just refreshing the list.
library;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../api/api_client.dart';
import '../../api/dtos.dart';
import '../../app/providers.dart';
import '../../crypto/kek_holder.dart';
import '../../shared/widgets/error_state.dart';
import '../auth/auth_controller.dart';
import '../auth/biometric_unlock.dart' as biometric;

class DevicesScreen extends ConsumerStatefulWidget {
  const DevicesScreen({super.key});
  @override
  ConsumerState<DevicesScreen> createState() => _DevicesScreenState();
}

class _DevicesScreenState extends ConsumerState<DevicesScreen> {
  List<DeviceSummary>? _devices;
  String? _error;

  bool _biometricChecked = false;
  bool _biometricSupported = false;
  bool _biometricEnabled = false;
  bool _biometricBusy = false;
  String? _biometricError;

  @override
  void initState() {
    super.initState();
    _load();
    _loadBiometricState();
  }

  Future<void> _loadBiometricState() async {
    try {
      final supported = await biometric.isBiometricAvailable();
      final enabled = supported && await biometric.isBiometricUnlockEnabled();
      if (mounted) {
        setState(() {
          _biometricSupported = supported;
          _biometricEnabled = enabled;
        });
      }
    } catch (_) {
      // Fail closed, mirroring biometric_unlock.dart — worst case the card stays
      // hidden, never a crash on this screen.
    } finally {
      if (mounted) setState(() => _biometricChecked = true);
    }
  }

  Future<void> _toggleBiometric() async {
    setState(() {
      _biometricError = null;
      _biometricBusy = true;
    });
    try {
      if (_biometricEnabled) {
        await biometric.disableBiometricUnlock();
        if (mounted) setState(() => _biometricEnabled = false);
        return;
      }
      final kek = getCurrentKek();
      if (kek == null) {
        // Can't happen from a normal navigation (reaching this screen requires an
        // already-unlocked device), but this handler makes no assumption about how
        // it was reached, so it checks rather than assumes.
        setState(() => _biometricError = 'Unlock this device with your password first, then try again.');
        return;
      }
      final ok = await biometric.enableBiometricUnlock(kek);
      if (!ok) {
        setState(() => _biometricError = "This device couldn't confirm biometrics — nothing was changed.");
        return;
      }
      if (mounted) setState(() => _biometricEnabled = true);
    } finally {
      if (mounted) setState(() => _biometricBusy = false);
    }
  }

  Future<void> _load() async {
    try {
      final devices = await ref.read(devicesApiProvider).list();
      if (mounted) setState(() => _devices = devices);
    } on ApiException catch (e) {
      if (mounted) setState(() => _error = e.message);
    }
  }

  Future<void> _revoke(DeviceSummary device) async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: Text('Sign out ${device.name}?'),
        content: Text(
          device.isCurrentDevice
              ? 'This is the device you\'re using right now — you\'ll be signed out immediately.'
              : 'This device will need to sign in again to access your account.',
        ),
        actions: [
          TextButton(onPressed: () => Navigator.of(context).pop(false), child: const Text('Cancel')),
          FilledButton(
            style: FilledButton.styleFrom(backgroundColor: Theme.of(context).colorScheme.error),
            onPressed: () => Navigator.of(context).pop(true),
            child: const Text('Sign out'),
          ),
        ],
      ),
    );
    if (confirmed != true) return;

    try {
      await ref.read(devicesApiProvider).revoke(device.id);
      if (device.isCurrentDevice) {
        await ref.read(authControllerProvider.notifier).logout();
        return;
      }
      await _load();
    } on ApiException catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(e.message)));
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Devices')),
      body: _buildBody(),
    );
  }

  /// The enrollment half of biometric unlock — unlock_screen.dart is the *use*
  /// half. Lives here specifically because it's a per-device setting: the wrap key
  /// and wrapped KEK this creates only ever exist in this one phone's Keychain/
  /// Keystore (see features/auth/biometric_unlock.dart) — there's no server-side
  /// toggle, nothing to reflect on the other rows in this same list. Renders
  /// nothing at all (not a disabled control — an absent one) until the capability
  /// check confirms this device can actually do this.
  Widget? _buildBiometricCard(BuildContext context) {
    if (!_biometricChecked || !_biometricSupported) return null;
    return Card(
      margin: const EdgeInsets.fromLTRB(16, 16, 16, 0),
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Row(
              children: [
                CircleAvatar(
                  backgroundColor: Theme.of(context).colorScheme.primaryContainer,
                  child: Icon(Icons.fingerprint, color: Theme.of(context).colorScheme.primary),
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      const Text('Biometric unlock', style: TextStyle(fontWeight: FontWeight.w600)),
                      const SizedBox(height: 2),
                      Text(
                        'Use Face ID, Touch ID, or fingerprint instead of your password to unlock Comm on this '
                        'device. Your account password is never replaced — it\'s still needed on a new device or '
                        'if this stops working.',
                        style: Theme.of(context).textTheme.bodySmall,
                      ),
                    ],
                  ),
                ),
                const SizedBox(width: 8),
                FilledButton.tonal(
                  onPressed: _biometricBusy ? null : _toggleBiometric,
                  child: _biometricBusy
                      ? const SizedBox(width: 16, height: 16, child: CircularProgressIndicator(strokeWidth: 2))
                      : Text(_biometricEnabled ? 'Turn off' : 'Turn on'),
                ),
              ],
            ),
            if (_biometricError != null) ...[
              const SizedBox(height: 8),
              Text(_biometricError!, style: TextStyle(color: Theme.of(context).colorScheme.error, fontSize: 12)),
            ],
          ],
        ),
      ),
    );
  }

  Widget _buildBody() {
    if (_error != null) return ErrorState(message: _error!, onRetry: _load);
    final devices = _devices;
    if (devices == null) return const Center(child: CircularProgressIndicator());

    final biometricCard = _buildBiometricCard(context);

    return RefreshIndicator(
      onRefresh: () => Future.wait([_load(), _loadBiometricState()]),
      child: ListView(
        children: [
          if (biometricCard != null) ...[biometricCard, const SizedBox(height: 8)],
          for (var i = 0; i < devices.length; i++) ...[
            if (i > 0) const Divider(height: 1),
            ListTile(
              leading: Icon(devices[i].deviceType == 'android' ? Icons.phone_android : Icons.devices),
              title: Row(
                children: [
                  Flexible(child: Text(devices[i].name, overflow: TextOverflow.ellipsis)),
                  if (devices[i].isCurrentDevice) ...[
                    const SizedBox(width: 8),
                    Chip(label: const Text('This device', style: TextStyle(fontSize: 11)), visualDensity: VisualDensity.compact),
                  ],
                ],
              ),
              subtitle: Text('Last active ${_relativeTime(devices[i].lastActiveAt)}'),
              trailing: IconButton(icon: const Icon(Icons.logout), onPressed: () => _revoke(devices[i])),
            ),
          ],
        ],
      ),
    );
  }
}

String _relativeTime(String iso) {
  final time = DateTime.tryParse(iso);
  if (time == null) return iso;
  final diff = DateTime.now().toUtc().difference(time.toUtc());
  if (diff.inMinutes < 1) return 'just now';
  if (diff.inMinutes < 60) return '${diff.inMinutes}m ago';
  if (diff.inHours < 24) return '${diff.inHours}h ago';
  return '${diff.inDays}d ago';
}
