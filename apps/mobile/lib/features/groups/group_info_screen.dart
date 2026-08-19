import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../api/api_client.dart';
import '../../api/dtos.dart';
import '../../app/providers.dart';
import '../../shared/widgets/error_state.dart';
import '../auth/auth_controller.dart';
import '../auth/auth_state.dart';

class GroupInfoScreen extends ConsumerStatefulWidget {
  const GroupInfoScreen({super.key, required this.groupId});
  final String groupId;

  @override
  ConsumerState<GroupInfoScreen> createState() => _GroupInfoScreenState();
}

class _GroupInfoScreenState extends ConsumerState<GroupInfoScreen> {
  GroupSummary? _group;
  String? _error;
  bool _loading = true;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() { _loading = true; _error = null; });
    try {
      final group = await ref.read(groupsApiProvider).get(widget.groupId);
      if (mounted) setState(() => _group = group);
    } on ApiException catch (e) {
      if (mounted) setState(() => _error = e.message);
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  bool get _isAdmin {
    final authState = ref.read(authControllerProvider);
    final myId = authState is AuthSignedIn ? authState.profile.id : null;
    final group = _group;
    if (group == null || myId == null) return false;
    return group.members.any((m) => m.userId == myId && m.role == 'admin');
  }

  Future<void> _addMember() async {
    final username = await showDialog<String>(
      context: context,
      builder: (context) {
        final controller = TextEditingController();
        return AlertDialog(
          title: const Text('Add member'),
          content: TextField(controller: controller, decoration: const InputDecoration(labelText: 'Username'), autofocus: true),
          actions: [
            TextButton(onPressed: () => Navigator.of(context).pop(), child: const Text('Cancel')),
            FilledButton(onPressed: () => Navigator.of(context).pop(controller.text), child: const Text('Add')),
          ],
        );
      },
    );
    if (username == null || username.trim().isEmpty) return;
    try {
      await ref.read(groupsApiProvider).addMember(widget.groupId, username.trim());
      await _load();
    } on ApiException catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(e.message)));
    }
  }

  /// `PATCH /api/groups/:id` and its `onlyAdminsCanMessage` field already existed
  /// server-side (server/modules/groups/service.ts's `updateGroup`) — there was
  /// just no toggle anywhere in either client to flip it (docs/13-roadmap.md's
  /// Groups "Remaining" note). `GroupsApi.update` already supports this exact
  /// param; this just wires it to a switch.
  Future<void> _toggleOnlyAdminsCanMessage(bool value) async {
    try {
      final updated = await ref.read(groupsApiProvider).update(widget.groupId, onlyAdminsCanMessage: value);
      if (mounted) setState(() => _group = updated);
    } on ApiException catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(e.message)));
    }
  }

  Future<void> _removeMember(GroupMemberDto member) async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: Text('Remove ${member.displayName}?'),
        content: const Text('They will no longer be able to see new messages in this group.'),
        actions: [
          TextButton(onPressed: () => Navigator.of(context).pop(false), child: const Text('Cancel')),
          FilledButton(
            style: FilledButton.styleFrom(backgroundColor: Theme.of(context).colorScheme.error),
            onPressed: () => Navigator.of(context).pop(true),
            child: const Text('Remove'),
          ),
        ],
      ),
    );
    if (confirmed != true) return;
    try {
      await ref.read(groupsApiProvider).removeMember(widget.groupId, member.userId);
      await _load();
    } on ApiException catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(e.message)));
    }
  }

  @override
  Widget build(BuildContext context) {
    final group = _group;
    return Scaffold(
      appBar: AppBar(title: Text(group?.name ?? 'Group info')),
      // Once a group has loaded once, a later refresh (after adding/removing a
      // member) never tears the whole screen down over a transient failure —
      // same "don't replace a working view with an error state" rule applied
      // to chats_list_screen.dart's own _load. Only the very first load, before
      // anything has rendered yet, shows the spinner/error in place of content.
      body: group != null
          ? ListView(
              children: [
                Padding(
                  padding: const EdgeInsets.all(16),
                  child: Column(
                    children: [
                      CircleAvatar(radius: 40, child: Text(group.name.isNotEmpty ? group.name[0].toUpperCase() : '?', style: const TextStyle(fontSize: 28))),
                      const SizedBox(height: 12),
                      Text(group.name, style: Theme.of(context).textTheme.titleLarge),
                      if (group.description != null && group.description!.isNotEmpty) ...[
                        const SizedBox(height: 4),
                        Text(group.description!, textAlign: TextAlign.center),
                      ],
                    ],
                  ),
                ),
                if (_isAdmin) ...[
                  const Divider(),
                  SwitchListTile(
                    title: const Text('Only admins can message'),
                    subtitle: const Text('Other members can still read, react, and call.'),
                    value: group.onlyAdminsCanMessage,
                    onChanged: (v) => _toggleOnlyAdminsCanMessage(v),
                  ),
                ],
                const Divider(),
                Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
                  child: Row(
                    mainAxisAlignment: MainAxisAlignment.spaceBetween,
                    children: [
                      Text('${group.members.length} members', style: Theme.of(context).textTheme.titleSmall),
                      TextButton.icon(onPressed: _addMember, icon: const Icon(Icons.person_add), label: const Text('Add')),
                    ],
                  ),
                ),
                ...group.members.map(
                  (m) => ListTile(
                    leading: const CircleAvatar(child: Icon(Icons.person)),
                    title: Text(m.displayName),
                    subtitle: Text('@${m.username}${m.role == 'admin' ? ' · Admin' : ''}'),
                    trailing: _isAdmin && m.role != 'admin'
                        ? IconButton(icon: const Icon(Icons.remove_circle_outline), onPressed: () => _removeMember(m))
                        : null,
                  ),
                ),
              ],
            )
          : (_loading
              ? const Center(child: CircularProgressIndicator())
              : ErrorState(message: _error ?? 'Could not load this group.', onRetry: _load)),
    );
  }
}
