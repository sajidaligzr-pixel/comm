import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../api/api_client.dart';
import '../../api/dtos.dart';
import '../../app/app.dart' show WhatsAppColors;
import '../../app/providers.dart';
import '../../crypto/message_cache.dart' show clearCachedMessages;
import '../../shared/widgets/error_state.dart';
import '../notifications/conversation_titles.dart';
import '../auth/auth_controller.dart';
import '../auth/auth_state.dart';
import '../auth/biometric_enroll_prompt.dart';

class ChatsListScreen extends ConsumerStatefulWidget {
  const ChatsListScreen({super.key});
  @override
  ConsumerState<ChatsListScreen> createState() => _ChatsListScreenState();
}

class _ChatsListScreenState extends ConsumerState<ChatsListScreen> {
  List<ConversationSummary>? _conversations;
  String? _error;
  bool _isAdmin = false;
  bool _archivedOpen = false;

  @override
  void initState() {
    super.initState();
    _load();
    final realtime = ref.read(realtimeClientProvider);
    realtime.connect();
    realtime.on('new', _onRealtimeMessage);

    final authState = ref.read(authControllerProvider);
    if (authState is AuthSignedIn) {
      ref.read(groupSessionControllerProvider).setCurrentUserId(authState.profile.id);
      ref.read(messageNotifierProvider).setCurrentUserId(authState.profile.id);
    }
    _checkAdmin();
  }

