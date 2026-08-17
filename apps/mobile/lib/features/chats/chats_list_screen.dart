import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../api/api_client.dart';
import '../../api/dtos.dart';
import '../../app/providers.dart';
import '../auth/auth_controller.dart';
import '../auth/auth_state.dart';

class ChatsListScreen extends ConsumerStatefulWidget {
  const ChatsListScreen({super.key});
  @override
  ConsumerState<ChatsListScreen> createState() => _ChatsListScreenState();
}

class _ChatsListScreenState extends ConsumerState<ChatsListScreen> {
  List<ConversationSummary>? _conversations;
  String? _error;

  @override
  void initState() {
    super.initState();
    _load();
    final realtime = ref.read(realtimeClientProvider);
    realtime.connect();
    realtime.on('new', _onRealtimeMessage);
  }

  @override
  void dispose() {
    ref.read(realtimeClientProvider).off('new', _onRealtimeMessage);
    super.dispose();
  }

  void _onRealtimeMessage(Map<String, dynamic> _) => _load();

  Future<void> _load() async {
    try {
      final list = await ref.read(conversationsApiProvider).list();
      if (mounted) setState(() => _conversations = list);
    } on ApiException catch (e) {
      if (mounted) setState(() => _error = e.message);
    }
  }

  Future<void> _startNewChat() async {
    final username = await showDialog<String>(
      context: context,
      builder: (context) {
        final controller = TextEditingController();
        return AlertDialog(
          title: const Text('Message someone'),
          content: TextField(
            controller: controller,
            decoration: const InputDecoration(labelText: 'Username'),
            autofocus: true,
            autocorrect: false,
            onSubmitted: (v) => Navigator.of(context).pop(v),
          ),
          actions: [
            TextButton(onPressed: () => Navigator.of(context).pop(), child: const Text('Cancel')),
            FilledButton(onPressed: () => Navigator.of(context).pop(controller.text), child: const Text('Start chat')),
          ],
        );
      },
    );
    if (username == null || username.trim().isEmpty || !mounted) return;

    try {
      final conversation = await ref.read(conversationsApiProvider).createOrGetDirect(username.trim());
      if (mounted) context.push('/chats/${conversation.id}');
    } on ApiException catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(e.message)));
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final authState = ref.watch(authControllerProvider);
    final profile = authState is AuthSignedIn ? authState.profile : null;

    return Scaffold(
      appBar: AppBar(
        title: Text(profile != null ? 'Chats — @${profile.username}' : 'Chats'),
        actions: [
          IconButton(
            icon: const Icon(Icons.logout),
            tooltip: 'Sign out',
            onPressed: () => ref.read(authControllerProvider.notifier).logout(),
          ),
        ],
      ),
      body: _buildBody(),
      floatingActionButton: FloatingActionButton(onPressed: _startNewChat, child: const Icon(Icons.add_comment)),
    );
  }

  Widget _buildBody() {
    if (_error != null) {
      return Center(child: Text(_error!));
    }
    final conversations = _conversations;
    if (conversations == null) {
      return const Center(child: CircularProgressIndicator());
    }
    if (conversations.isEmpty) {
      return const Center(child: Text('No conversations yet — tap the compose button to message someone.'));
    }
    return RefreshIndicator(
      onRefresh: _load,
      child: ListView.separated(
        itemCount: conversations.length,
        separatorBuilder: (_, _) => const Divider(height: 1),
        itemBuilder: (context, index) {
          final c = conversations[index];
          return ListTile(
            leading: CircleAvatar(child: Text(c.displayTitle().isNotEmpty ? c.displayTitle()[0].toUpperCase() : '?')),
            title: Text(c.displayTitle()),
            subtitle: c.type == 'group' ? Text('${c.groupMemberCount ?? 0} members') : null,
            trailing: c.unreadCount > 0
                ? CircleAvatar(radius: 11, child: Text('${c.unreadCount}', style: const TextStyle(fontSize: 11)))
                : null,
            onTap: () => context.push('/chats/${c.id}'),
          );
        },
      ),
    );
  }
}
