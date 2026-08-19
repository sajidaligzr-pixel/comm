/// Cross-conversation "Starred messages" — mobile counterpart to
/// apps/web/components/chat/starred-messages-view.tsx, see that file's
/// docstring for the underlying reasoning (the server only ever returns WHICH
/// message ids are starred, in WHICH conversations — no plaintext, this app is
/// E2E end to end — so this resolves each entry against this device's own
/// local decrypted cache, one `loadCachedMessages` per distinct conversation).
library;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../api/api_client.dart';
import '../../api/dtos.dart';
import '../../app/providers.dart';
import '../../crypto/kek_holder.dart';
import '../../crypto/message_cache.dart';
import '../../shared/widgets/error_state.dart';
import 'thread_screen.dart' show deletedPlaceholderText;

class _ResolvedStar {
  final StarredMessageDto entry;
  final String conversationTitle;
  final CachedMessage? message;
  const _ResolvedStar({
    required this.entry,
    required this.conversationTitle,
    required this.message,
  });
}

String _previewFor(CachedMessage m) {
  if (m.deleted) {
    return deletedPlaceholderText(m.contentTypeHint, m.deletedReason);
  }
  if (m.contentTypeHint == 'voice') return '🎤 Voice message';
  if (m.contentTypeHint == 'media') {
    return '📄 ${m.attachment?.fileName ?? 'File'}';
  }
  return m.text;
}

class StarredMessagesScreen extends ConsumerStatefulWidget {
  const StarredMessagesScreen({super.key});
  @override
  ConsumerState<StarredMessagesScreen> createState() =>
      _StarredMessagesScreenState();
}

class _StarredMessagesScreenState extends ConsumerState<StarredMessagesScreen> {
  List<_ResolvedStar>? _resolved;
  String? _error;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    final kek = getCurrentKek();
    if (kek == null) {
      setState(() => _error = 'This device is locked. Please sign in again.');
      return;
    }
    try {
      final starredFuture = ref.read(messagesApiProvider).listStarred();
      final conversationsFuture = ref.read(conversationsApiProvider).list();
      final starred = await starredFuture;
      final conversations = await conversationsFuture;
      final titleByConversation = {
        for (final c in conversations) c.id: c.displayTitle(),
      };

      final cacheByConversation = <String, List<CachedMessage>>{};
      for (final conversationId
          in starred.map((s) => s.conversationId).toSet()) {
        cacheByConversation[conversationId] = await loadCachedMessages(
          kek,
          conversationId,
        );
      }

      final results = starred.map((entry) {
        final cache = cacheByConversation[entry.conversationId] ?? const [];
        CachedMessage? message;
        for (final m in cache) {
          if (m.id == entry.messageId) {
            message = m;
            break;
          }
        }
        return _ResolvedStar(
          entry: entry,
          conversationTitle:
              titleByConversation[entry.conversationId] ?? 'Unknown chat',
          message: message,
        );
      }).toList();

      if (mounted) setState(() => _resolved = results);
    } on ApiException catch (e) {
      if (mounted) setState(() => _error = e.message);
    }
  }

  Future<void> _unstar(String messageId) async {
    final previous = _resolved;
    setState(
      () => _resolved = _resolved
          ?.where((r) => r.entry.messageId != messageId)
          .toList(),
    );
    try {
      await ref.read(messagesApiProvider).unstar(messageId);
    } on ApiException catch (e) {
      if (mounted) {
        setState(() => _resolved = previous);
        ScaffoldMessenger.of(
          context,
        ).showSnackBar(SnackBar(content: Text(e.message)));
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Starred messages')),
      body: _buildBody(),
    );
  }

  Widget _buildBody() {
    if (_error != null) return ErrorState(message: _error!, onRetry: _load);
    final resolved = _resolved;
    if (resolved == null) {
      return const Center(child: CircularProgressIndicator());
    }
    if (resolved.isEmpty) {
      return const EmptyState(
        icon: Icons.star_border,
        message: 'No starred messages yet — long-press any message, then Star.',
      );
    }
    return RefreshIndicator(
      onRefresh: _load,
      child: ListView.separated(
        itemCount: resolved.length,
        separatorBuilder: (context, index) => const Divider(height: 1),
        itemBuilder: (context, index) {
          final r = resolved[index];
          return ListTile(
            leading: CircleAvatar(
              child: Text(
                r.conversationTitle.isNotEmpty
                    ? r.conversationTitle[0].toUpperCase()
                    : '?',
              ),
            ),
            title: Text(r.conversationTitle),
            subtitle: Text(
              r.message != null
                  ? _previewFor(r.message!)
                  : 'Not available on this device',
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
            ),
            trailing: IconButton(
              icon: const Icon(Icons.star),
              color: Theme.of(context).colorScheme.primary,
              tooltip: 'Unstar',
              onPressed: () => _unstar(r.entry.messageId),
            ),
            onTap: () => context.push('/chats/${r.entry.conversationId}'),
          );
        },
      ),
    );
  }
}
