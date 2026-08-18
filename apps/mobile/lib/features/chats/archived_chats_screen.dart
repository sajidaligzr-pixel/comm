/// The "Archived" page — its own full screen, pushed from the "Archived (N)" row
/// at the top of chats_list_screen.dart, not an inline expand/collapse dropdown
/// sitting below the active chats (asked for directly: WhatsApp puts archived
/// chats behind a dedicated page, not a same-screen disclosure). Deliberately a
/// separate small screen rather than one shared "list with a mode flag" — this
/// project's own established pattern for screens with the same shape but a
/// different scope (group_info_screen.dart vs. the main chats list, etc.).
library;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../api/api_client.dart';
import '../../api/dtos.dart';
import '../../app/providers.dart';
import '../../crypto/message_cache.dart'
    show clearCachedMessages, markConversationLocallyDeleted;
import '../../shared/widgets/error_state.dart';
import '../notifications/conversation_titles.dart';
import 'chat_list_tile.dart';

class ArchivedChatsScreen extends ConsumerStatefulWidget {
  const ArchivedChatsScreen({super.key});
  @override
  ConsumerState<ArchivedChatsScreen> createState() =>
      _ArchivedChatsScreenState();
}

class _ArchivedChatsScreenState extends ConsumerState<ArchivedChatsScreen> {
  List<ConversationSummary>? _archived;
  String? _error;

  @override
  void initState() {
    super.initState();
    _load();
    ref.read(realtimeClientProvider).on('new', _onRealtimeMessage);
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
      final archived = list.where((c) => c.archived).toList();
      for (final c in archived) {
        conversationTitles[c.id] = c.displayTitle();
      }
      if (mounted) {
        setState(() {
          _archived = archived;
          _error = null;
        });
      }
    } on ApiException catch (e) {
      // Same "don't blow away an already-loaded list on a transient background
      // refresh failure" rule as chats_list_screen.dart's own `_load`.
      if (mounted && _archived == null) setState(() => _error = e.message);
    }
  }

  Future<void> _unarchive(ConversationSummary c) async {
    final previous = _archived;
    setState(() => _archived = _archived?.where((x) => x.id != c.id).toList());
    try {
      await ref
          .read(conversationsApiProvider)
          .updateSettings(c.id, archived: false);
    } on ApiException catch (e) {
      if (mounted) {
        setState(() => _archived = previous);
        ScaffoldMessenger.of(
          context,
        ).showSnackBar(SnackBar(content: Text(e.message)));
      }
    }
  }

  /// Same local-only "Delete chat" as chats_list_screen.dart — see message_cache.
  /// dart's `markConversationLocallyDeleted` docstring. An archived chat that's
  /// deleted here just drops out of this list too (it's still `archived` server-
  /// side, but also now locally hidden, so the main list won't pick it back up
  /// either until the other side messages again).
  Future<void> _deleteChat(ConversationSummary c) async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Delete this chat?'),
        content: Text(
          'This removes "${c.displayTitle()}" and its message history from this device only. '
          'It stays on the other side, and this chat will come back if they message you again.',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(context).pop(false),
            child: const Text('Cancel'),
          ),
          FilledButton(
            style: FilledButton.styleFrom(
              backgroundColor: Theme.of(context).colorScheme.error,
            ),
            onPressed: () => Navigator.of(context).pop(true),
            child: const Text('Delete'),
          ),
        ],
      ),
    );
    if (confirmed != true) return;

    await clearCachedMessages(c.id);
    await markConversationLocallyDeleted(c.id);
    if (mounted) {
      setState(
        () => _archived = _archived?.where((x) => x.id != c.id).toList(),
      );
    }
  }

  void _showChatOptions(ConversationSummary c) {
    showModalBottomSheet<void>(
      context: context,
      builder: (context) => SafeArea(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            ListTile(
              leading: const Icon(Icons.unarchive_outlined),
              title: const Text('Unarchive chat'),
              onTap: () {
                Navigator.of(context).pop();
                _unarchive(c);
              },
            ),
            ListTile(
              leading: const Icon(Icons.delete_outline),
              title: const Text('Delete chat'),
              onTap: () {
                Navigator.of(context).pop();
                _deleteChat(c);
              },
            ),
          ],
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Archived')),
      body: _buildBody(),
    );
  }

  Widget _buildBody() {
    if (_error != null) {
      return ErrorState(message: _error!, onRetry: _load);
    }
    final archived = _archived;
    if (archived == null) {
      return const Center(child: CircularProgressIndicator());
    }
    if (archived.isEmpty) {
      return const EmptyState(
        icon: Icons.archive_outlined,
        message: 'No archived chats.',
      );
    }

    return RefreshIndicator(
      onRefresh: _load,
      child: ListView(
        children: [
          for (var i = 0; i < archived.length; i++) ...[
            if (i > 0) const Divider(height: 1),
            buildChatListTile(
              archived[i],
              onTap: () => context.push('/chats/${archived[i].id}'),
              onLongPress: () => _showChatOptions(archived[i]),
            ),
          ],
        ],
      ),
    );
  }
}
