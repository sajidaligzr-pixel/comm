import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../api/api_client.dart';
import '../../api/dtos.dart';
import '../../app/app.dart' show WhatsAppColors;
import '../../app/providers.dart';
import '../../app/router.dart' show chatsRouteObserver;
import '../../crypto/message_cache.dart'
    show
        clearCachedMessages,
        locallyDeletedConversationIds,
        markConversationLocallyDeleted,
        unmarkConversationLocallyDeleted;
import '../../shared/widgets/error_state.dart';
import '../calls/call_controller.dart' show callControllerProvider;
import '../notifications/conversation_titles.dart';
import '../notifications/push_notifications.dart' show registerPushToken;
import '../auth/auth_controller.dart';
import '../auth/auth_state.dart';
import '../auth/biometric_enroll_prompt.dart';
import '../permissions/permissions_prompt.dart';
import 'chat_list_tile.dart';

class ChatsListScreen extends ConsumerStatefulWidget {
  const ChatsListScreen({super.key});
  @override
  ConsumerState<ChatsListScreen> createState() => _ChatsListScreenState();
}

class _ChatsListScreenState extends ConsumerState<ChatsListScreen>
    with RouteAware {
  List<ConversationSummary>? _conversations;
  Set<String> _locallyDeleted = {};
  String? _error;
  bool _isAdmin = false;
  // Mirrors web's chats-shell.tsx `search` state/`matchesQuery` filter exactly —
  // name-only, chat-list-level (not message content; that's a much bigger, still
  // separate follow-up needing a real local index — docs/13-roadmap.md's Search
  // section). Web already had this; mobile never did until now.
  final _searchController = TextEditingController();
  String _search = '';

  @override
  void initState() {
    super.initState();
    _load();
    final realtime = ref.read(realtimeClientProvider);
    realtime.connect();
    realtime.on('new', _onRealtimeMessage);
    // Covers the case a plain 'new' listener can't: the socket looked fine to
    // this screen the whole time (nothing ever fired 'connection.close'), but
    // was actually dead in the background — see ws_client.dart's `reconnect`
    // docstring. A fresh 'connection.open' means "we might have missed
    // something," so resync exactly like a manual pull-to-refresh would.
    realtime.on('connection.open', _onRealtimeReconnect);

    final authState = ref.read(authControllerProvider);
    if (authState is AuthSignedIn) {
      ref
          .read(groupSessionControllerProvider)
          .setCurrentUserId(authState.profile.id);
      ref.read(messageNotifierProvider).setCurrentUserId(authState.profile.id);
      // Needs an authenticated device (POST /api/push/subscribe) — see
      // push_notifications.dart's own docstring on why this is split from the
      // Firebase-core setup main.dart already did unconditionally.
      registerPushToken(ref.read(pushApiProvider));
    }
    _checkAdmin();
    // Fallback for the plain "opened the app normally, no notification tapped"
    // case — main.dart's tap handler already triggers this directly for a tapped
    // call notification, but a call could still be waiting even if the app was
    // opened some other way (the home-screen icon, a task-switcher swipe back)
    // while it was still ringing.
    ref.read(callControllerProvider.notifier).checkPendingCall();
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final route = ModalRoute.of(context);
    if (route is PageRoute<dynamic>) chatsRouteObserver.subscribe(this, route);
  }

  /// Fires when a route pushed on top of this one (a thread, most commonly) is
  /// popped and this screen is visible again — e.g. the thread just opened may
  /// have marked messages read or the conversation may have changed in some
  /// other way, and without this the row sitting there is whatever this screen
  /// last fetched, not necessarily still true. Reported directly: an opened
  /// thread's unread badge/preview not updating back on this list until some
  /// unrelated refresh happened to run.
  @override
  void didPopNext() => _load();

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
    ref
        .read(realtimeClientProvider)
        .off('connection.open', _onRealtimeReconnect);
    chatsRouteObserver.unsubscribe(this);
    _searchController.dispose();
    super.dispose();
  }

  bool _matchesSearch(ConversationSummary c) {
    if (_search.isEmpty) return true;
    return c.displayTitle().toLowerCase().contains(_search) ||
        (c.otherUsername?.toLowerCase().contains(_search) ?? false);
  }

  void _onRealtimeReconnect(Map<String, dynamic> _) => _load();

  /// A live message landing for a conversation this device had locally "deleted"
  /// is exactly the promise made in that confirmation dialog — un-hide it before
  /// the reload below picks the conversation back up. See message_cache.dart's
  /// `unmarkConversationLocallyDeleted` docstring.
  Future<void> _onRealtimeMessage(Map<String, dynamic> payload) async {
    final message = payload['message'];
    final conversationId = message is Map<String, dynamic>
        ? message['conversationId'] as String?
        : null;
    if (conversationId != null) {
      await unmarkConversationLocallyDeleted(conversationId);
    }
    if (message is Map<String, dynamic>) {
      final senderUserId = message['senderUserId'] as String?;
      final messageId = message['id'] as String?;
      final authState = ref.read(authControllerProvider);
      final myUserId = authState is AuthSignedIn ? authState.profile.id : null;
      // Acknowledging delivery doesn't need decryption — it's just "this device
      // has the ciphertext," the same thing thread_screen.dart's own
      // markDelivered call means when a message is ingested there. This screen
      // (chats_list_screen.dart) is normally mounted the whole time the app is
      // foregrounded, on top of ANY currently-visible screen (Flutter keeps an
      // off-screen route's State alive, listeners and all, until it's actually
      // popped) — so acking here too, not only inside an opened thread, is what
      // marks a message delivered the instant it arrives while the app is simply
      // open, regardless of which specific screen is on top. Found live as part
      // of the reported "delivered but ticks don't update" investigation.
      if (messageId != null &&
          senderUserId != null &&
          senderUserId != myUserId) {
        ref
            .read(messagesApiProvider)
            .markDelivered(messageId)
            .catchError((_) {});
      }
    }
    await _load();
  }

  Future<void> _load() async {
    try {
      final listFuture = ref.read(conversationsApiProvider).list();
      final deletedFuture = locallyDeletedConversationIds();
      final list = await listFuture;
      final deleted = await deletedFuture;
      for (final c in list) {
        conversationTitles[c.id] = c.displayTitle();
      }
      if (mounted) {
        setState(() {
          _conversations = list;
          _locallyDeleted = deleted;
          _error = null;
        });
      }
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
            TextButton(
              onPressed: () => Navigator.of(context).pop(),
              child: const Text('Cancel'),
            ),
            FilledButton(
              onPressed: () => Navigator.of(context).pop(controller.text),
              child: const Text('Start chat'),
            ),
          ],
        );
      },
    );
    if (username == null || username.trim().isEmpty || !mounted) return;

    try {
      final conversation = await ref
          .read(conversationsApiProvider)
          .createOrGetDirect(username.trim());
      if (mounted) context.push('/chats/${conversation.id}');
    } on ApiException catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(
          context,
        ).showSnackBar(SnackBar(content: Text(e.message)));
      }
    }
  }

  /// Archiving is a per-caller view preference — mirrors
  /// apps/web/components/chat/chats-shell.tsx's `handleToggleArchive` exactly,
  /// including the optimistic local update reverted on failure. A completely
  /// separate feature from "Delete chat" below — see message_cache.dart's
  /// `markConversationLocallyDeleted` docstring for why those two used to be
  /// (wrongly) conflated.
  Future<void> _toggleArchive(ConversationSummary c) async {
    final archived = !c.archived;
    final previous = _conversations;
    setState(() {
      _conversations = _conversations
          ?.map((x) => x.id == c.id ? x.copyWith(archived: archived) : x)
          .toList();
    });
    try {
      await ref
          .read(conversationsApiProvider)
          .updateSettings(c.id, archived: archived);
    } on ApiException catch (e) {
      if (mounted) {
        setState(() => _conversations = previous);
        ScaffoldMessenger.of(
          context,
        ).showSnackBar(SnackBar(content: Text(e.message)));
      }
    }
  }

  /// Same optimistic-then-revert shape as `_toggleArchive` above — mirrors
  /// apps/web's `handleTogglePin` (chats-shell.tsx) exactly.
  Future<void> _togglePin(ConversationSummary c) async {
    final pinned = !c.pinned;
    final previous = _conversations;
    setState(() {
      _conversations = _conversations
          ?.map((x) => x.id == c.id ? x.copyWith(pinned: pinned) : x)
          .toList();
    });
    try {
      await ref
          .read(conversationsApiProvider)
          .updateSettings(c.id, pinned: pinned);
    } on ApiException catch (e) {
      if (mounted) {
        setState(() => _conversations = previous);
        ScaffoldMessenger.of(
          context,
        ).showSnackBar(SnackBar(content: Text(e.message)));
      }
    }
  }

  /// "Delete chat" — see message_cache.dart's `clearCachedMessages` and
  /// `markConversationLocallyDeleted` docstrings for exactly what this does and
  /// doesn't do (WhatsApp-parity scope: clears this device's own view, not the
  /// other person's, and it can come back if they message again). Purely local —
  /// no network round trip, so this both can't fail and takes effect instantly,
  /// unlike the old version which (wrongly) reused the server-side `archived` flag.
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
    if (mounted) setState(() => _locallyDeleted = {..._locallyDeleted, c.id});
  }

  void _showChatOptions(ConversationSummary c) {
    showModalBottomSheet<void>(
      context: context,
      builder: (context) => SafeArea(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            ListTile(
              leading: Icon(
                c.pinned ? Icons.push_pin : Icons.push_pin_outlined,
              ),
              title: Text(c.pinned ? 'Unpin chat' : 'Pin chat'),
              onTap: () {
                Navigator.of(context).pop();
                _togglePin(c);
              },
            ),
            ListTile(
              leading: Icon(
                c.archived ? Icons.unarchive_outlined : Icons.archive_outlined,
              ),
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
            icon: const Icon(Icons.star_border),
            tooltip: 'Starred messages',
            onPressed: () => context.push('/starred'),
          ),
          IconButton(
            icon: const Icon(Icons.call_outlined),
            tooltip: 'Calls',
            onPressed: () => context.push('/calls'),
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
          if (profile != null)
            BiometricEnrollPrompt(username: profile.username),
          // Painted last (on top) — see this prompt's own module docstring on
          // why it and BiometricEnrollPrompt above are mutually exclusive.
          const PermissionsOnboardingPrompt(),
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
          FloatingActionButton(
            heroTag: 'new-chat',
            onPressed: _startNewChat,
            tooltip: 'New chat',
            child: const Icon(Icons.add_comment),
          ),
        ],
      ),
    );
  }

  /// Archived chats no longer render inline here — WhatsApp puts them behind a
  /// single "Archived" row that opens their own full page (archived_chats_screen.
  /// dart), not an expand-in-place dropdown sitting below the active list. Locally
  /// "deleted" conversations (see message_cache.dart) are excluded outright: they
  /// aren't archived, they're meant to have vanished until the other side messages
  /// again.
  Widget _buildBody() {
    if (_error != null) {
      return ErrorState(message: _error!, onRetry: _load);
    }
    final conversations = _conversations;
    if (conversations == null) {
      return const Center(child: CircularProgressIndicator());
    }

    final archivedCount = conversations.where((c) => c.archived).length;
    // Pinned-first, same as web's chats-shell.tsx — List.sort is stable in
    // Dart, so everything else stays in whatever order it already was
    // (most-recent-first, from the server).
    final visible =
        conversations
            .where(
              (c) =>
                  !c.archived &&
                  !_locallyDeleted.contains(c.id) &&
                  _matchesSearch(c),
            )
            .toList()
          ..sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0));

    if (conversations.where((c) => !c.archived).isEmpty && archivedCount == 0) {
      return const EmptyState(
        icon: Icons.chat_bubble_outline,
        message:
            'No conversations yet — tap the compose button to message someone.',
      );
    }

    return Column(
      children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(12, 8, 12, 4),
          child: TextField(
            controller: _searchController,
            onChanged: (v) => setState(() => _search = v.trim().toLowerCase()),
            decoration: InputDecoration(
              hintText: 'Search chats',
              prefixIcon: const Icon(Icons.search, size: 20),
              suffixIcon: _search.isEmpty
                  ? null
                  : IconButton(
                      icon: const Icon(Icons.close, size: 18),
                      tooltip: 'Clear search',
                      onPressed: () => setState(() {
                        _searchController.clear();
                        _search = '';
                      }),
                    ),
              filled: true,
              fillColor: const Color(0xFFF0F0F0),
              contentPadding: const EdgeInsets.symmetric(vertical: 0),
              border: OutlineInputBorder(
                borderRadius: BorderRadius.circular(24),
                borderSide: BorderSide.none,
              ),
            ),
          ),
        ),
        Expanded(
          child: RefreshIndicator(
            onRefresh: _load,
            child: ListView(
              children: [
                if (archivedCount > 0 && _search.isEmpty) ...[
                  ListTile(
                    leading: const Icon(
                      Icons.archive_outlined,
                      color: WhatsAppColors.tealAccent,
                    ),
                    title: Text('Archived ($archivedCount)'),
                    trailing: const Icon(Icons.chevron_right),
                    onTap: () => context.push('/chats/archived'),
                  ),
                  const Divider(height: 1),
                ],
                if (visible.isEmpty)
                  Padding(
                    padding: const EdgeInsets.all(24),
                    child: EmptyState(
                      icon: _search.isEmpty ? Icons.chat_bubble_outline : Icons.search_off,
                      message: _search.isEmpty
                          ? 'No active chats — tap the compose button to message someone.'
                          : 'No chats match "$_search".',
                    ),
                  ),
                for (var i = 0; i < visible.length; i++) ...[
                  if (i > 0) const Divider(height: 1),
                  buildChatListTile(
                    visible[i],
                    onTap: () => context.push('/chats/${visible[i].id}'),
                    // Long-press → Archive/Unarchive + Delete, matching WhatsApp's own
                    // long-press chat-list menu (asked for directly) — mirrors
                    // chats-shell.tsx's per-row archive action, which the web client
                    // instead exposes as a hover-revealed icon button (a desktop-only
                    // interaction with no mobile equivalent, so long-press is the
                    // natural port here, not a literal copy).
                    onLongPress: () => _showChatOptions(visible[i]),
                  ),
                ],
              ],
            ),
          ),
        ),
      ],
    );
  }
}