  /// Success alone implies admin — see admin_api.dart's docstring on why this is
  /// safe to use as a UI-only convenience: the real gate is server-side
  /// `requireAdmin` on every `/api/admin/*` route regardless of whether this nav
  /// entry is shown.
  Future<void> _checkAdmin() async {
    try {
      await ref.read(adminApiProvider).listUsers();
      if (mounted) setState(() => _isAdmin = true);
    } on ApiException {
      // Not an admin (FORBIDDEN) or a transient network error either way — just
      // leave the nav entry hidden, same fail-closed rule as biometric_unlock.dart.
    }
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
      for (final c in list) {
        conversationTitles[c.id] = c.displayTitle();
      }
      if (mounted) setState(() { _conversations = list; _error = null; });
    } on ApiException catch (e) {
      // Only surface a full error screen when there's nothing on screen yet.
      // `_load()` also re-runs on every live 'new' WS event (see
      // _onRealtimeMessage below) — a transient failure on one of those
      // background refreshes shouldn't blow away an already-loaded chat list
      // and replace it with an error page; worst case this refresh is just
      // silently skipped and the next one catches up.
      if (mounted && _conversations == null) setState(() => _error = e.message);
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

  /// Archiving is a per-caller view preference — mirrors
  /// apps/web/components/chat/chats-shell.tsx's `handleToggleArchive` exactly,
  /// including the optimistic local update reverted on failure.
  Future<void> _toggleArchive(ConversationSummary c) async {
    final archived = !c.archived;
    final previous = _conversations;
    setState(() {
      _conversations = _conversations
          ?.map((x) => x.id == c.id ? x.copyWith(archived: archived) : x)
          .toList();
    });
    try {
      await ref.read(conversationsApiProvider).updateSettings(c.id, archived: archived);
    } on ApiException catch (e) {
      if (mounted) {
        setState(() => _conversations = previous);
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(e.message)));
      }
    }
  }

  /// "Delete chat" — see message_cache.dart's `clearCachedMessages` docstring for
  /// exactly what this does and doesn't do (WhatsApp-parity scope: clears this
  /// device's own view, not the other person's, and it can come back if they
  /// message again — there is no server-side "delete a conversation" concept on
  /// either client to defer to instead).
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
          TextButton(onPressed: () => Navigator.of(context).pop(false), child: const Text('Cancel')),
          FilledButton(
            style: FilledButton.styleFrom(backgroundColor: Theme.of(context).colorScheme.error),
            onPressed: () => Navigator.of(context).pop(true),
            child: const Text('Delete'),
          ),
        ],
      ),
    );
    if (confirmed != true) return;

    await clearCachedMessages(c.id);
    try {
      await ref.read(conversationsApiProvider).updateSettings(c.id, archived: true);
    } on ApiException {
      // The local history is already gone regardless — worst case this chat still
      // shows up in the active list (un-archived) with no messages in it, not a
      // silently-broken deletion.
    }
    await _load();
  }

  void _showChatOptions(ConversationSummary c) {
    showModalBottomSheet<void>(
      context: context,
      builder: (context) => SafeArea(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            ListTile(
              leading: Icon(c.archived ? Icons.unarchive_outlined : Icons.archive_outlined),
              title: Text(c.archived ? 'Unarchive chat' : 'Archive chat'),
              onTap: () {
                Navigator.of(context).pop();
                _toggleArchive(c);
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
    final authState = ref.watch(authControllerProvider);
    final profile = authState is AuthSignedIn ? authState.profile : null;

    return Scaffold(
      appBar: AppBar(
        title: Text(profile != null ? 'Chats — @${profile.username}' : 'Chats'),
        actions: [
          if (_isAdmin)
            IconButton(
              icon: const Icon(Icons.admin_panel_settings_outlined),
              tooltip: 'Admin',
              onPressed: () => context.push('/admin'),
            ),
          IconButton(
            icon: const Icon(Icons.devices_other),
            tooltip: 'Devices',
            onPressed: () => context.push('/devices'),
          ),
          IconButton(
            icon: const Icon(Icons.logout),
            tooltip: 'Sign out',
            onPressed: () => ref.read(authControllerProvider.notifier).logout(),
          ),
        ],
      ),
      body: Stack(
        children: [
          _buildBody(),
          if (profile != null) BiometricEnrollPrompt(username: profile.username),
        ],
      ),
      floatingActionButton: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          FloatingActionButton.small(
            heroTag: 'new-group',
            onPressed: () => context.push('/new-group'),
            tooltip: 'New group',
            child: const Icon(Icons.group_add),
          ),
          const SizedBox(width: 12),
          FloatingActionButton(heroTag: 'new-chat', onPressed: _startNewChat, tooltip: 'New chat', child: const Icon(Icons.add_comment)),
        ],
      ),
    );
  }

  Widget _buildRow(ConversationSummary c) {
    return ListTile(
      leading: CircleAvatar(child: Text(c.displayTitle().isNotEmpty ? c.displayTitle()[0].toUpperCase() : '?')),
      title: Text(c.displayTitle()),
      subtitle: c.type == 'group' ? Text('${c.groupMemberCount ?? 0} members') : null,
      trailing: c.unreadCount > 0
          ? CircleAvatar(
              radius: 11,
              backgroundColor: WhatsAppColors.green,
              child: Text('${c.unreadCount}', style: const TextStyle(fontSize: 11, color: Colors.white)),
            )
          : null,
      onTap: () => context.push('/chats/${c.id}'),
      // Long-press → Archive/Unarchive + Delete, matching WhatsApp's own long-press
      // chat-list menu (asked for directly) — mirrors chats-shell.tsx's per-row
      // archive action, which the web client instead exposes as a hover-revealed
      // icon button (a desktop-only interaction with no mobile equivalent, so
      // long-press is the natural port here, not a literal copy).
      onLongPress: () => _showChatOptions(c),
    );
  }

  Widget _buildBody() {
    if (_error != null) {
      return ErrorState(message: _error!, onRetry: _load);
    }
    final conversations = _conversations;
    if (conversations == null) {
      return const Center(child: CircularProgressIndicator());
    }
    if (conversations.isEmpty) {
      return const EmptyState(
        icon: Icons.chat_bubble_outline,
        message: 'No conversations yet — tap the compose button to message someone.',
      );
    }

    final active = conversations.where((c) => !c.archived).toList();
    final archived = conversations.where((c) => c.archived).toList();

    return RefreshIndicator(
      onRefresh: _load,
      child: ListView(
        children: [
          if (active.isEmpty && archived.isNotEmpty)
            const Padding(
              padding: EdgeInsets.all(24),
              child: EmptyState(
                icon: Icons.chat_bubble_outline,
                message: 'No active chats — tap the compose button to message someone.',
              ),
            ),
          for (var i = 0; i < active.length; i++) ...[
            if (i > 0) const Divider(height: 1),
            _buildRow(active[i]),
          ],
          if (archived.isNotEmpty) ...[
            const Divider(height: 1),
            ListTile(
              leading: const Icon(Icons.archive_outlined, color: WhatsAppColors.tealAccent),
              title: Text('Archived (${archived.length})'),
              trailing: Icon(_archivedOpen ? Icons.expand_less : Icons.expand_more),
              onTap: () => setState(() => _archivedOpen = !_archivedOpen),
            ),
            if (_archivedOpen)
              for (var i = 0; i < archived.length; i++) ...[
                const Divider(height: 1),
                _buildRow(archived[i]),
              ],
          ],
        ],
      ),
    );
  }
}
