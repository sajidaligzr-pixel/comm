import 'package:flutter/material.dart';
import 'package:flutter/services.dart' show Clipboard, ClipboardData;
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:image_picker/image_picker.dart';

import '../../api/api_client.dart';
import '../../api/app_config.dart';
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
  bool _avatarBusy = false;
  GroupInviteLinkDto? _inviteLink;
  bool _inviteBusy = false;

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

  /// Mirrors thread_screen.dart's `_pickAndSendPhoto` — pick from the gallery,
  /// read the raw bytes, hand them to `GroupsApi.uploadAvatar` (server/modules/
  /// groups/service.ts's "Group avatar" section — a plain, unencrypted upload,
  /// unlike message media).
  Future<void> _pickAvatar() async {
    final picked = await ImagePicker().pickImage(
      source: ImageSource.gallery,
      imageQuality: 90,
    );
    if (picked == null) return;
    final bytes = await picked.readAsBytes();
    setState(() => _avatarBusy = true);
    try {
      final updated = await ref
          .read(groupsApiProvider)
          .uploadAvatar(widget.groupId, bytes);
      if (mounted) setState(() => _group = updated);
    } on ApiException catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(e.message)));
    } finally {
      if (mounted) setState(() => _avatarBusy = false);
    }
  }

  Future<void> _getInviteLink() async {
    setState(() => _inviteBusy = true);
    try {
      final link = await ref.read(groupsApiProvider).getInviteLink(widget.groupId);
      if (mounted) setState(() => _inviteLink = link);
    } on ApiException catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(e.message)));
    } finally {
      if (mounted) setState(() => _inviteBusy = false);
    }
  }

  Future<void> _resetInviteLink() async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Reset invite link?'),
        content: const Text('The current link will stop working.'),
        actions: [
          TextButton(onPressed: () => Navigator.of(context).pop(false), child: const Text('Cancel')),
          FilledButton(onPressed: () => Navigator.of(context).pop(true), child: const Text('Reset')),
        ],
      ),
    );
    if (confirmed != true) return;
    setState(() => _inviteBusy = true);
    try {
      final link = await ref.read(groupsApiProvider).resetInviteLink(widget.groupId);
      if (mounted) setState(() => _inviteLink = link);
    } on ApiException catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(e.message)));
    } finally {
      if (mounted) setState(() => _inviteBusy = false);
    }
  }

  String _inviteUrl(GroupInviteLinkDto link) => '${AppConfig.apiBaseUrl}/join-group/${link.token}';

  void _copyInviteLink(GroupInviteLinkDto link) {
    Clipboard.setData(ClipboardData(text: _inviteUrl(link)));
    ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Invite link copied')));
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

  Future<void> _setMemberRole(GroupMemberDto member, String role) async {
    try {
      final updated = await ref
          .read(groupsApiProvider)
          .setMemberRole(widget.groupId, member.userId, role);
      if (mounted) setState(() => _group = updated);
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
                      Stack(
                        children: [
                          CircleAvatar(
                            radius: 40,
                            backgroundImage: group.avatarUrl != null
                                ? NetworkImage(group.avatarUrl!)
                                : null,
                            child: group.avatarUrl == null
                                ? Text(
                                    group.name.isNotEmpty ? group.name[0].toUpperCase() : '?',
                                    style: const TextStyle(fontSize: 28),
                                  )
                                : null,
                          ),
                          if (_isAdmin)
                            Positioned(
                              bottom: 0,
                              right: 0,
                              child: InkWell(
                                onTap: _avatarBusy ? null : _pickAvatar,
                                customBorder: const CircleBorder(),
                                child: CircleAvatar(
                                  radius: 12,
                                  backgroundColor: Theme.of(context).colorScheme.primary,
                                  child: _avatarBusy
                                      ? const SizedBox(
                                          width: 12,
                                          height: 12,
                                          child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white),
                                        )
                                      : const Icon(Icons.camera_alt, size: 13, color: Colors.white),
                                ),
                              ),
                            ),
                        ],
                      ),
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
                  const Divider(),
                  ListTile(
                    title: const Text('Invite via link'),
                    subtitle: _inviteLink == null
                        ? const Text('Share a link so anyone can join this group.')
                        : Text(_inviteUrl(_inviteLink!), maxLines: 1, overflow: TextOverflow.ellipsis),
                    trailing: _inviteBusy
                        ? const SizedBox(width: 20, height: 20, child: CircularProgressIndicator(strokeWidth: 2))
                        : _inviteLink == null
                            ? TextButton(onPressed: _getInviteLink, child: const Text('Get link'))
                            : Row(
                                mainAxisSize: MainAxisSize.min,
                                children: [
                                  IconButton(
                                    icon: const Icon(Icons.copy, size: 20),
                                    tooltip: 'Copy link',
                                    onPressed: () => _copyInviteLink(_inviteLink!),
                                  ),
                                  IconButton(
                                    icon: const Icon(Icons.refresh, size: 20),
                                    tooltip: 'Reset link',
                                    onPressed: _resetInviteLink,
                                  ),
                                ],
                              ),
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
                ...(() {
                  final adminCount = group.members.where((m) => m.role == 'admin').length;
                  return group.members.map(
                    (m) => ListTile(
                      leading: const CircleAvatar(child: Icon(Icons.person)),
                      title: Text(m.displayName),
                      subtitle: Text('@${m.username}${m.role == 'admin' ? ' · Admin' : ''}'),
                      trailing: !_isAdmin
                          ? null
                          : Row(
                              mainAxisSize: MainAxisSize.min,
                              children: [
                                if (m.role == 'member')
                                  TextButton(
                                    onPressed: () => _setMemberRole(m, 'admin'),
                                    child: const Text('Make admin'),
                                  ),
                                // Hidden, not just disabled, for the group's last
                                // remaining admin — see setMemberRole's own
                                // docstring on why demoting them is rejected.
                                if (m.role == 'admin' && adminCount > 1)
                                  TextButton(
                                    onPressed: () => _setMemberRole(m, 'member'),
                                    child: const Text('Remove admin'),
                                  ),
                                if (m.role != 'admin')
                                  IconButton(
                                    icon: const Icon(Icons.remove_circle_outline),
                                    onPressed: () => _removeMember(m),
                                  ),
                              ],
                            ),
                    ),
                  );
                })(),
              ],
            )
          : (_loading
              ? const Center(child: CircularProgressIndicator())
              : ErrorState(message: _error ?? 'Could not load this group.', onRetry: _load)),
    );
  }
}
