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
import '../auth/auth_controller.dart';

class DevicesScreen extends ConsumerStatefulWidget {
  const DevicesScreen({super.key});
  @override
  ConsumerState<DevicesScreen> createState() => _DevicesScreenState();
}

class _DevicesScreenState extends ConsumerState<DevicesScreen> {
  List<DeviceSummary>? _devices;
  String? _error;

  @override
  void initState() {
    super.initState();
    _load();
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

  Widget _buildBody() {
    if (_error != null) return Center(child: Text(_error!));
    final devices = _devices;
    if (devices == null) return const Center(child: CircularProgressIndicator());

    return RefreshIndicator(
      onRefresh: _load,
      child: ListView.separated(
        itemCount: devices.length,
        separatorBuilder: (_, _) => const Divider(height: 1),
        itemBuilder: (context, index) {
          final d = devices[index];
          return ListTile(
            leading: Icon(d.deviceType == 'android' ? Icons.phone_android : Icons.devices),
            title: Row(
              children: [
                Flexible(child: Text(d.name, overflow: TextOverflow.ellipsis)),
                if (d.isCurrentDevice) ...[
                  const SizedBox(width: 8),
                  Chip(label: const Text('This device', style: TextStyle(fontSize: 11)), visualDensity: VisualDensity.compact),
                ],
              ],
            ),
            subtitle: Text('Last active ${_relativeTime(d.lastActiveAt)}'),
            trailing: IconButton(icon: const Icon(Icons.logout), onPressed: () => _revoke(d)),
          );
        },
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
