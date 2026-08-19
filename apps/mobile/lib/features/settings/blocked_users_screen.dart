/// Blocked users management (docs/13-roadmap.md) — mobile counterpart to
/// apps/web's blocked/page.tsx + components/blocked-users-list.tsx.
library;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../api/api_client.dart';
import '../../api/dtos.dart';
import '../../app/providers.dart';
import '../../shared/widgets/error_state.dart';

class BlockedUsersScreen extends ConsumerStatefulWidget {
  const BlockedUsersScreen({super.key});
  @override
  ConsumerState<BlockedUsersScreen> createState() => _BlockedUsersScreenState();
}

class _BlockedUsersScreenState extends ConsumerState<BlockedUsersScreen> {
  List<BlockedUserDto>? _blocked;
  String? _error;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      final list = await ref.read(blockingApiProvider).list();
      if (mounted) setState(() => _blocked = list);
    } on ApiException catch (e) {
      if (mounted && _blocked == null) setState(() => _error = e.message);
    }
  }

  Future<void> _unblock(BlockedUserDto row) async {
    final previous = _blocked;
    setState(
      () => _blocked = _blocked?.where((b) => b.userId != row.userId).toList(),
    );
    try {
      await ref.read(blockingApiProvider).unblock(row.userId);
    } on ApiException catch (e) {
      if (mounted) {
        setState(() => _blocked = previous);
        ScaffoldMessenger.of(
          context,
        ).showSnackBar(SnackBar(content: Text(e.message)));
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Blocked users')),
      body: _buildBody(),
    );
  }

  Widget _buildBody() {
    if (_error != null) return ErrorState(message: _error!, onRetry: _load);
    final blocked = _blocked;
    if (blocked == null) {
      return const Center(child: CircularProgressIndicator());
    }
    if (blocked.isEmpty) {
      return const EmptyState(
        icon: Icons.block,
        message: "You haven't blocked anyone.",
      );
    }
    return ListView.separated(
      itemCount: blocked.length,
      separatorBuilder: (context, index) => const Divider(height: 1),
      itemBuilder: (context, index) {
        final row = blocked[index];
        return ListTile(
          leading: CircleAvatar(
            child: Text(
              row.displayName.isNotEmpty
                  ? row.displayName[0].toUpperCase()
                  : '?',
            ),
          ),
          title: Text(row.displayName),
          subtitle: Text('@${row.username}'),
          trailing: TextButton(
            onPressed: () => _unblock(row),
            child: const Text('Unblock'),
          ),
        );
      },
    );
  }
}
