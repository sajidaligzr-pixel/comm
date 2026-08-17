import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../api/api_client.dart';
import '../../app/providers.dart';

class NewGroupScreen extends ConsumerStatefulWidget {
  const NewGroupScreen({super.key});
  @override
  ConsumerState<NewGroupScreen> createState() => _NewGroupScreenState();
}

class _NewGroupScreenState extends ConsumerState<NewGroupScreen> {
  final _nameController = TextEditingController();
  final _usernameController = TextEditingController();
  final Set<String> _members = {};
  String? _error;
  bool _creating = false;
  bool _resolving = false;

  @override
  void dispose() {
    _nameController.dispose();
    _usernameController.dispose();
    super.dispose();
  }

  Future<void> _addMember() async {
    final username = _usernameController.text.trim().toLowerCase();
    if (username.isEmpty) return;
    setState(() {
      _resolving = true;
      _error = null;
    });
    try {
      final profile = await ref.read(usersApiProvider).byUsername(username);
      if (profile == null) {
        setState(() => _error = 'No user found with that username.');
      } else {
        setState(() {
          _members.add(profile.username);
          _usernameController.clear();
        });
      }
    } on ApiException catch (e) {
      setState(() => _error = e.message);
    } finally {
      if (mounted) setState(() => _resolving = false);
    }
  }

  Future<void> _create() async {
    final name = _nameController.text.trim();
    if (name.isEmpty) {
      setState(() => _error = 'Group name is required.');
      return;
    }
    if (_members.isEmpty) {
      setState(() => _error = 'Add at least one other member.');
      return;
    }

    setState(() {
      _creating = true;
      _error = null;
    });
    try {
      final group = await ref.read(groupsApiProvider).create(name, _members.toList());
      if (mounted) context.pushReplacement('/chats/${group.conversationId}');
    } on ApiException catch (e) {
      setState(() => _error = e.message);
    } finally {
      if (mounted) setState(() => _creating = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('New group'),
        actions: [
          TextButton(
            onPressed: _creating ? null : _create,
            child: _creating ? const SizedBox(width: 16, height: 16, child: CircularProgressIndicator(strokeWidth: 2)) : const Text('Create'),
          ),
        ],
      ),
      body: SafeArea(
        child: Padding(
          padding: const EdgeInsets.all(16),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              TextField(controller: _nameController, decoration: const InputDecoration(labelText: 'Group name')),
              const SizedBox(height: 16),
              Row(
                children: [
                  Expanded(
                    child: TextField(
                      controller: _usernameController,
                      decoration: const InputDecoration(labelText: 'Add member by username'),
                      autocorrect: false,
                      onSubmitted: (_) => _addMember(),
                    ),
                  ),
                  const SizedBox(width: 8),
                  IconButton.filled(onPressed: _resolving ? null : _addMember, icon: const Icon(Icons.add)),
                ],
              ),
              if (_error != null) ...[
                const SizedBox(height: 8),
                Text(_error!, style: TextStyle(color: Theme.of(context).colorScheme.error)),
              ],
              const SizedBox(height: 16),
              Expanded(
                child: _members.isEmpty
                    ? const Center(child: Text('No members added yet'))
                    : ListView(
                        children: _members
                            .map((m) => ListTile(
                                  leading: const Icon(Icons.person),
                                  title: Text('@$m'),
                                  trailing: IconButton(icon: const Icon(Icons.close), onPressed: () => setState(() => _members.remove(m))),
                                ))
                            .toList(),
                      ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
