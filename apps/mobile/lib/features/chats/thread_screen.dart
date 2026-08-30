/// The core "does end-to-end encryption actually work" screen: loads history,
/// decrypts every incoming ciphertext (via crypto/conversation_crypto.dart for
/// direct conversations, features/groups/group_session_controller.dart for group
/// ones — branched on the message's own `envelopeType`, not the conversation type,
/// since that's the actual authoritative signal per message), sends new messages the
/// same way the web client does (REST, not WS — see messages_api.dart's docstring),
/// and reacts to live `new` events over the realtime socket.
///
/// Group voice calling remains out of scope (same as the web client — calling is
/// still 1:1 only), so the call button only ever appears for direct conversations.
library;

import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';
import 'package:audioplayers/audioplayers.dart';
import 'package:file_picker/file_picker.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart' show Clipboard, ClipboardData, HapticFeedback;
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:image_picker/image_picker.dart';
import 'package:path_provider/path_provider.dart';
import 'package:record/record.dart';
import 'package:uuid/uuid.dart';
import 'package:video_player/video_player.dart';

import '../../api/api_client.dart';
import '../../api/dtos.dart';
import '../../app/app.dart' show WhatsAppColors;
import '../../app/providers.dart';
import '../notifications/conversation_titles.dart';
import '../notifications/local_notifications.dart' show clearNotificationFor;
import '../../crypto/attachment_crypto.dart' as attach_crypto;
import '../../crypto/conversation_crypto.dart' as convo;
import '../../crypto/encoding.dart';
import '../../crypto/history_sync.dart';
import '../../crypto/kek_holder.dart';
import '../../crypto/message_cache.dart';
import '../../crypto/session/session.dart' show MessageEnvelope;
import '../../shared/widgets/error_state.dart';
import '../auth/auth_controller.dart';
import '../auth/auth_state.dart';
import '../calls/call_controller.dart';
import '../calls/group_call_controller.dart';
import '../groups/group_session_controller.dart';
import 'forward_dialog.dart' show showForwardSheet;
import 'message_info_sheet.dart' show showMessageInfoSheet;

const _uuid = Uuid();

class _DecodedContent {
  final String text;
  final AttachmentDescriptor? attachment;
  final String? mediaBase64;
  const _DecodedContent({
    required this.text,
    this.attachment,
    this.mediaBase64,
  });
}

_DecodedContent _decodeContent(String contentTypeHint, Uint8List plaintext) {
  if (contentTypeHint == 'voice' ||
      contentTypeHint == 'image' ||
      contentTypeHint == 'view_once') {
    // Raw bytes, not JSON — same inline-envelope path as text, just base64'd
    // for storage the same way apps/web keeps `mediaBase64` in its own local
    // cache. `image`/`view_once` were a real, found gap: this mobile client
    // never SENDS a photo this way (`_pickAndSendPhoto` used the object-
    // storage `media` pipeline exclusively — see its own docstring), so a
    // photo arriving FROM web (which does send inline `image` bytes,
    // message-thread.tsx's `compressImageForSend`) had no decode branch here
    // at all and fell through to being interpreted as UTF-8 text — silently
    // garbled, not a crash, so easy to miss. `view_once` (docs/13-roadmap.md)
    // needed this same inline path anyway (it must stay wire-compatible with
    // web's own `view_once` format), which is what surfaced the `image` gap
    // sitting right next to it.
    return _DecodedContent(text: '', mediaBase64: bytesToBase64(plaintext));
  }
  if (contentTypeHint == 'media') {
    try {
      return _DecodedContent(
        text: '',
        attachment: AttachmentDescriptor.fromJson(
          jsonDecode(bytesToUtf8(plaintext)) as Map<String, dynamic>,
        ),
      );
    } catch (_) {
      return const _DecodedContent(text: '[Malformed attachment]');
    }
  }
  // `reaction` falls through to plain text like everything else here — its JSON
  // payload rides `CachedMessage.text` exactly like a real text message would,
  // the same "zero cache-schema changes" trick apps/web/lib/message-content.ts
  // uses. Nothing renders it as a bubble (`_buildBody` filters `contentTypeHint
  // == 'reaction'` out of the visible list); `_buildReactionState` below is what
  // gives that JSON meaning.
  return _DecodedContent(text: bytesToUtf8(plaintext));
}

/// The plaintext of a `contentTypeHint: 'reaction'` message — mirrors apps/web/
/// lib/message-content.ts's `ReactionPayload`/`parseReactionPayload` exactly,
/// see that file's docstring for why `emoji: null` means "remove my reaction,"
/// not "react with nothing."
class _ReactionPayload {
  final String targetMessageId;
  final String? emoji;
  const _ReactionPayload({required this.targetMessageId, this.emoji});

  static _ReactionPayload? tryParse(String text) {
    try {
      final json = jsonDecode(text);
      if (json is! Map<String, dynamic>) return null;
      final targetMessageId = json['targetMessageId'];
      if (targetMessageId is! String) return null;
      final emoji = json['emoji'];
      if (emoji != null && emoji is! String) return null;
      return _ReactionPayload(
        targetMessageId: targetMessageId,
        emoji: emoji as String?,
      );
    } catch (_) {
      return null;
    }
  }
}

class ReactionSummary {
  final String emoji;
  final int count;

  /// Whether the signed-in user is one of the people behind this emoji's count.
  final bool mine;
  const ReactionSummary({
    required this.emoji,
    required this.count,
    required this.mine,
  });
}

/// See apps/web/lib/message-content.ts's `buildReactionState` — identical
/// algorithm (latest-by-sentAt reaction per sender, grouped into per-emoji
/// counts), scanning the full cached message list (reaction rows included, even
/// though they're filtered out of what's actually rendered as bubbles).
Map<String, List<ReactionSummary>> _buildReactionState(
  List<CachedMessage> messages,
  String currentUserId,
) {
  final latestBySender =
      <String, Map<String, ({String? emoji, DateTime sentAt})>>{};
  for (final m in messages) {
    if (m.contentTypeHint != 'reaction') continue;
    final payload = _ReactionPayload.tryParse(m.text);
    if (payload == null) continue;
    final bySender = latestBySender.putIfAbsent(
      payload.targetMessageId,
      () => {},
    );
    final sentAt =
        DateTime.tryParse(m.sentAt) ?? DateTime.fromMillisecondsSinceEpoch(0);
    final existing = bySender[m.senderUserId];
    if (existing == null || !sentAt.isBefore(existing.sentAt)) {
      bySender[m.senderUserId] = (emoji: payload.emoji, sentAt: sentAt);
    }
  }

  final result = <String, List<ReactionSummary>>{};
  for (final entry in latestBySender.entries) {
    final counts = <String, int>{};
    String? mine;
    for (final senderEntry in entry.value.entries) {
      final emoji = senderEntry.value.emoji;
      if (emoji == null) continue; // this sender's latest action was a removal
      counts[emoji] = (counts[emoji] ?? 0) + 1;
      if (senderEntry.key == currentUserId) mine = emoji;
    }
    final summaries = counts.entries
        .map(
          (e) => ReactionSummary(
            emoji: e.key,
            count: e.value,
            mine: e.key == mine,
          ),
        )
        .toList();
    if (summaries.isNotEmpty) result[entry.key] = summaries;
  }
  return result;
}

String? _myReactionAmong(List<ReactionSummary> summaries) {
  for (final r in summaries) {
    if (r.mine) return r.emoji;
  }
  return null;
}

/// A small curated set — mirrors apps/web's `EmojiPicker` in spirit (a
/// functional set without pulling in an emoji-data package), scoped down to the
/// handful long-press reveals directly rather than a full picker grid, since a
/// phone's long-press bottom sheet has much less room than a desktop dropdown.
const _quickReactionEmoji = ['👍', '❤️', '😂', '😮', '😢', '🙏'];

/// In-chat search — mirrors apps/web/lib/message-content.ts's
/// `messageMatchesSearch` exactly, including WHY this is a plain linear scan
/// and not a real index: a per-conversation cache tops out at a few hundred
/// messages (message_cache.dart's cap), and scanning that is imperceptibly
/// fast; a real index only earns its cost for a FUTURE cross-conversation
/// global search, out of scope for this pass (docs/13-roadmap.md).
bool _messageMatchesSearch(CachedMessage m, String normalizedQuery) {
  if (m.deleted || normalizedQuery.isEmpty) return false;
  if (m.contentTypeHint == 'reaction' || m.contentTypeHint == 'system') {
    return false;
  }
  if (m.contentTypeHint == 'media') {
    return (m.attachment?.fileName ?? '').toLowerCase().contains(
      normalizedQuery,
    );
  }
  if (m.contentTypeHint == 'voice' || m.contentTypeHint == 'image') {
    return false; // no text to search
  }
  return m.text.toLowerCase().contains(normalizedQuery);
}

/// Splits `text` into `TextSpan`s, highlighting every case-insensitive match of
/// `query` — the Dart/`Text.rich` counterpart to apps/web's `splitForHighlight`
/// (which returns plain data since a `.ts` file can't return JSX; here a
/// `TextSpan` tree serves the same purpose directly).
List<TextSpan> _highlightSpans(
  String text,
  String normalizedQuery,
  TextStyle baseStyle,
) {
  if (normalizedQuery.isEmpty) return [TextSpan(text: text, style: baseStyle)];
  final lower = text.toLowerCase();
  final spans = <TextSpan>[];
  var cursor = 0;
  while (cursor < text.length) {
    final idx = lower.indexOf(normalizedQuery, cursor);
    if (idx == -1) {
      spans.add(TextSpan(text: text.substring(cursor), style: baseStyle));
      break;
    }
    if (idx > cursor) {
      spans.add(TextSpan(text: text.substring(cursor, idx), style: baseStyle));
    }
    spans.add(
      TextSpan(
        text: text.substring(idx, idx + normalizedQuery.length),
        style: baseStyle.copyWith(
          backgroundColor: const Color(0xFFFFE082),
          color: Colors.black,
        ),
      ),
    );
    cursor = idx + normalizedQuery.length;
  }
  return spans;
}

class ThreadScreen extends ConsumerStatefulWidget {
  const ThreadScreen({super.key, required this.conversationId});
  final String conversationId;

  @override
  ConsumerState<ThreadScreen> createState() => _ThreadScreenState();
}

class _ThreadScreenState extends ConsumerState<ThreadScreen> {
  ConversationSummary? _conversation;
  final List<CachedMessage> _messages = [];
  final _textController = TextEditingController();

  /// Every device a direct-conversation send needs its own independently-encrypted
  /// envelope for — the other member's active devices, plus this account's own
  /// other active devices (self-fan-out: a second phone, a desktop client, a web
  /// tab left open elsewhere). Resolved once when the thread opens, reused for
  /// every send — mirrors apps/web's `targetDeviceIdsRef` (message-thread.tsx)
  /// exactly, including WHY: re-resolving this on every single send was a real,
  /// found regression (each send paid a full network round trip before encryption
  /// could even start, on top of the actual send request). A device change
  /// mid-conversation-view is rare enough that "resolved once per thread visit" is
  /// the right tradeoff, same call the web client already made.
  List<({String userId, String deviceId})> _targetDevices = [];

  /// Delivered/read status for messages THIS device sent, keyed by message id —
  /// deliberately NOT part of `CachedMessage`/the persistent local cache, mirroring
  /// web's separate ephemeral `status` state map (message-thread.tsx): re-seeded
  /// from `MessageDto.deliveredAt`/`readAt` on load, updated live via the
  /// `delivered`/`read` WS events, never itself persisted.
  final Map<String, ({bool delivered, bool read})> _status = {};

  /// Message ids currently between "rendered locally" and "server confirmed the
  /// POST" — drives the clock/pending tick in `_MessageBubble`. Mirrors web's
  /// `pendingIds` (message-thread.tsx) exactly; see `_sendEnvelope`'s docstring
  /// for why this exists at all.
  final Set<String> _pendingIds = {};

  /// Cross-conversation by nature (GET /api/messages/starred returns every one
  /// of the caller's starred messages) — fetched once per thread mount, mirrors
  /// apps/web's identical `starredIds` state (message-thread.tsx).
  Set<String> _starredIds = {};

  /// In-memory only, keyed by `objectKey` — decrypted bytes for a `media`
  /// attachment, fetched via `_ensureMediaDecrypted` below. Deliberately NOT part
  /// of `message_cache.dart`'s persistent encrypted store: that cache holds every
  /// message this device has ever seen, and letting full-size photo/video bytes
  /// pile up in it would bloat local storage for something already recoverable
  /// from object storage on demand. A session-lifetime cache is enough to make
  /// re-scrolling a thread not re-download the same image repeatedly.
  final Map<String, Future<Uint8List>> _mediaFutures = {};

  /// The message a long-press has staged to reply to — mirrors web's
  /// `replyingTo` (message-thread.tsx) exactly: shown as a preview strip above
  /// the composer, cleared the instant a send actually starts (not after it
  /// completes — see `_sendEnvelope`), and carried as `replyToMessageId` on
  /// the outgoing request.
  CachedMessage? _replyingTo;
  final _scrollController = ScrollController();
  String? _error;

  /// In-chat search (mirrors apps/web's identical feature — message-thread.tsx)
  /// — a plain linear scan over `_messages`, never a real index; see
  /// `_messageMatchesSearch`'s docstring. `_bubbleKeys` is what lets
  /// `_scrollToSearchMatch` jump the ListView to an arbitrary already-rendered
  /// bubble (`Scrollable.ensureVisible`, the standard Flutter pattern for this —
  /// there's no by-index scroll-to for a variable-height ListView.builder).
  bool _searchOpen = false;
  String _searchQuery = '';
  int _searchIndex = 0;
  final _searchController = TextEditingController();
  final Map<String, GlobalKey> _bubbleKeys = {};

  GlobalKey _keyFor(String messageId) =>
      _bubbleKeys.putIfAbsent(messageId, () => GlobalKey());

  List<String> _computeSearchMatches(String normalizedQuery) {
    if (normalizedQuery.isEmpty) return const [];
    return _messages
        .where(
          (m) =>
              m.contentTypeHint != 'reaction' &&
              _messageMatchesSearch(m, normalizedQuery),
        )
        .map((m) => m.id)
        .toList();
  }

  void _onSearchChanged(String value) {
    final normalized = value.trim().toLowerCase();
    final matches = _computeSearchMatches(normalized);
    setState(() {
      _searchQuery = value;
      _searchIndex = matches.isNotEmpty ? matches.length - 1 : 0;
    });
    WidgetsBinding.instance.addPostFrameCallback((_) => _scrollToSearchMatch());
  }

  void _moveSearch(int delta, List<String> matches) {
    if (matches.isEmpty) return;
    setState(
      () => _searchIndex = (_searchIndex + delta).clamp(0, matches.length - 1),
    );
    WidgetsBinding.instance.addPostFrameCallback((_) => _scrollToSearchMatch());
  }

  void _scrollToSearchMatch() {
    final matches = _computeSearchMatches(_searchQuery.trim().toLowerCase());
    if (matches.isEmpty) return;
    final id = matches[_searchIndex.clamp(0, matches.length - 1)];
    final ctx = _bubbleKeys[id]?.currentContext;
    if (ctx != null) {
      Scrollable.ensureVisible(
        ctx,
        alignment: 0.5,
        duration: const Duration(milliseconds: 250),
      );
    }
  }

  void _closeSearch() {
    setState(() {
      _searchOpen = false;
      _searchQuery = '';
      _searchController.clear();
    });
  }

  bool _loading = true;
  bool _sending = false;

  // --- Voice notes -----------------------------------------------------------
  // See _startVoiceRecording's docstring for the format/protocol choice.
  final AudioRecorder _voiceRecorder = AudioRecorder();
  bool _isRecordingVoice = false;
  int _recordingSeconds = 0;
  Timer? _recordingTimer;

  // A dedicated player for the short "message received" chime (_playMessageChime,
  // called from _ingestIncoming) — separate from any given _VoiceMessagePlayer
  // bubble's own instance, since those come and go with the widgets that own them
  // and this needs to outlive any single bubble.
  final AudioPlayer _chimePlayer = AudioPlayer();

  Future<void> _playMessageChime() async {
    try {
      await _chimePlayer.play(AssetSource('sounds/message.wav'));
    } catch (_) {
      // Best-effort, same as every other local-notification-adjacent side effect —
      // never worth surfacing to the user or blocking message ingestion over.
    }
  }

  // --- Typing indicator (direct conversations only — matches web's own scope,
  // see group-message-thread.tsx's own docstring: "no reply-to, no typing
  // indicator, no read-receipt ticks" for groups) ------------------------------
  bool _otherTyping = false;
  Timer? _typingStopTimer;

  // --- Disappearing messages ---------------------------------------------------
  // Local, immediate enforcement — mirrors web's own periodic prune
  // (message-thread.tsx/group-message-thread.tsx). apps/worker's hourly sweep is
  // what actually erases the ciphertext server-side and reaches devices that
  // don't have this thread open; this is what makes it feel instant on this one.
  Timer? _disappearingPruneTimer;

  // --- Delivered/read status poll (belt-and-suspenders) ------------------------
  // The live 'delivered'/'read' WS events (registered in initState below) are the
  // primary path and normally all that's needed — but found live, reported
  // directly: both apps open, a message sent from this device sat on a single
  // tick with no live update at all, only turning into a double blue tick after
  // the thread was manually closed and reopened (which forces a fresh `_load()`,
  // reseeding `_status` from a REST fetch — see that reseed loop's own comment).
  // Whatever gap let that one WS frame (or its round trip through the other
  // side's own ack calls) go missing, this is the fallback that guarantees
  // convergence within one poll interval regardless: a light, decrypt-free
  // re-check of just the delivered/read flags for this device's own messages,
  // not a full `_load()` (which also re-fetches conversation state, restarts the
  // disappearing-prune timer, and re-runs group key sync — far more than this
  // needs and disruptive to call repeatedly on a timer).
  Timer? _statusPollTimer;

  String get _myUserId {
    final state = ref.read(authControllerProvider);
    return state is AuthSignedIn ? state.profile.id : '';
  }

  @override
  void initState() {
    super.initState();
    _load();
    final realtime = ref.read(realtimeClientProvider);
    // Idempotent (no-ops if already connected) — belt-and-suspenders for the case
    // this is the very first screen reached this session (a deep link, or a
    // tapped notification opening straight into a conversation) rather than
    // chats_list_screen.dart, which is normally what calls this first. Without
    // this, a thread opened that way could sit fully connected-*looking* while
    // actually never having connected at all.
    realtime.connect();
    realtime.on('new', _onRealtimeNew);
    realtime.on('delivered', _onRealtimeDelivered);
    realtime.on('read', _onRealtimeRead);
    realtime.on('deleted', _onRealtimeDeletedMessage);
    realtime.on('typing', _onRealtimeTyping);
    // A fresh connection (first connect, or a reconnect after the socket was
    // silently dead — see ws_client.dart's `reconnect` docstring) means this
    // screen may have missed live events entirely while it looked "connected."
    // `_load()` re-fetches history, re-marks-read, and — per the fix below —
    // re-seeds every own-message's delivered/read tick from the fresh REST
    // response, so this is what actually resyncs stale ticks after the app was
    // backgrounded, not just new messages.
    realtime.on('connection.open', _onRealtimeReconnect);

    // Tells messageNotifierProvider not to pop a redundant system notification for
    // whatever's already visible on screen right now, and clears any notification
    // already showing for this conversation (e.g. from before the app was opened).
    Future.microtask(
      () => ref.read(currentOpenConversationIdProvider.notifier).state =
          widget.conversationId,
    );
    clearNotificationFor(widget.conversationId);

    _statusPollTimer = Timer.periodic(
      const Duration(seconds: 8),
      (_) => _pollDeliveryStatus(),
    );

    _loadStarred();
  }

  Future<void> _loadStarred() async {
    try {
      final rows = await ref.read(messagesApiProvider).listStarred();
      if (mounted) {
        setState(() => _starredIds = rows.map((r) => r.messageId).toSet());
      }
    } on ApiException catch (_) {
      // Best-effort — an empty/stale starred set just means no star badges
      // show up until the next thread visit; never worth blocking on.
    }
  }

  Future<void> _toggleStar(CachedMessage message) async {
    final wasStarred = _starredIds.contains(message.id);
    setState(() {
      _starredIds = {..._starredIds};
      if (wasStarred) {
        _starredIds.remove(message.id);
      } else {
        _starredIds.add(message.id);
      }
    });
    try {
      if (wasStarred) {
        await ref.read(messagesApiProvider).unstar(message.id);
      } else {
        await ref.read(messagesApiProvider).star(message.id);
      }
    } on ApiException catch (e) {
      if (mounted) {
        setState(() {
          _starredIds = {..._starredIds};
          if (wasStarred) {
            _starredIds.add(message.id);
          } else {
            _starredIds.remove(message.id);
          }
        });
        ScaffoldMessenger.of(
          context,
        ).showSnackBar(SnackBar(content: Text(e.message)));
      }
    }
  }

  /// Fire-and-forget persistence for a `_status` update — see
  /// `CachedMessage.delivered`/`.read`'s own docstring for why this needs to
  /// happen at all, alongside (never instead of) the in-memory `setState`
  /// every caller already does. A missed write here just means the next
  /// fresh mount's cache-seed is one update behind, self-correcting the
  /// instant its own `_load()` reseeds from a fresh REST fetch anyway.
  void _persistStatus(String messageId, {required bool delivered, required bool read}) {
    final kek = getCurrentKek();
    if (kek == null) return;
    unawaited(
      updateCachedMessageStatus(
        kek,
        widget.conversationId,
        messageId,
        delivered: delivered,
        read: read,
      ),
    );
  }

  /// See `_statusPollTimer`'s own docstring for why this exists at all. Skips the
  /// network round trip entirely once there's nothing left to wait on (every own
  /// message already showing read), so an idle-but-open thread doesn't poll
  /// forever for no reason.
  Future<void> _pollDeliveryStatus() async {
    final hasPending = _messages.any(
      (m) => m.isOwn && !(_status[m.id]?.read ?? false),
    );
    if (!hasPending) return;
    try {
      final page = await ref
          .read(messagesApiProvider)
          .list(widget.conversationId, limit: 100);
      if (!mounted) return;
      setState(() {
        for (final dto in page.items) {
          if (dto.senderUserId != _myUserId) continue;
          final delivered = dto.deliveredAt != null;
          final read = dto.readAt != null;
          _status[dto.id] = (delivered: delivered, read: read);
          _persistStatus(dto.id, delivered: delivered, read: read);
        }
      });
    } catch (_) {
      // Best-effort — same as every other background receipt/status ping in this
      // file; the next tick (or a live WS event, or the next full `_load()`)
      // tries again.
    }
  }

  @override
  void dispose() {
    final realtime = ref.read(realtimeClientProvider);
    realtime.off('new', _onRealtimeNew);
    realtime.off('delivered', _onRealtimeDelivered);
    realtime.off('read', _onRealtimeRead);
    realtime.off('deleted', _onRealtimeDeletedMessage);
    realtime.off('typing', _onRealtimeTyping);
    realtime.off('connection.open', _onRealtimeReconnect);
    if (ref.read(currentOpenConversationIdProvider) == widget.conversationId) {
      ref.read(currentOpenConversationIdProvider.notifier).state = null;
    }
    _statusPollTimer?.cancel();
    _textController.dispose();
    _searchController.dispose();
    _scrollController.dispose();
    _recordingTimer?.cancel();
    _voiceRecorder.dispose();
    _chimePlayer.dispose();
    _typingStopTimer?.cancel();
    _disappearingPruneTimer?.cancel();
    super.dispose();
  }

  void _onRealtimeReconnect(Map<String, dynamic> _) => _load();

  void _onRealtimeNew(Map<String, dynamic> payload) {
    final raw = payload['message'];
    if (raw is! Map<String, dynamic>) return;
    final dto = MessageDto.fromJson(raw);
    if (dto.conversationId != widget.conversationId) return;
    _ingestIncoming(dto, isLive: true);
  }

  void _onRealtimeDelivered(Map<String, dynamic> payload) {
    final messageId = payload['messageId'] as String?;
    if (messageId == null) return;
    if (!mounted) return;
    final read = _status[messageId]?.read ?? false;
    setState(() => _status[messageId] = (delivered: true, read: read));
    _persistStatus(messageId, delivered: true, read: read);
  }

  void _onRealtimeRead(Map<String, dynamic> payload) {
    if (payload['conversationId'] != widget.conversationId) return;
    final upToMessageId = payload['upToMessageId'] as String?;
    if (upToMessageId == null) return;
    if (!mounted) return;
    // "Read up to X" means every one of THIS device's own messages sent at or
    // before X, not literally only the message whose id is X — the other side
    // opening the thread reads everything up to that point in one motion, not
    // message-by-message. Mirrors web's own message-thread.tsx exactly (same
    // single-id-only update), which has the identical gap: sending two messages
    // in a row before the other side opens the thread left the earlier one stuck
    // on a single/grey tick indefinitely in this live path — it only ever caught
    // up on the next full reload, which re-seeds every own message's status from
    // a fresh REST fetch (see _load()'s own fix for why that part already works).
    CachedMessage? upToMessage;
    for (final m in _messages) {
      if (m.id == upToMessageId) {
        upToMessage = m;
        break;
      }
    }
    setState(() {
      if (upToMessage != null) {
        for (final m in _messages) {
          if (m.isOwn && m.sentAt.compareTo(upToMessage.sentAt) <= 0) {
            _status[m.id] = (delivered: true, read: true);
            _persistStatus(m.id, delivered: true, read: true);
          }
        }
      } else {
        // The read message isn't in this device's local cache/view (e.g. it
        // arrived on a different device) — fall back to the old exact-id update,
        // still strictly better than doing nothing with it.
        _status[upToMessageId] = (delivered: true, read: true);
        _persistStatus(upToMessageId, delivered: true, read: true);
      }
    });
  }

  /// Another member deleted one of their own messages (or the worker's
  /// disappearing-timer/media-retention sweep expired one) — mirrors web's own
  /// `deleted` listener exactly: not gated on `isOwn` here, since this fires for
  /// deletions this device didn't itself initiate (the initiating device applies
  /// its own tombstone immediately in `_confirmAndDelete`, before any event
  /// round-trips back — same "optimistic local update, not dependent on the
  /// event" pattern every other mutation in this file already uses).
  void _onRealtimeDeletedMessage(Map<String, dynamic> payload) {
    if (payload['conversationId'] != widget.conversationId) return;
    final messageId = payload['messageId'] as String?;
    if (messageId == null) return;
    _applyDeletion(messageId, payload['reason'] as String? ?? 'manual');
  }

  Future<void> _applyDeletion(String messageId, String reason) async {
    final kek = getCurrentKek();
    if (kek == null) return;
    final updated = await markCachedMessageDeleted(
      kek,
      widget.conversationId,
      messageId,
      reason,
    );
    if (mounted) {
      setState(() {
        _messages
          ..clear()
          ..addAll(updated);
      });
    }
  }

  /// 1:1 only — matches web's own scope (group-message-thread.tsx's docstring:
  /// "no reply-to, no typing indicator, no read-receipt ticks" for groups).
  void _onRealtimeTyping(Map<String, dynamic> payload) {
    if (payload['conversationId'] != widget.conversationId) return;
    if (payload['fromUserId'] != _conversation?.otherUserId) return;
    if (!mounted) return;
    setState(() => _otherTyping = payload['state'] == 'start');
    _scrollToBottom();
  }

  Future<void> _load() async {
    try {
      final kek = getCurrentKek();
      if (kek == null) throw StateError('Local keys are locked.');

      // The conversation summary and the message history don't depend on each
      // other — both requests fire the instant these Futures are created, so
      // this is one round trip's worth of wall-clock time instead of two paid
      // back to back. (Found live, alongside the cache-batching fix below, while
      // chasing "opening a chat takes a while.")
      final conversationFuture = ref
          .read(conversationsApiProvider)
          .get(widget.conversationId);
      final pageFuture = ref
          .read(messagesApiProvider)
          .list(widget.conversationId, limit: 100);

      final cached = await loadCachedMessages(kek, widget.conversationId);
      final conversation = await conversationFuture;
      conversationTitles[conversation.id] = conversation.displayTitle();
      if (mounted) {
        setState(() {
          _conversation = conversation;
          _messages
            ..clear()
            ..addAll(cached);
          // Seeds `_status` from the cache's own last-known delivered/read
          // fields, not left empty until the REST fetch below resolves — see
          // CachedMessage.delivered/.read's own docstring for the regression
          // this closes (a fresh mount otherwise rendered every own message as
          // a single tick for the length of that reload, even ones already
          // long confirmed delivered/read).
          for (final m in cached) {
            if (m.isOwn) _status[m.id] = (delivered: m.delivered, read: m.read);
          }
        });
      }
      _restartDisappearingPruneTimer(conversation.disappearingTimer);

      if (conversation.type == 'group' && conversation.groupId != null) {
        final groupController = ref.read(groupSessionControllerProvider);
        await groupController.registerGroupMembership(conversation.groupId!);
        await groupController.ensureGroupKeysUpToDate(conversation.groupId!);
      } else if (conversation.type == 'direct') {
        // Resolved once here, not per-send — see _targetDevices' own docstring.
        final otherMemberDevices = await ref
            .read(conversationsApiProvider)
            .recipientDevices(widget.conversationId);
        final ownDevices = await ref.read(devicesApiProvider).list();
        final ownOtherDevices = ownDevices
            .where((d) => !d.isCurrentDevice && d.status == 'active')
            .map((d) => (userId: _myUserId, deviceId: d.id));
        _targetDevices = [...otherMemberDevices, ...ownOtherDevices];
      }

      final page = await pageFuture;
      final cachedIds = cached.map((m) => m.id).toSet();
      // Decrypted in order (each message still renders the instant it's ready,
      // via _ingestIncoming's own setState), but NOT persisted to disk one at a
      // time — persist:false defers that to a single batched write below. See
      // appendCachedMessages's docstring for why the per-message version of this
      // was quietly O(n²) for a conversation with real history.
      final newlyIngested = <CachedMessage>[];
      // Delivered/read status is per-message state that changes on the SERVER
      // after this device already has the message cached (the other side
      // receiving/reading it doesn't touch this device's ciphertext at all) — so
      // it has to be refreshed from this fresh REST fetch every time, not just
      // for messages new enough to need decrypting. Found live as the reported
      // "ticks aren't turning blue" bug: `_ingestIncoming` (below) is the only
      // place that seeds `_status` from `dto.deliveredAt`/`readAt`, but the
      // `continue` above skipped it entirely for anything already cached — which
      // is most of a real conversation's own sent messages after the first load,
      // so their ticks only ever updated via a live WS event arriving while this
      // screen happened to already be open and connected.
      var statusChanged = false;
      for (final dto in page.items) {
        if (dto.senderUserId == _myUserId) {
          final next = (
            delivered: dto.deliveredAt != null,
            read: dto.readAt != null,
          );
          if (_status[dto.id] != next) {
            _status[dto.id] = next;
            statusChanged = true;
            _persistStatus(dto.id, delivered: next.delivered, read: next.read);
          }
        }
        if (cachedIds.contains(dto.id)) continue;
        final result = await _ingestIncoming(dto, persist: false);
        if (result != null) newlyIngested.add(result);
      }
      if (statusChanged && mounted) setState(() {});
      if (newlyIngested.isNotEmpty) {
        await appendCachedMessages(kek, widget.conversationId, newlyIngested);
      }
      if (page.items.isNotEmpty) {
        // Fire-and-forget, same as every other receipt ping in this file (see
        // _ingestIncoming's docstring on why awaiting these serializes network
        // round trips) — and deliberately guarded on isNotEmpty: a brand-new,
        // still-empty conversation has nothing to mark read, and sending ''
        // as upToMessageId is not a valid message id. Found live: the server
        // correctly rejected it, but because this call used to be awaited
        // inside this same try, that rejection wiped out the whole loaded
        // thread (composer included) and left this screen showing the raw
        // validation message instead of any chat UI at all.
        //
        // `page.items.first`, not `.last` — messages_api.dart's `list()` (and the
        // server's own listMessages, service.ts) returns the page newest-first
        // (`orderBy: serverReceivedAt: 'desc'`, the natural shape for "give me the
        // most recent page, paginate backwards for older history"). `.last` was
        // the OLDEST message in the page, so markRead's `upToMessageId` was telling
        // the server "mark read everything at or before the oldest message here" —
        // server/modules/messages/service.ts's `markConversationRead` filters
        // `serverReceivedAt: { lte: upToMessage.serverReceivedAt }`, so that
        // consistently marked only the single oldest message (or a same-timestamp
        // handful) as read, never the rest of the page. Found live as the reported
        // bug: the sender's ticks would advance to delivered (a separate, per-
        // message, unaffected path — markDelivered) but never past that to read/blue,
        // no matter how many times the recipient opened the thread.
        ref
            .read(conversationsApiProvider)
            .markRead(widget.conversationId, page.items.first.id)
            .catchError((_) {});
      }
      _scrollToBottom();
    } on ApiException catch (e) {
      setState(() => _error = e.message);
    } catch (e) {
      setState(() => _error = 'Could not load this conversation.');
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  void _retry() {
    setState(() {
      _error = null;
      _loading = true;
    });
    _load();
  }

  /// (Re)starts the periodic local-pruning timer for the conversation's current
  /// disappearing-message setting — called on load and whenever the setting
  /// changes. Cancels any previous timer first so changing 'off' -> '24 hours'
  /// (or vice versa) never leaves two timers running or an old one lingering.
  void _restartDisappearingPruneTimer(String timer) {
    _disappearingPruneTimer?.cancel();
    _disappearingPruneTimer = null;
    final ms = disappearingTimerToMs(timer);
    if (ms == null) return;
    _pruneExpiredMessages(ms);
    _disappearingPruneTimer = Timer.periodic(
      const Duration(seconds: 30),
      (_) => _pruneExpiredMessages(ms),
    );
  }

  Future<void> _pruneExpiredMessages(int ms) async {
    final kek = getCurrentKek();
    if (kek == null) return;
    final now = DateTime.now().toUtc();
    final expiredIds = _messages
        .where(
          (m) =>
              !m.deleted &&
              now.difference(DateTime.parse(m.sentAt).toUtc()).inMilliseconds >
                  ms,
        )
        .map((m) => m.id)
        .toList();
    if (expiredIds.isEmpty) return;
    List<CachedMessage> updated = _messages;
    for (final id in expiredIds) {
      updated = await markCachedMessageDeleted(
        kek,
        widget.conversationId,
        id,
        'disappearing_timer',
      );
    }
    if (mounted) {
      setState(() {
        _messages
          ..clear()
          ..addAll(updated);
      });
    }
  }

  Future<void> _setDisappearingTimer(String value) async {
    final conversation = _conversation;
    if (conversation == null || value == conversation.disappearingTimer) return;
    final previous = conversation.disappearingTimer;
    setState(
      () => _conversation = conversation.copyWith(disappearingTimer: value),
    );
    _restartDisappearingPruneTimer(value);
    try {
      await ref
          .read(conversationsApiProvider)
          .updateSettings(widget.conversationId, disappearingTimer: value);
    } on ApiException catch (e) {
      if (mounted) {
        setState(
          () => _conversation = conversation.copyWith(
            disappearingTimer: previous,
          ),
        );
        _restartDisappearingPruneTimer(previous);
        ScaffoldMessenger.of(
          context,
        ).showSnackBar(SnackBar(content: Text(e.message)));
      }
    }
  }

  /// Block/unblock (docs/13-roadmap.md) — mirrors apps/web's `BlockUserButton`
  /// exactly, including the confirm dialog and optimistic-then-revert shape.
  Future<void> _toggleBlock() async {
    final conversation = _conversation;
    if (conversation == null || conversation.otherUserId == null) return;
    final wasBlocked = conversation.callerHasBlockedOtherUser ?? false;
    final next = !wasBlocked;
    final displayName = conversation.displayTitle();

    final confirmed = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: Text(next ? 'Block $displayName?' : 'Unblock $displayName?'),
        content: next
            ? Text(
                "They won't be able to message or call you, and you won't be able to message or call them.",
              )
            : null,
        actions: [
          TextButton(
            onPressed: () => Navigator.of(context).pop(false),
            child: const Text('Cancel'),
          ),
          FilledButton(
            onPressed: () => Navigator.of(context).pop(true),
            child: Text(next ? 'Block' : 'Unblock'),
          ),
        ],
      ),
    );
    if (confirmed != true || !mounted) return;

    setState(
      () => _conversation = conversation.copyWith(
        callerHasBlockedOtherUser: next,
      ),
    );
    try {
      if (next) {
        await ref.read(blockingApiProvider).block(conversation.otherUsername!);
      } else {
        await ref.read(blockingApiProvider).unblock(conversation.otherUserId!);
      }
    } on ApiException catch (e) {
      if (mounted) {
        setState(
          () => _conversation = conversation.copyWith(
            callerHasBlockedOtherUser: wasBlocked,
          ),
        );
        ScaffoldMessenger.of(
          context,
        ).showSnackBar(SnackBar(content: Text(e.message)));
      }
    }
  }

  /// Attempts the normal live decrypt (per-device Double Ratchet or the shared
  /// group session, depending on `dto.envelopeType`) regardless of sender —
  /// including this account's OWN messages sent from a DIFFERENT device, which
  /// this device can genuinely decrypt live via self-fan-out/group key-sharing,
  /// same as anyone else's. Falls back to this account's own message-history-sync
  /// entry (docs/07-auth-architecture.md, history_sync.dart) when live decrypt
  /// fails or was never possible at all, and only shows the "[Could not decrypt]"
  /// placeholder if BOTH come up empty.
  ///
  /// `persist: false` skips the individual disk write and just returns the
  /// decrypted [CachedMessage] instead — `_load()`'s history catch-up uses this
  /// to batch every message from one page into a single write via
  /// `appendCachedMessages` rather than one read-modify-write per message (see
  /// that function's docstring). The live single-message path (`_onRealtimeNew`)
  /// leaves `persist` at its default; there's nothing to batch for one message.
  Future<CachedMessage?> _ingestIncoming(
    MessageDto dto, {
    bool retriedAfterKeySync = false,
    bool isLive = false,
    bool persist = true,
  }) async {
    final kek = getCurrentKek();
    if (kek == null) return null;

    if (dto.senderUserId == _myUserId) {
      _status[dto.id] = (
        delivered: dto.deliveredAt != null,
        read: dto.readAt != null,
      );
    }

    final isOwn = dto.senderUserId == _myUserId;
    String text = '';
    AttachmentDescriptor? attachment;
    String? mediaBase64;
    var decryptedLive = false;
    // Attempted regardless of sender, including this account's OWN messages sent
    // from a DIFFERENT device — self-fan-out (direct) / every member's device
    // being key-shared (group) means this device has a genuine live decrypt path
    // for those too, exactly like anyone else's message. Multi-device message
    // history sync (docs/07-auth-architecture.md, history_sync.dart) is the
    // fallback for whatever's left: a message this device was never a live
    // target for at all.
    if (dto.envelopeType == 'megolm_group') {
      final conversation = _conversation;
      final groupId = conversation?.groupId;
      if (groupId != null) {
        try {
          final envelope = EncryptedGroupEnvelope(
            header: dto.envelope.header,
            ciphertext: dto.envelope.ciphertext,
          );
          final plaintext = await ref
              .read(groupSessionControllerProvider)
              .decryptGroupMessageOnce(
                dto.id,
                groupId,
                dto.senderUserId,
                envelope,
              );
          final decoded = _decodeContent(dto.contentTypeHint, plaintext);
          text = decoded.text;
          attachment = decoded.attachment;
          mediaBase64 = decoded.mediaBase64;
          decryptedLive = true;
        } catch (e) {
          if (!retriedAfterKeySync) {
            // This device may simply not have the sender's group session yet (a
            // key-share that hasn't landed) — sync once and retry before giving up,
            // mirroring the TS provider's documented "try ensureGroupKeysUpToDate
            // and retry once" contract.
            await ref
                .read(groupSessionControllerProvider)
                .ensureGroupKeysUpToDate(groupId);
            return _ingestIncoming(
              dto,
              retriedAfterKeySync: true,
              isLive: isLive,
              persist: persist,
            );
          }
        }
      }
    } else {
      try {
        final envelope = MessageEnvelope(
          header: dto.envelope.header,
          ciphertext: dto.envelope.ciphertext,
        );
        final plaintext = await convo.decryptFromDeviceOnce(
          dto.id,
          dto.senderDeviceId,
          envelope,
          dto.x3dhInit,
        );
        final decoded = _decodeContent(dto.contentTypeHint, plaintext);
        text = decoded.text;
        attachment = decoded.attachment;
        mediaBase64 = decoded.mediaBase64;
        decryptedLive = true;
      } catch (e) {
        // Falls through to the history-key fallback below.
      }
    }

    CachedMessage cached;
    var resolved = decryptedLive;
    if (decryptedLive) {
      cached = CachedMessage(
        id: dto.id,
        conversationId: dto.conversationId,
        senderUserId: dto.senderUserId,
        isOwn: isOwn,
        contentTypeHint: dto.contentTypeHint,
        text: text,
        sentAt: dto.sentAt,
        replyToMessageId: dto.replyToMessageId,
        attachment: attachment,
        mediaBase64: mediaBase64,
        delivered: isOwn && dto.deliveredAt != null,
        read: isOwn && dto.readAt != null,
      );
    } else {
      final viaHistory = await tryDecryptViaHistory(dto.historyCiphertext);
      if (viaHistory != null) {
        cached = viaHistory;
        resolved = true;
      } else {
        cached = CachedMessage(
          id: dto.id,
          conversationId: dto.conversationId,
          senderUserId: dto.senderUserId,
          isOwn: isOwn,
          contentTypeHint: dto.contentTypeHint,
          text: '[Could not decrypt this message]',
          sentAt: dto.sentAt,
          replyToMessageId: dto.replyToMessageId,
        );
      }
    }
    if (persist) await appendCachedMessage(kek, cached);
    if (resolved) {
      // Idempotent no-op if some other of this account's own devices already
      // wrote this — see syncHistoryEntry's own docstring.
      unawaited(syncHistoryEntry(ref.read(historyApiProvider), cached));
    }
    if (mounted) {
      setState(() {
        if (!_messages.any((m) => m.id == cached.id)) _messages.add(cached);
        _messages.sort((a, b) => a.sentAt.compareTo(b.sentAt));
      });
      _scrollToBottom();
    }
    if (!isOwn) {
      // Deliberately NOT awaited — a best-effort receipt ping, same as
      // apps/web's own fire-and-forget call (message-thread.tsx). Awaiting this
      // was a real, found regression: it serialized one network round trip per
      // message while catching up a thread's history, one at a time.
      ref.read(messagesApiProvider).markDelivered(dto.id).catchError((_) {});
      if (isLive) {
        // The thread is actively open right now, so a live incoming message is
        // presumed read the instant it's ingested — matches web's message-thread.tsx
        // firing both /delivered and /read for a live 'new' event. The initial
        // history catch-up in _load() already sends ONE bulk markRead covering the
        // whole loaded page instead of repeating this per historical message.
        ref
            .read(conversationsApiProvider)
            .markRead(widget.conversationId, dto.id)
            .catchError((_) {});
        // A short local chime for "a message just landed in the chat you're
        // already looking at" — the one case that otherwise stays completely
        // silent: message_notifier.dart deliberately skips the system notification
        // (and its sound) for whichever conversation is currently open, so without
        // this, a live reply while this screen is on screen made no sound at all.
        unawaited(_playMessageChime());
      }
    }
    return cached;
  }

  /// Scrolls to the true bottom of the thread — not just "animate to whatever
  /// maxScrollExtent looks like right after this frame." `ListView.builder` only
  /// builds/measures items near wherever it's currently scrolled; on first mount
  /// that's the TOP, so everything below the initial viewport+cache extent is
  /// only an ESTIMATED height (`RenderSliverList` extrapolates from whatever's
  /// already been laid out) until the list actually scrolls close enough to
  /// build those items for real. A single scroll-then-done call trusts that
  /// estimate, which this app's genuinely mixed bubble heights (a one-line text
  /// message next to a 220px image/video bubble, `thread_screen.dart`'s
  /// `_MediaImageBubble`/`_MediaVideoBubble`) make unreliable for anything but a
  /// short thread — consistently landing short of the real bottom, exactly the
  /// reported "doesn't scroll all the way, I have to do it myself" bug.
  ///
  /// Fixed with a settle phase after the initial animated scroll: re-check
  /// `maxScrollExtent` on subsequent frames and jump again each time it grew,
  /// until it stops changing (the list has now actually built out to the true
  /// bottom) or a bounded number of attempts is spent — never an unbounded loop
  /// against a metric that could legitimately keep shifting (a live incoming
  /// message arriving during this same window).
  void _scrollToBottom() {
    Future<void> settle(int attemptsLeft, double lastExtent) async {
      await WidgetsBinding.instance.endOfFrame;
      if (!mounted || !_scrollController.hasClients || attemptsLeft <= 0) {
        return;
      }
      final extent = _scrollController.position.maxScrollExtent;
      if (extent == lastExtent) return; // stable — the true bottom was reached
      _scrollController.jumpTo(extent);
      await settle(attemptsLeft - 1, extent);
    }

    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!_scrollController.hasClients) return;
      final extent = _scrollController.position.maxScrollExtent;
      unawaited(
        _scrollController
            .animateTo(
              extent,
              duration: const Duration(milliseconds: 200),
              curve: Curves.easeOut,
            )
            .then((_) => settle(6, extent)),
      );
    });
  }

  Future<void> _send() async {
    final text = _textController.text.trim();
    if (text.isEmpty) return;
    _textController.clear();
    _notifyTyping(
      'stop',
    ); // matches web's handleSend — sending counts as "done typing"
    await _sendEnvelope(
      contentTypeHint: 'text',
      plaintext: utf8ToBytes(text),
      cacheText: text,
      restoreDraftOnFailure: text,
    );
  }

  /// Direct conversations only (see this file's typing-indicator section
  /// docstring). Fires 'start' on every keystroke and resets a 2-second
  /// inactivity timer that fires 'stop' — matches web's `notifyTyping`/
  /// `handleInputChange` (message-thread.tsx) exactly, including re-sending
  /// 'start' on every single change rather than throttling it further; the
  /// server itself is the one place this gets deduplicated/rate-limited if
  /// that ever matters (server/realtime/message-handlers.ts).
  void _notifyTyping(String state) {
    if (_conversation?.type != 'direct') return;
    ref.read(realtimeClientProvider).send({
      'type': 'typing.$state',
      'conversationId': widget.conversationId,
    });
  }

  void _onComposerTextChanged(String value) {
    _typingStopTimer?.cancel();
    _notifyTyping('start');
    _typingStopTimer = Timer(
      const Duration(seconds: 2),
      () => _notifyTyping('stop'),
    );
  }

  void _startReply(CachedMessage message) {
    setState(() => _replyingTo = message);
  }

  void _cancelReply() => setState(() => _replyingTo = null);

  /// Toggle: reacting with the same emoji already active for this user on this
  /// message removes it, any other emoji (including a first reaction) replaces
  /// it — see `_ReactionPayload`'s docstring. Goes through the exact same
  /// `_sendEnvelope` every other content type uses (full multi-device fan-out
  /// for free, no dedicated endpoint), so there's genuinely nothing
  /// reaction-specific about the send path itself.
  Future<void> _react(CachedMessage target, String emoji) async {
    final reactions =
        _buildReactionState(_messages, _myUserId)[target.id] ?? const [];
    final mine = _myReactionAmong(reactions);
    final next = mine == emoji ? null : emoji;
    final payload = jsonEncode({'targetMessageId': target.id, 'emoji': next});
    await _sendEnvelope(
      contentTypeHint: 'reaction',
      plaintext: utf8ToBytes(payload),
      cacheText: payload,
    );
  }

  /// Long-press a bubble — a quick-reaction emoji row (WhatsApp/Telegram's own
  /// long-press affordance) above Reply (any message) + Delete (own messages
  /// only, "delete for everyone," matching web's own `m.isOwn` gate on showing
  /// the button at all). Uses the same bottom-sheet pattern chats_list_screen.
  /// dart's own long-press menu already established, rather than a different
  /// one-off interaction just for this screen.
  void _showMessageActions(CachedMessage message) {
    HapticFeedback.selectionClick();
    showModalBottomSheet<void>(
      context: context,
      builder: (context) => SafeArea(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Padding(
              padding: const EdgeInsets.symmetric(vertical: 8),
              child: Row(
                mainAxisAlignment: MainAxisAlignment.spaceEvenly,
                children: [
                  for (final emoji in _quickReactionEmoji)
                    InkWell(
                      customBorder: const CircleBorder(),
                      onTap: () {
                        Navigator.of(context).pop();
                        _react(message, emoji);
                      },
                      child: Padding(
                        padding: const EdgeInsets.all(6),
                        child: Text(
                          emoji,
                          style: const TextStyle(fontSize: 26),
                        ),
                      ),
                    ),
                ],
              ),
            ),
            const Divider(height: 1),
            ListTile(
              leading: const Icon(Icons.reply),
              title: const Text('Reply'),
              onTap: () {
                Navigator.of(context).pop();
                _startReply(message);
              },
            ),
            ListTile(
              leading: const Icon(Icons.forward),
              title: const Text('Forward'),
              onTap: () {
                Navigator.of(context).pop();
                _openForwardSheet(message);
              },
            ),
            // Only meaningful when there's actual text to grab — a bare voice
            // note/photo/file with no caption has nothing for the clipboard.
            if (message.text.trim().isNotEmpty)
              ListTile(
                leading: const Icon(Icons.copy_outlined),
                title: const Text('Copy'),
                onTap: () {
                  Navigator.of(context).pop();
                  _copyMessageText(message);
                },
              ),
            ListTile(
              leading: Icon(
                _starredIds.contains(message.id)
                    ? Icons.star
                    : Icons.star_border,
                color: _starredIds.contains(message.id)
                    ? WhatsAppColors.tealAccent
                    : null,
              ),
              title: Text(_starredIds.contains(message.id) ? 'Unstar' : 'Star'),
              onTap: () {
                Navigator.of(context).pop();
                _toggleStar(message);
              },
            ),
            if (_conversation?.type == 'group' &&
                message.isOwn &&
                _conversation?.groupId != null)
              ListTile(
                leading: const Icon(Icons.done_all),
                title: const Text('Info'),
                onTap: () {
                  Navigator.of(context).pop();
                  _openMessageInfoSheet(message);
                },
              ),
            if (message.isOwn)
              ListTile(
                leading: Icon(
                  Icons.delete_outline,
                  color: Theme.of(context).colorScheme.error,
                ),
                title: Text(
                  'Delete',
                  style: TextStyle(color: Theme.of(context).colorScheme.error),
                ),
                onTap: () {
                  Navigator.of(context).pop();
                  _confirmAndDelete(message);
                },
              ),
          ],
        ),
      ),
    );
  }

  /// Uses this State's own `context` (not the bottom-sheet builder's shadowed
  /// one `_showMessageActions` closes over) — same reason `_confirmAndDelete`
  /// below is its own method rather than an inline closure: the builder's
  /// context is for a widget that's mid-removal by the time `onTap` runs its
  /// second statement, but this screen's own `context` stays valid underneath.
  void _openForwardSheet(CachedMessage message) {
    showForwardSheet(context, currentUserId: _myUserId, message: message);
  }

  /// Same context-lifetime reasoning as `_openForwardSheet` above.
  void _copyMessageText(CachedMessage message) {
    Clipboard.setData(ClipboardData(text: message.text));
    ScaffoldMessenger.of(
      context,
    ).showSnackBar(const SnackBar(content: Text('Message copied')));
  }

  /// Same context-lifetime reasoning as `_openForwardSheet` above.
  void _openMessageInfoSheet(CachedMessage message) {
    final groupId = _conversation?.groupId;
    if (groupId == null) return;
    showMessageInfoSheet(
      context,
      ref,
      groupId: groupId,
      messageId: message.id,
      currentUserId: _myUserId,
    );
  }

  /// Fired the instant a `view_once` bubble is first opened
  /// (`_ViewOnceImageBubble.onOpen`) — reuses the exact same DELETE endpoint
  /// `_confirmAndDelete` below does, now dual-authorized for a genuine
  /// recipient of a `view_once` message (see deleteMessage's own docstring,
  /// apps/web/server/modules/messages/service.ts). No confirmation dialog —
  /// opening it IS the confirmation, matching WhatsApp's own view-once UX.
  Future<void> _handleViewOnceOpened(String messageId) async {
    try {
      await ref.read(messagesApiProvider).delete(messageId);
    } on ApiException catch (_) {
      // Best-effort — worst case this device's own tombstone write lags a
      // beat; the sender's own delete (or apps/worker's media-retention
      // fallback sweep) still gets there eventually.
    }
    await _applyDeletion(messageId, 'viewed');
  }

  Future<void> _confirmAndDelete(CachedMessage message) async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Delete this message?'),
        content: const Text(
          'This removes it for everyone in this conversation.',
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
    if (confirmed != true || !mounted) return;

    try {
      await ref.read(messagesApiProvider).delete(message.id);
      await _applyDeletion(message.id, 'manual');
    } on ApiException catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(
          context,
        ).showSnackBar(SnackBar(content: Text(e.message)));
      }
    }
  }

  /// Auto-stops (and sends) a recording at this length — mirrors web's own
  /// `MAX_RECORDING_SECONDS` (message-thread.tsx) exactly, keeping a voice note
  /// comfortably under the envelope's size ceiling for the same reason web's
  /// docstring gives: this rides the same inline-ciphertext field a text
  /// message does (no object storage — see `_startVoiceRecording`), which has
  /// real headroom but isn't unlimited.
  static const _maxRecordingSeconds = 120;

  /// Records raw audio and sends it through the exact same E2E envelope text
  /// already uses (`contentTypeHint: 'voice'`, no object storage, no signed
  /// upload) — matches apps/web/components/chat/message-thread.tsx's own
  /// MediaRecorder-based voice notes protocol-for-protocol.
  ///
  /// Format choice: AAC-LC in an MPEG-4 (.m4a) container — the `record`
  /// package's own default, and deliberately not matched to web's WebM/Opus.
  /// AAC is natively decodable by both Android's ExoPlayer (what this app's
  /// player, `audioplayers`, uses under the hood) and iOS's AVFoundation,
  /// which Opus is not — so a voice note recorded here is exactly as playable
  /// on a future iOS build as it is here, at the cost of relying on
  /// ExoPlayer's own content-sniffing (not just the file extension) to
  /// correctly decode a WebM/Opus note arriving FROM the web client, since
  /// there's no per-message format tag in the wire protocol to negotiate this
  /// explicitly — the same implicit-format assumption the web client alone
  /// already made before there was a second client to consider.
  Future<void> _startVoiceRecording() async {
    final granted = await _voiceRecorder.hasPermission();
    if (!granted) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(
            content: Text(
              "Microphone access was denied — check this phone's app permissions to send a voice message.",
            ),
          ),
        );
      }
      return;
    }

    final dir = await getTemporaryDirectory();
    final path = '${dir.path}/comm-voice-${_uuid.v4()}.m4a';
    await _voiceRecorder.start(
      const RecordConfig(
        encoder: AudioEncoder.aacLc,
        bitRate: 32000,
        numChannels: 1,
      ),
      path: path,
    );
    if (!mounted) return;
    setState(() {
      _isRecordingVoice = true;
      _recordingSeconds = 0;
    });
    _recordingTimer = Timer.periodic(const Duration(seconds: 1), (_) {
      if (!mounted) return;
      setState(() => _recordingSeconds++);
      if (_recordingSeconds >= _maxRecordingSeconds) {
        _stopAndSendVoiceRecording();
      }
    });
  }

  Future<void> _stopAndSendVoiceRecording() async {
    _recordingTimer?.cancel();
    _recordingTimer = null;
    final durationSec = _recordingSeconds;
    final path = await _voiceRecorder.stop();
    if (mounted) setState(() => _isRecordingVoice = false);
    if (path == null) return;

    final file = File(path);
    if (!await file.exists()) return;
    final bytes = await file.readAsBytes();
    try {
      await file
          .delete(); // best-effort — the sent copy now lives in the encrypted message cache
    } catch (_) {
      // Not fatal — a leftover scratch file in the OS temp dir, which gets
      // reclaimed by the platform on its own schedule regardless.
    }
    if (bytes.isEmpty) return;

    await _sendEnvelope(
      contentTypeHint: 'voice',
      plaintext: bytes,
      cacheText: '',
      cacheMediaBase64: bytesToBase64(bytes),
      cacheMediaDurationSec: durationSec,
    );
  }

  Future<void> _cancelVoiceRecording() async {
    _recordingTimer?.cancel();
    _recordingTimer = null;
    await _voiceRecorder.cancel(); // stops AND deletes the underlying file
    if (mounted) setState(() => _isRecordingVoice = false);
  }

  Future<void> _sendFile(
    Uint8List bytes,
    String fileName,
    String mimeType,
  ) async {
    setState(() => _sending = true);
    try {
      final encrypted = await attach_crypto.encryptAttachment(bytes);
      final uploaded = await ref
          .read(mediaApiProvider)
          .uploadAttachmentCiphertext(encrypted.ciphertext);
      final descriptor = AttachmentDescriptor(
        objectKey: uploaded.objectKey,
        key: bytesToBase64(encrypted.key),
        nonce: bytesToBase64(encrypted.nonce),
        mimeType: mimeType,
        fileName: fileName,
        sizeBytes: bytes.length,
      );
      await _sendEnvelope(
        contentTypeHint: 'media',
        plaintext: utf8ToBytes(jsonEncode(descriptor.toJson())),
        cacheText: '',
        cacheAttachment: descriptor,
        attachmentRef: MessageAttachmentRef(
          objectKey: uploaded.objectKey,
          encryptedSizeBytes: uploaded.encryptedSizeBytes,
        ),
      );
    } on ApiException catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(
          context,
        ).showSnackBar(SnackBar(content: Text(e.message)));
      }
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(
          context,
        ).showSnackBar(SnackBar(content: Text('Could not send that file: $e')));
      }
    } finally {
      if (mounted) setState(() => _sending = false);
    }
  }

  /// Shared by `_send`/`_sendFile` — resolves the recipient(s), runs the real
  /// encrypt (X3DH/Double Ratchet for a direct conversation, the group ratchet via
  /// `GroupSessionController` for a group one), renders the message locally the
  /// instant the envelope is ready, THEN sends via REST in the background.
  ///
  /// That ordering is the fix for "sending feels slow, not instant like the
  /// website": this used to await the full POST round trip before the message
  /// ever appeared in `_messages` at all, so every send paid a full network
  /// round trip of visible latency. apps/web's own `sendEncrypted`
  /// (message-thread.tsx) never did that — it renders an optimistic bubble
  /// (with a clock/pending tick) the moment encryption finishes, then sends, and
  /// only rolls the bubble back out if the send actually fails. This mirrors
  /// that exactly: this device already holds the plaintext post-encryption,
  /// there's nothing left to wait on before showing it.
  Future<void> _sendEnvelope({
    required String contentTypeHint,
    required Uint8List plaintext,
    required String cacheText,
    AttachmentDescriptor? cacheAttachment,
    MessageAttachmentRef? attachmentRef,
    String? restoreDraftOnFailure,
    String? cacheMediaBase64,
    int? cacheMediaDurationSec,
  }) async {
    final conversation = _conversation;
    if (conversation == null) return;
    final kek = getCurrentKek();
    if (kek == null) return;

    final messageId = _uuid.v4();
    final sentAt = DateTime.now().toUtc().toIso8601String();
    final replyToMessageId = _replyingTo?.id;
    if (_replyingTo != null) setState(() => _replyingTo = null);

    setState(() => _sending = true);
    try {
      final SendMessageRequest req;
      if (conversation.type == 'group') {
        final groupId = conversation.groupId;
        if (groupId == null) throw StateError('Missing group id.');
        final encrypted = await ref
            .read(groupSessionControllerProvider)
            .encryptForGroup(groupId, _myUserId, plaintext);
        req = SendMessageRequest(
          messageId: messageId,
          envelopeType: 'megolm_group',
          envelope: MessageEnvelopeUpload(
            header: encrypted.header,
            ciphertext: encrypted.ciphertext,
          ),
          x3dhInit:
              null, // group key material moves via the separate key-share channel, not per-message
          contentTypeHint: contentTypeHint,
          replyToMessageId: replyToMessageId,
          sentAt: sentAt,
          attachment: attachmentRef,
        );
      } else {
        // Falls back to a fresh fetch only if the cached list is somehow missing
        // (e.g. a send racing the very first _load()) — the normal path reuses what
        // _load() already resolved, see _targetDevices' own docstring.
        var targets = _targetDevices;
        if (targets.isEmpty) {
          final otherMemberDevices = await ref
              .read(conversationsApiProvider)
              .recipientDevices(widget.conversationId);
          final ownDevices = await ref.read(devicesApiProvider).list();
          final ownOtherDevices = ownDevices
              .where((d) => !d.isCurrentDevice && d.status == 'active')
              .map((d) => (userId: _myUserId, deviceId: d.id));
          targets = _targetDevices = [
            ...otherMemberDevices,
            ...ownOtherDevices,
          ];
        }
        if (targets.isEmpty) {
          throw StateError(
            'The other person has no reachable device right now.',
          );
        }

        // One independent envelope per target device — real multi-device sync, not
        // just delivery to whichever single device used to be guessed as
        // "primary." encryptForDevice is safe to call any number of times.
        final recipients = <RecipientEnvelope>[];
        for (final target in targets) {
          final outgoing = await convo.encryptForDevice(
            ref.read(keysApiProvider),
            target.userId,
            target.deviceId,
            plaintext,
          );
          recipients.add(
            RecipientEnvelope(
              deviceId: target.deviceId,
              envelope: MessageEnvelopeUpload(
                header: outgoing.envelope.header,
                ciphertext: outgoing.envelope.ciphertext,
              ),
              x3dhInit: outgoing.x3dhInit,
            ),
          );
        }
        req = SendMessageRequest(
          messageId: messageId,
          envelopeType: 'x3dh_ratchet_1to1',
          recipients: recipients,
          contentTypeHint: contentTypeHint,
          replyToMessageId: replyToMessageId,
          sentAt: sentAt,
          attachment: attachmentRef,
        );
      }

      // Render now — see this method's own docstring for why this happens
      // before the POST, not after.
      final cached = CachedMessage(
        id: messageId,
        conversationId: widget.conversationId,
        senderUserId: _myUserId,
        isOwn: true,
        contentTypeHint: contentTypeHint,
        text: cacheText,
        sentAt: sentAt,
        replyToMessageId: replyToMessageId,
        attachment: cacheAttachment,
        mediaBase64: cacheMediaBase64,
        mediaDurationSec: cacheMediaDurationSec,
      );
      await appendCachedMessage(kek, cached);
      if (mounted) {
        setState(() {
          _messages.add(cached);
          _pendingIds.add(messageId);
        });
        _scrollToBottom();
      }
      // Multi-device message history sync (docs/07-auth-architecture.md) — the
      // sender already has the plaintext right here, no decrypt needed.
      unawaited(syncHistoryEntry(ref.read(historyApiProvider), cached));

      await ref.read(messagesApiProvider).send(widget.conversationId, req);
      if (mounted) setState(() => _pendingIds.remove(messageId));
    } on ApiException catch (e) {
      await _rollbackFailedSend(kek, messageId, restoreDraftOnFailure);
      if (mounted) {
        ScaffoldMessenger.of(
          context,
        ).showSnackBar(SnackBar(content: Text(e.message)));
      }
    } catch (e) {
      await _rollbackFailedSend(kek, messageId, restoreDraftOnFailure);
      if (mounted) {
        ScaffoldMessenger.of(
          context,
        ).showSnackBar(SnackBar(content: Text('Could not send: $e')));
      }
    } finally {
      if (mounted) setState(() => _sending = false);
    }
  }

  /// Takes back an optimistically-rendered bubble that turned out to have never
  /// actually sent — see [_sendEnvelope]. A no-op if the failure happened before
  /// the optimistic render (e.g. no reachable recipient device), same as web's
  /// equivalent rollback.
  Future<void> _rollbackFailedSend(
    Uint8List kek,
    String messageId,
    String? restoreDraftOnFailure,
  ) async {
    await removeCachedMessage(kek, widget.conversationId, messageId);
    if (mounted) {
      setState(() {
        _messages.removeWhere((m) => m.id == messageId);
        _pendingIds.remove(messageId);
      });
    }
    if (restoreDraftOnFailure != null && mounted) {
      _textController.text = restoreDraftOnFailure;
    }
  }

  Future<void> _pickAndSendPhoto() async {
    final picked = await ImagePicker().pickImage(
      source: ImageSource.gallery,
      imageQuality: 90,
      // A modern phone photo is easily 4000x3000+; nothing in this app's UI
      // ever displays one wider than the screen, and this pipeline still
      // has to encrypt, upload, and later download+decrypt every byte of it.
      // Capping the longest side at 1600 (well above what any bubble or the
      // fullscreen viewer needs on a real device) keeps quality genuinely
      // indistinguishable on-screen while cutting typical payload size
      // dramatically on top of `imageQuality`'s own re-encode.
      maxWidth: 1600,
      maxHeight: 1600,
    );
    if (picked == null) return;
    final bytes = await picked.readAsBytes();
    await _sendFile(bytes, picked.name, picked.mimeType ?? 'image/jpeg');
  }

  /// A view-once photo (docs/13-roadmap.md) rides the SAME inline-envelope
  /// path web's own `view_once` send does (message-thread.tsx's
  /// `sendEncrypted`), not the object-storage `media` pipeline
  /// `_pickAndSendPhoto` above uses — the two clients must agree on the wire
  /// format for a shared `contentTypeHint`, and web's is raw bytes, not a
  /// descriptor. `imageQuality: 70` here (vs. 90 for a regular photo) is this
  /// client's stand-in for web's real client-side re-encode/downscale
  /// (`compressImageForSend`) — a coarser, honestly-simpler way of keeping a
  /// typical phone photo comfortably under the same ~4 MiB envelope
  /// ciphertext ceiling every inline send shares
  /// (packages/types/src/messages.ts's `CiphertextBase64`), not a guarantee
  /// for every possible source image.
  static const _maxViewOnceBytes = 2621440; // 2.5 MiB, matches web's own cap

  Future<void> _pickAndSendViewOncePhoto() async {
    final picked = await ImagePicker().pickImage(
      source: ImageSource.gallery,
      imageQuality: 70,
      // Same reasoning as `_pickAndSendPhoto`'s own `maxWidth`/`maxHeight`,
      // more important here: this path's whole point is staying under
      // `_maxViewOnceBytes`, and downscaling resolution buys far more of
      // that budget than `imageQuality` alone ever could for a full-res
      // source photo.
      maxWidth: 1600,
      maxHeight: 1600,
    );
    if (picked == null) return;
    final bytes = await picked.readAsBytes();
    if (bytes.length > _maxViewOnceBytes) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(
            content: Text(
              'That photo is too large to send as view-once — try a smaller one.',
            ),
          ),
        );
      }
      return;
    }
    await _sendEnvelope(
      contentTypeHint: 'view_once',
      plaintext: bytes,
      cacheText: '',
      cacheMediaBase64: bytesToBase64(bytes),
    );
  }

  Future<void> _pickAndSendFile() async {
    final result = await FilePicker.platform.pickFiles(withData: true);
    final picked = result?.files.single;
    if (picked?.bytes == null) return;
    await _sendFile(picked!.bytes!, picked.name, 'application/octet-stream');
  }

  /// Downloads + decrypts a `media` attachment's ciphertext exactly once per
  /// objectKey for the life of this screen, memoized so every caller (the eager
  /// image-thumbnail fetch, a tapped video, the "save to disk" file row) shares
  /// one in-flight/completed result instead of each re-downloading the same
  /// object. A failed attempt is evicted (not cached forever) so a later retry —
  /// `_MediaImageBubble`'s tap-to-retry, or just tapping the file row again —
  /// genuinely re-fetches rather than replaying the same error indefinitely.
  Future<Uint8List> _ensureMediaDecrypted(AttachmentDescriptor descriptor) {
    final cached = _mediaFutures[descriptor.objectKey];
    if (cached != null) return cached;

    final future = () async {
      final ciphertext = await ref
          .read(mediaApiProvider)
          .downloadAttachmentCiphertext(descriptor.objectKey);
      return attach_crypto.decryptAttachment(
        ciphertext,
        base64ToBytes(descriptor.key),
        base64ToBytes(descriptor.nonce),
      );
    }();
    _mediaFutures[descriptor.objectKey] = future;
    // Side-effect-only listener on the same Future instance — does not replace
    // what other listeners (FutureBuilder, the try/catch below) see or receive.
    unawaited(
      future.then((_) {}, onError: (_) => _mediaFutures.remove(descriptor.objectKey)),
    );
    return future;
  }

  Future<void> _downloadAttachment(AttachmentDescriptor descriptor) async {
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(content: Text('Downloading ${descriptor.fileName}…')),
    );
    try {
      final plaintext = await _ensureMediaDecrypted(descriptor);

      final dir = await getApplicationDocumentsDirectory();
      final savedDir = Directory('${dir.path}/comm-downloads')
        ..createSync(recursive: true);
      final file = File('${savedDir.path}/${descriptor.fileName}');
      await file.writeAsBytes(plaintext);

      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text('Saved ${descriptor.fileName} to app storage'),
          ),
        );
      }
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(
          context,
        ).showSnackBar(SnackBar(content: Text('Could not download: $e')));
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final conversation = _conversation;
    final isGroup =
        conversation != null &&
        conversation.type == 'group' &&
        conversation.groupId != null;
    // Mirrors apps/web's own subtitle exactly (app/(app)/chats/[id]/page.tsx):
    // the disappearing-timer state takes over the normal @username/member-count
    // line whenever it's active, rather than being shown alongside it.
    final subtitle = conversation == null
        ? null
        : conversation.disappearingTimer != 'off'
        ? 'Disappearing: ${_disappearingTimerLabel(conversation.disappearingTimer)}'
        : (conversation.type == 'direct'
              ? (conversation.otherUsername != null
                    ? '@${conversation.otherUsername}'
                    : null)
              : '${conversation.groupMemberCount ?? 0} member${conversation.groupMemberCount == 1 ? '' : 's'}');
    final searchMatches = _computeSearchMatches(
      _searchQuery.trim().toLowerCase(),
    );
    return Scaffold(
      appBar: AppBar(
        title: _searchOpen
            ? TextField(
                controller: _searchController,
                autofocus: true,
                style: const TextStyle(color: Colors.white),
                decoration: const InputDecoration(
                  hintText: 'Search in this chat',
                  hintStyle: TextStyle(color: Colors.white70),
                  border: InputBorder.none,
                ),
                onChanged: _onSearchChanged,
              )
            : InkWell(
                onTap: isGroup
                    ? () => context.push('/groups/${conversation.groupId}/info')
                    : null,
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Text(conversation?.displayTitle() ?? 'Chat'),
                    if (subtitle != null)
                      Text(
                        subtitle,
                        style: const TextStyle(
                          fontSize: 12,
                          fontWeight: FontWeight.normal,
                          color: Colors.white70,
                        ),
                      ),
                  ],
                ),
              ),
        actions: [
          if (_searchOpen) ...[
            if (_searchQuery.trim().isNotEmpty)
              Padding(
                padding: const EdgeInsets.symmetric(horizontal: 4),
                child: Center(
                  child: Text(
                    '${searchMatches.isNotEmpty ? _searchIndex + 1 : 0} / ${searchMatches.length}',
                    style: const TextStyle(fontSize: 12, color: Colors.white70),
                  ),
                ),
              ),
            IconButton(
              icon: const Icon(Icons.keyboard_arrow_up),
              tooltip: 'Previous match (older)',
              onPressed: searchMatches.isEmpty
                  ? null
                  : () => _moveSearch(-1, searchMatches),
            ),
            IconButton(
              icon: const Icon(Icons.keyboard_arrow_down),
              tooltip: 'Next match (newer)',
              onPressed: searchMatches.isEmpty
                  ? null
                  : () => _moveSearch(1, searchMatches),
            ),
            IconButton(
              icon: const Icon(Icons.close),
              tooltip: 'Close search',
              onPressed: _closeSearch,
            ),
          ] else ...[
            IconButton(
              icon: const Icon(Icons.search),
              tooltip: 'Search in this chat',
              onPressed: () => setState(() => _searchOpen = true),
            ),
          ],
          if (conversation != null)
            PopupMenuButton<String>(
              tooltip: 'Disappearing messages',
              icon: Icon(
                Icons.timer_outlined,
                color: conversation.disappearingTimer != 'off'
                    ? WhatsAppColors.green
                    : Colors.white,
              ),
              onSelected: _setDisappearingTimer,
              itemBuilder: (context) => _disappearingTimerOptions
                  .map(
                    (opt) => PopupMenuItem(
                      value: opt.$1,
                      child: Row(
                        mainAxisAlignment: MainAxisAlignment.spaceBetween,
                        children: [
                          Text(opt.$2),
                          if (conversation.disappearingTimer == opt.$1)
                            const Icon(
                              Icons.check,
                              size: 18,
                              color: WhatsAppColors.tealAccent,
                            ),
                        ],
                      ),
                    ),
                  )
                  .toList(),
            ),
          if (conversation != null &&
              conversation.type == 'direct' &&
              conversation.otherUserId != null)
            IconButton(
              icon: Icon(
                Icons.block,
                color: (conversation.callerHasBlockedOtherUser ?? false)
                    ? Theme.of(context).colorScheme.error
                    : null,
              ),
              tooltip: (conversation.callerHasBlockedOtherUser ?? false)
                  ? 'Unblock'
                  : 'Block',
              onPressed: _toggleBlock,
            ),
          if (conversation != null &&
              conversation.type == 'direct' &&
              conversation.otherUserId != null)
            IconButton(
              icon: const Icon(Icons.call),
              tooltip: 'Call',
              onPressed: () => ref
                  .read(callControllerProvider.notifier)
                  .startCall(
                    widget.conversationId,
                    conversation.otherUserId!,
                    conversation.displayTitle(),
                  ),
            ),
          if (isGroup)
            IconButton(
              icon: const Icon(Icons.call),
              tooltip: 'Start group call',
              onPressed: () => ref
                  .read(groupCallControllerProvider.notifier)
                  .startGroupCall(
                    widget.conversationId,
                    conversation.displayTitle(),
                  ),
            ),
          if (isGroup)
            IconButton(
              icon: const Icon(Icons.info_outline),
              tooltip: 'Group info',
              onPressed: () =>
                  context.push('/groups/${conversation.groupId}/info'),
            ),
        ],
      ),
      // WhatsApp's chat-thread background is a flat tan/beige behind the bubbles,
      // distinct from the white chat-list/app-shell background — Scaffold's own
      // backgroundColor is set per-screen here rather than globally for that reason.
      backgroundColor: WhatsAppColors.chatBackground,
      body: SafeArea(child: _buildBody()),
    );
  }

  Widget _buildBody() {
    if (_loading) return const Center(child: CircularProgressIndicator());
    if (_error != null) return ErrorState(message: _error!, onRetry: _retry);

    // Keyed once per build so `_MessageBubble` can render a quoted snippet for
    // any message that's a reply, without every bubble re-scanning the whole
    // list itself — cheap given the 500-message-per-conversation cache cap.
    final messagesById = {for (final m in _messages) m.id: m};

    // `reaction` rows are cached alongside everything else but never rendered
    // as their own bubble — see `_ReactionPayload`'s docstring. `visibleMessages`
    // is what the list actually iterates; `reactionState` folds every reaction
    // row into per-target pill summaries instead.
    final visibleMessages = _messages
        .where((m) => m.contentTypeHint != 'reaction')
        .toList(growable: false);
    final reactionState = _buildReactionState(_messages, _myUserId);

    final normalizedSearchQuery = _searchQuery.trim().toLowerCase();
    final searchMatches = _computeSearchMatches(normalizedSearchQuery);
    final activeSearchMatchId = _searchOpen && searchMatches.isNotEmpty
        ? searchMatches[_searchIndex.clamp(0, searchMatches.length - 1)]
        : null;

    // Typing indicator renders as a trailing list item, not a widget bolted on
    // outside the ListView — that keeps it scrolling into view with everything
    // else instead of needing its own separate layout/visibility logic.
    final showTyping = _otherTyping && _conversation?.type == 'direct';
    final itemCount = visibleMessages.length + (showTyping ? 1 : 0);

    return Column(
      children: [
        Expanded(
          child: visibleMessages.isEmpty && !showTyping
              ? const EmptyState(
                  icon: Icons.chat_bubble_outline,
                  message: 'No messages yet — say hello.',
                )
              : ListView.builder(
                  controller: _scrollController,
                  padding: const EdgeInsets.all(12),
                  itemCount: itemCount,
                  itemBuilder: (context, index) {
                    if (index == visibleMessages.length) {
                      return const _TypingIndicatorBubble();
                    }
                    final message = visibleMessages[index];
                    return _MessageBubble(
                      key: _keyFor(message.id),
                      message: message,
                      onDownload: _downloadAttachment,
                      ensureMediaDecrypted: _ensureMediaDecrypted,
                      status: _status[message.id],
                      pending: _pendingIds.contains(message.id),
                      replySource: message.replyToMessageId != null
                          ? messagesById[message.replyToMessageId]
                          : null,
                      onLongPress: message.deleted
                          ? null
                          : () => _showMessageActions(message),
                      reactions: reactionState[message.id] ?? const [],
                      onReactTap: (emoji) => _react(message, emoji),
                      searchQuery: _searchOpen ? normalizedSearchQuery : '',
                      isActiveSearchMatch: message.id == activeSearchMatchId,
                      starred: _starredIds.contains(message.id),
                      onViewOnceOpen: (id) => _handleViewOnceOpened(id),
                    );
                  },
                ),
        ),
        // The compose bar sits on its own white strip above the keyboard, same as
        // WhatsApp — distinct from the beige thread background behind it.
        Container(
          color: WhatsAppColors.listBackground,
          child: SafeArea(
            top: false,
            child: Column(
              children: [
                // Reply-in-progress preview — mirrors web's own strip above the
                // composer (message-thread.tsx), cleared either by the X here or
                // automatically the instant a send actually starts (_sendEnvelope).
                if (_replyingTo != null)
                  _ReplyPreview(
                    message: _replyingTo!,
                    otherName: _conversation?.displayTitle() ?? '',
                    onCancel: _cancelReply,
                  ),
                Padding(
                  padding: const EdgeInsets.symmetric(
                    horizontal: 8,
                    vertical: 8,
                  ),
                  child: _isRecordingVoice
                      ? _buildRecordingRow()
                      : Row(
                          crossAxisAlignment: CrossAxisAlignment.end,
                          children: [
                            PopupMenuButton<String>(
                              enabled: !_sending,
                              icon: const Icon(
                                Icons.attach_file,
                                color: WhatsAppColors.tealAccent,
                              ),
                              onSelected: (choice) => switch (choice) {
                                'photo' => _pickAndSendPhoto(),
                                'view_once' => _pickAndSendViewOncePhoto(),
                                _ => _pickAndSendFile(),
                              },
                              itemBuilder: (context) => [
                                const PopupMenuItem(
                                  value: 'photo',
                                  child: ListTile(
                                    leading: Icon(Icons.photo),
                                    title: Text('Photo'),
                                  ),
                                ),
                                // 1:1 only — view-once needs a single global
                                // "opened" state that doesn't generalize
                                // cleanly to a group's several recipients
                                // (deleteMessage's own docstring).
                                if (_conversation?.type == 'direct')
                                  const PopupMenuItem(
                                    value: 'view_once',
                                    child: ListTile(
                                      leading: Icon(
                                        Icons.remove_red_eye_outlined,
                                      ),
                                      title: Text('View once photo'),
                                    ),
                                  ),
                                const PopupMenuItem(
                                  value: 'file',
                                  child: ListTile(
                                    leading: Icon(Icons.attach_file),
                                    title: Text('File'),
                                  ),
                                ),
                              ],
                            ),
                            Expanded(
                              child: Container(
                                constraints: const BoxConstraints(
                                  minHeight: 44,
                                ),
                                padding: const EdgeInsets.symmetric(
                                  horizontal: 16,
                                ),
                                decoration: BoxDecoration(
                                  color: const Color(0xFFF0F0F0),
                                  borderRadius: BorderRadius.circular(24),
                                ),
                                child: TextField(
                                  controller: _textController,
                                  decoration: const InputDecoration(
                                    hintText: 'Message',
                                    border: InputBorder.none,
                                    isCollapsed: true,
                                  ),
                                  style: const TextStyle(
                                    color: WhatsAppColors.bubbleText,
                                  ),
                                  minLines: 1,
                                  maxLines: 5,
                                  textInputAction: TextInputAction.send,
                                  onChanged: _onComposerTextChanged,
                                  onSubmitted: (_) => _send(),
                                ),
                              ),
                            ),
                            const SizedBox(width: 8),
                            // Round green button — WhatsApp's own shape, not the
                            // square filled-icon-button Material default. Swaps
                            // between mic (empty composer — tap to record a
                            // voice note) and send (there's text to send),
                            // matching WhatsApp's own composer exactly. Scoped
                            // to just this button via ValueListenableBuilder
                            // (TextEditingController is itself a
                            // ValueListenable) rather than a whole-screen
                            // setState on every keystroke.
                            ValueListenableBuilder<TextEditingValue>(
                              valueListenable: _textController,
                              builder: (context, value, _) {
                                final hasText = value.text.trim().isNotEmpty;
                                return Material(
                                  color: WhatsAppColors.green,
                                  shape: const CircleBorder(),
                                  child: InkWell(
                                    customBorder: const CircleBorder(),
                                    onTap: _sending
                                        ? null
                                        : (hasText
                                              ? _send
                                              : _startVoiceRecording),
                                    child: Padding(
                                      padding: const EdgeInsets.all(10),
                                      child: _sending
                                          ? const SizedBox(
                                              width: 20,
                                              height: 20,
                                              child: CircularProgressIndicator(
                                                strokeWidth: 2,
                                                color: Colors.white,
                                              ),
                                            )
                                          : Icon(
                                              hasText ? Icons.send : Icons.mic,
                                              color: Colors.white,
                                              size: 20,
                                            ),
                                    ),
                                  ),
                                );
                              },
                            ),
                          ],
                        ),
                ),
              ],
            ),
          ),
        ),
      ],
    );
  }

  /// Replaces the normal text-field row while `_isRecordingVoice` — a red dot +
  /// live elapsed time (mirrors web's own recording indicator, message-
  /// thread.tsx), a trash button to discard, and the round button repurposed
  /// as "stop and send." No slide-to-cancel gesture (WhatsApp's own
  /// press-and-hold affordance) — this is deliberately tap-to-start/tap-to-stop
  /// instead, a simpler and equally legitimate mobile pattern, not a hidden
  /// corner cut: press-and-hold-with-slide-to-cancel is a real, separate
  /// gesture to get right and verify, and this app has no way to test it on a
  /// real device from where it's built.
  Widget _buildRecordingRow() {
    final minutes = (_recordingSeconds ~/ 60).toString().padLeft(2, '0');
    final seconds = (_recordingSeconds % 60).toString().padLeft(2, '0');
    return Row(
      crossAxisAlignment: CrossAxisAlignment.center,
      children: [
        IconButton(
          icon: const Icon(Icons.delete_outline, color: Color(0xFF667781)),
          tooltip: 'Cancel recording',
          onPressed: _cancelVoiceRecording,
        ),
        const SizedBox(width: 4),
        Container(
          width: 10,
          height: 10,
          decoration: const BoxDecoration(
            color: Colors.red,
            shape: BoxShape.circle,
          ),
        ),
        const SizedBox(width: 8),
        Text(
          '$minutes:$seconds',
          style: const TextStyle(
            color: WhatsAppColors.bubbleText,
            fontFeatures: [FontFeature.tabularFigures()],
          ),
        ),
        const Expanded(
          child: Padding(
            padding: EdgeInsets.symmetric(horizontal: 12),
            child: Text(
              'Recording voice message…',
              style: TextStyle(color: Color(0xFF667781), fontSize: 13),
            ),
          ),
        ),
        Material(
          color: WhatsAppColors.green,
          shape: const CircleBorder(),
          child: InkWell(
            customBorder: const CircleBorder(),
            onTap: _stopAndSendVoiceRecording,
            child: const Padding(
              padding: EdgeInsets.all(10),
              child: Icon(Icons.send, color: Colors.white, size: 20),
            ),
          ),
        ),
      ],
    );
  }
}

/// Which tick to show on an OWN message — sending (clock, still an optimistic
/// local bubble with no server confirmation yet), sent (single check), delivered
/// (double check), or read (double check, blue). Pulled out of the widget as a
/// pure function specifically so the precedence rule (read implies delivered
/// even if a `delivered` event was somehow missed/reordered — the read receipt
/// is the stronger signal) is unit-testable without pumping a widget tree.
enum TickState { sending, sent, delivered, read }

TickState tickStateFor(
  ({bool delivered, bool read})? status, {
  bool pending = false,
}) {
  if (pending) return TickState.sending;
  if (status == null) return TickState.sent;
  if (status.read) return TickState.read;
  if (status.delivered) return TickState.delivered;
  return TickState.sent;
}

String _formatBubbleTime(String iso) {
  final dt = DateTime.tryParse(iso)?.toLocal();
  if (dt == null) return '';
  final h = dt.hour.toString().padLeft(2, '0');
  final m = dt.minute.toString().padLeft(2, '0');
  return '$h:$m';
}

/// Mirrors web's own `OPTIONS` (disappearing-timer-menu.tsx) — 'off' first
/// (the default/most common state), then ascending duration.
const _disappearingTimerOptions = [
  ('off', 'Off'),
  ('h24', '24 hours'),
  ('d7', '7 days'),
  ('d30', '30 days'),
];

String _disappearingTimerLabel(String value) => _disappearingTimerOptions
    .firstWhere((o) => o.$1 == value, orElse: () => (value, value))
    .$2;

/// The one place "h24 means 24 hours" is spelled out on this client — mirrors
/// `packages/types/src/messages.ts`'s `disappearingTimerToMs` exactly (mobile
/// has no shared-types package to import from, unlike web/worker, so this is
/// duplicated deliberately rather than left to drift silently: any change to
/// the enum's meaning needs updating here too). `null` = never expires.
int? disappearingTimerToMs(String timer) {
  switch (timer) {
    case 'h24':
      return 24 * 60 * 60 * 1000;
    case 'd7':
      return 7 * 24 * 60 * 60 * 1000;
    case 'd30':
      return 30 * 24 * 60 * 60 * 1000;
    default:
      return null; // 'off', or anything unrecognized — fail closed to "never expires"
  }
}

/// Mirrors web's `deletedPlaceholderText` (lib/message-content.ts) exactly,
/// adapted to mobile's own content-type vocabulary (see _replyPreviewText's
/// docstring on why there's no separate 'image' case here).
String deletedPlaceholderText(String contentTypeHint, String? deletedReason) {
  if (deletedReason == 'account_deleted') return 'This message is from a deleted account';
  if (deletedReason != 'media_retention') return 'This message was deleted';
  if (contentTypeHint == 'voice') return 'This voice message has expired';
  if (contentTypeHint == 'media') return 'This file has expired';
  return 'This message was deleted';
}

/// Short one-line label for a message being quoted — as a reply target in the
/// composer preview, or as the quoted snippet inside a bubble that's itself a
/// reply. Mirrors web's inline switch on `contentTypeHint` in message-thread.tsx
/// (the `replySource`/`replyingTo` preview text), adapted to what mobile
/// actually distinguishes: unlike web, mobile doesn't have a separate 'image'
/// content type — a photo sent from the gallery picker is still 'media' with an
/// image/* attachment mimeType, so that's sniffed here instead.
String _replyPreviewText(CachedMessage m) {
  if (m.deleted) {
    return deletedPlaceholderText(m.contentTypeHint, m.deletedReason);
  }
  if (m.contentTypeHint == 'voice') return '🎤 Voice message';
  if (m.contentTypeHint == 'media') {
    final mime = m.attachment?.mimeType ?? '';
    if (mime.startsWith('image/')) return '📷 Photo';
    return '📄 ${m.attachment?.fileName ?? 'File'}';
  }
  return m.text;
}

/// The "replying to ..." strip shown above the composer while `_replyingTo` is
/// set — mirrors web's own preview (message-thread.tsx) exactly: a colored
/// left rule, the target's sender + a one-line snippet, and a way to cancel.
class _ReplyPreview extends StatelessWidget {
  const _ReplyPreview({
    required this.message,
    required this.otherName,
    required this.onCancel,
  });
  final CachedMessage message;
  final String otherName;
  final VoidCallback onCancel;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
      decoration: const BoxDecoration(
        border: Border(bottom: BorderSide(color: Color(0xFFE9E9E9))),
      ),
      child: Row(
        children: [
          Container(
            width: 3,
            height: 34,
            decoration: BoxDecoration(
              color: WhatsAppColors.tealAccent,
              borderRadius: BorderRadius.circular(2),
            ),
          ),
          const SizedBox(width: 10),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisSize: MainAxisSize.min,
              children: [
                Text(
                  message.isOwn
                      ? 'Replying to yourself'
                      : 'Replying to $otherName',
                  style: const TextStyle(
                    color: WhatsAppColors.tealAccent,
                    fontWeight: FontWeight.w600,
                    fontSize: 13,
                  ),
                ),
                const SizedBox(height: 2),
                Text(
                  _replyPreviewText(message),
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(
                    color: Color(0xFF667781),
                    fontSize: 13,
                  ),
                ),
              ],
            ),
          ),
          IconButton(
            icon: const Icon(Icons.close, size: 18, color: Color(0xFF667781)),
            tooltip: 'Cancel reply',
            onPressed: onCancel,
            padding: EdgeInsets.zero,
            constraints: const BoxConstraints(),
          ),
        ],
      ),
    );
  }
}

class _MessageBubble extends StatelessWidget {
  const _MessageBubble({
    super.key,
    required this.message,
    required this.onDownload,
    required this.ensureMediaDecrypted,
    this.status,
    this.pending = false,
    this.replySource,
    this.onLongPress,
    this.reactions = const [],
    this.onReactTap,
    this.searchQuery = '',
    this.isActiveSearchMatch = false,
    this.starred = false,
    this.onViewOnceOpen,
  });
  final CachedMessage message;
  final void Function(AttachmentDescriptor) onDownload;
  final Future<Uint8List> Function(AttachmentDescriptor) ensureMediaDecrypted;
  final ({bool delivered, bool read})? status;

  /// True while this is an optimistically-rendered bubble still waiting on the
  /// server to confirm the send — see thread_screen.dart's `_pendingIds`.
  final bool pending;

  /// The message this one is quoting, if any — resolved by the caller (already
  /// has the full `_messages` list; this widget doesn't) via `replyToMessageId`.
  /// Null either because this message isn't a reply, or because the original
  /// has aged out of this device's local cache (Double Ratchet ciphertext can
  /// only ever be decrypted once — see message_cache.dart's own docstring — so
  /// there's genuinely nothing left to show in that case, not a bug).
  final CachedMessage? replySource;
  final VoidCallback? onLongPress;

  /// Aggregated reaction pills for this message — resolved once per build by
  /// the parent (`_ThreadScreenState._buildBody`'s `_buildReactionState` call),
  /// not recomputed per bubble.
  final List<ReactionSummary> reactions;
  final void Function(String emoji)? onReactTap;

  /// Lowercased search text — empty when search is closed. Highlights matches
  /// inside the bubble's own text and, when [isActiveSearchMatch], draws the
  /// same yellow ring web's message-thread.tsx uses for the current match.
  final String searchQuery;
  final bool isActiveSearchMatch;

  /// See `StarredMessage`'s doc comment in schema.prisma — resolved once per
  /// build by the parent from `_ThreadScreenState._starredIds`.
  final bool starred;

  /// Fired the instant a `view_once` bubble is first opened — see
  /// `_ViewOnceImageBubble`'s own docstring. Null for a sender's own copy
  /// (never rendered with that widget in the first place).
  final void Function(String messageId)? onViewOnceOpen;

  @override
  Widget build(BuildContext context) {
    // WhatsApp uses the same near-black text on both bubble colors — never a
    // light-on-primary combination the way a generic Material bubble would.
    const fgColor = WhatsAppColors.bubbleText;

    // A tombstoned message — content is genuinely gone (see
    // markCachedMessageDeleted's docstring), rendered as a muted placeholder
    // with no long-press menu (matches web's own `!m.deleted` gate on even
    // showing the "..." actions button at all — there's nothing left to reply
    // to or delete twice).
    if (message.deleted) {
      return Align(
        alignment: message.isOwn ? Alignment.centerRight : Alignment.centerLeft,
        child: Container(
          margin: const EdgeInsets.symmetric(vertical: 2),
          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
          constraints: BoxConstraints(
            maxWidth: MediaQuery.of(context).size.width * 0.78,
          ),
          decoration: BoxDecoration(
            color: message.isOwn
                ? WhatsAppColors.outgoingBubble.withValues(alpha: 0.5)
                : WhatsAppColors.incomingBubble,
            borderRadius: BorderRadius.circular(8),
          ),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              Icon(
                Icons.block,
                size: 15,
                color: fgColor.withValues(alpha: 0.55),
              ),
              const SizedBox(width: 6),
              Flexible(
                child: Text(
                  deletedPlaceholderText(
                    message.contentTypeHint,
                    message.deletedReason,
                  ),
                  style: TextStyle(
                    color: fgColor.withValues(alpha: 0.55),
                    fontStyle: FontStyle.italic,
                    fontSize: 13,
                  ),
                ),
              ),
            ],
          ),
        ),
      );
    }

    final attachment = message.attachment;

    return Align(
      alignment: message.isOwn ? Alignment.centerRight : Alignment.centerLeft,
      child: Stack(
        // Lets the reaction-pill row (Positioned, below) overlap the bottom edge
        // of the bubble instead of being clipped by it — same overlap web's
        // absolutely-positioned pill row achieves (message-thread.tsx).
        clipBehavior: Clip.none,
        children: [
          GestureDetector(
            onLongPress: onLongPress,
            child: Container(
              margin: const EdgeInsets.symmetric(vertical: 2),
              padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
              constraints: BoxConstraints(
                maxWidth: MediaQuery.of(context).size.width * 0.78,
              ),
              decoration: BoxDecoration(
                color: message.isOwn
                    ? WhatsAppColors.outgoingBubble
                    : WhatsAppColors.incomingBubble,
                // The pinched corner on the side nearest the sender approximates
                // WhatsApp's speech-bubble tail — a plain uniform radius reads as a
                // generic chat bubble, not specifically WhatsApp's.
                borderRadius: BorderRadius.only(
                  topLeft: const Radius.circular(8),
                  topRight: const Radius.circular(8),
                  bottomLeft: Radius.circular(message.isOwn ? 8 : 0),
                  bottomRight: Radius.circular(message.isOwn ? 0 : 8),
                ),
                border: isActiveSearchMatch
                    ? Border.all(color: const Color(0xFFFBC02D), width: 2)
                    : null,
                boxShadow: const [
                  BoxShadow(
                    color: Color(0x14000000),
                    blurRadius: 1,
                    offset: Offset(0, 1),
                  ),
                ],
              ),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.end,
                mainAxisSize: MainAxisSize.min,
                children: [
                  if (replySource != null)
                    Container(
                      margin: const EdgeInsets.only(bottom: 4),
                      padding: const EdgeInsets.symmetric(
                        horizontal: 8,
                        vertical: 6,
                      ),
                      decoration: BoxDecoration(
                        color: Colors.black.withValues(alpha: 0.05),
                        borderRadius: BorderRadius.circular(6),
                        border: Border(
                          left: BorderSide(
                            color: WhatsAppColors.tealAccent,
                            width: 3,
                          ),
                        ),
                      ),
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          Text(
                            replySource!.isOwn ? 'You' : 'Them',
                            style: const TextStyle(
                              color: WhatsAppColors.tealAccent,
                              fontWeight: FontWeight.w600,
                              fontSize: 12,
                            ),
                          ),
                          Text(
                            _replyPreviewText(replySource!),
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: TextStyle(
                              color: fgColor.withValues(alpha: 0.7),
                              fontSize: 12,
                            ),
                          ),
                        ],
                      ),
                    ),
                  Padding(
                    padding: const EdgeInsets.only(bottom: 2),
                    child:
                        message.contentTypeHint == 'voice' &&
                            message.mediaBase64 != null
                        ? _VoiceMessagePlayer(
                            base64Audio: message.mediaBase64!,
                            durationHintSec: message.mediaDurationSec,
                            fgColor: fgColor,
                          )
                        : message.contentTypeHint == 'image' &&
                              message.mediaBase64 != null
                        ? _InlineImageBubble(base64: message.mediaBase64!)
                        : message.contentTypeHint == 'view_once' &&
                              message.mediaBase64 != null
                        ? (message.isOwn
                              ? _InlineImageBubble(base64: message.mediaBase64!)
                              : _ViewOnceImageBubble(
                                  base64: message.mediaBase64!,
                                  onOpen: () =>
                                      onViewOnceOpen?.call(message.id),
                                ))
                        : attachment != null && attachment.mimeType.startsWith('image/')
                        ? _MediaImageBubble(
                            attachment: attachment,
                            ensureDecrypted: ensureMediaDecrypted,
                          )
                        : attachment != null && attachment.mimeType.startsWith('video/')
                        ? _MediaVideoBubble(
                            attachment: attachment,
                            ensureDecrypted: ensureMediaDecrypted,
                          )
                        : attachment != null
                        ? InkWell(
                            onTap: () => onDownload(attachment),
                            child: Row(
                              mainAxisSize: MainAxisSize.min,
                              children: [
                                Icon(Icons.insert_drive_file, color: fgColor),
                                const SizedBox(width: 8),
                                Flexible(
                                  child: Column(
                                    crossAxisAlignment:
                                        CrossAxisAlignment.start,
                                    mainAxisSize: MainAxisSize.min,
                                    children: [
                                      Text(
                                        attachment.fileName,
                                        style: TextStyle(color: fgColor),
                                        overflow: TextOverflow.ellipsis,
                                      ),
                                      Text(
                                        _formatBytes(attachment.sizeBytes),
                                        style: TextStyle(
                                          color: fgColor.withValues(
                                            alpha: 0.75,
                                          ),
                                          fontSize: 12,
                                        ),
                                      ),
                                    ],
                                  ),
                                ),
                                const SizedBox(width: 8),
                                Icon(Icons.download, color: fgColor, size: 18),
                              ],
                            ),
                          )
                        : searchQuery.isNotEmpty
                        ? Text.rich(
                            TextSpan(
                              children: _highlightSpans(
                                message.text,
                                searchQuery,
                                TextStyle(color: fgColor),
                              ),
                            ),
                          )
                        : Text(message.text, style: TextStyle(color: fgColor)),
                  ),
                  // Timestamp + delivery/read tick, bottom-right inside the bubble —
                  // WhatsApp's own placement. Ticks only ever appear on OWN messages
                  // (they show what happened to a message you sent); an incoming message
                  // never carries them, on WhatsApp or here.
                  Row(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      if (starred) ...[
                        Icon(
                          Icons.star,
                          size: 10,
                          color: fgColor.withValues(alpha: 0.7),
                        ),
                        const SizedBox(width: 3),
                      ],
                      Text(
                        _formatBubbleTime(message.sentAt),
                        style: TextStyle(
                          color: fgColor.withValues(alpha: 0.6),
                          fontSize: 11,
                        ),
                      ),
                      if (message.isOwn) ...[
                        const SizedBox(width: 4),
                        Builder(
                          builder: (context) {
                            final tick = tickStateFor(status, pending: pending);
                            if (tick == TickState.sending) {
                              return Icon(
                                Icons.access_time,
                                size: 13,
                                color: fgColor.withValues(alpha: 0.6),
                              );
                            }
                            return Icon(
                              tick == TickState.sent
                                  ? Icons.done
                                  : Icons.done_all,
                              size: 15,
                              color: tick == TickState.read
                                  ? const Color(0xFF34B7F1)
                                  : fgColor.withValues(alpha: 0.6),
                            );
                          },
                        ),
                      ],
                    ],
                  ),
                ],
              ),
            ),
          ),
          if (reactions.isNotEmpty)
            Positioned(
              bottom: -10,
              right: message.isOwn ? 8 : null,
              left: message.isOwn ? null : 8,
              child: _ReactionPillRow(reactions: reactions, onTap: onReactTap),
            ),
        ],
      ),
    );
  }
}

/// The small pill row rendered under a bubble that has at least one active
/// reaction — mirrors apps/web's identical treatment (message-thread.tsx):
/// tapping a pill toggles the current user's reaction to/from that emoji.
class _ReactionPillRow extends StatelessWidget {
  const _ReactionPillRow({required this.reactions, this.onTap});
  final List<ReactionSummary> reactions;
  final void Function(String emoji)? onTap;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 4, vertical: 2),
      decoration: BoxDecoration(
        color: WhatsAppColors.listBackground,
        borderRadius: BorderRadius.circular(999),
        border: Border.all(color: Colors.black.withValues(alpha: 0.08)),
        boxShadow: const [
          BoxShadow(
            color: Color(0x14000000),
            blurRadius: 2,
            offset: Offset(0, 1),
          ),
        ],
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          for (final r in reactions)
            InkWell(
              customBorder: const CircleBorder(),
              onTap: onTap == null ? null : () => onTap!(r.emoji),
              child: Padding(
                padding: const EdgeInsets.symmetric(horizontal: 4, vertical: 1),
                child: Row(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Text(r.emoji, style: const TextStyle(fontSize: 13)),
                    if (r.count > 1) ...[
                      const SizedBox(width: 2),
                      Text(
                        '${r.count}',
                        style: TextStyle(
                          fontSize: 11,
                          fontWeight: FontWeight.w600,
                          color: r.mine
                              ? WhatsAppColors.tealAccent
                              : Colors.black54,
                        ),
                      ),
                    ],
                  ],
                ),
              ),
            ),
        ],
      ),
    );
  }
}

/// "... is typing" — three dots pulsing in sequence, styled as an incoming
/// bubble (left-aligned, white) — the mobile counterpart to web's own
/// animated-dot indicator (message-thread.tsx's `animate-typing-dot`).
class _TypingIndicatorBubble extends StatefulWidget {
  const _TypingIndicatorBubble();

  @override
  State<_TypingIndicatorBubble> createState() => _TypingIndicatorBubbleState();
}

class _TypingIndicatorBubbleState extends State<_TypingIndicatorBubble>
    with SingleTickerProviderStateMixin {
  late final AnimationController _controller;

  @override
  void initState() {
    super.initState();
    _controller = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 900),
    )..repeat();
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Align(
      alignment: Alignment.centerLeft,
      child: Container(
        margin: const EdgeInsets.symmetric(vertical: 2),
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
        decoration: BoxDecoration(
          color: WhatsAppColors.incomingBubble,
          borderRadius: const BorderRadius.only(
            topLeft: Radius.circular(8),
            topRight: Radius.circular(8),
            bottomRight: Radius.circular(8),
          ),
          boxShadow: const [
            BoxShadow(
              color: Color(0x14000000),
              blurRadius: 1,
              offset: Offset(0, 1),
            ),
          ],
        ),
        child: AnimatedBuilder(
          animation: _controller,
          builder: (context, _) {
            return Row(
              mainAxisSize: MainAxisSize.min,
              children: List.generate(3, (i) {
                // Each dot staggered a third of the cycle behind the last —
                // a simple sine bounce rather than a discrete on/off blink.
                final phase = (_controller.value - i * 0.2) % 1.0;
                final scale = 0.5 + 0.5 * (0.5 - (phase - 0.5).abs()) * 2;
                return Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 2),
                  child: Transform.scale(
                    scale: 0.6 + 0.4 * scale,
                    child: Container(
                      width: 7,
                      height: 7,
                      decoration: BoxDecoration(
                        color: WhatsAppColors.bubbleText.withValues(alpha: 0.4),
                        shape: BoxShape.circle,
                      ),
                    ),
                  ),
                );
              }),
            );
          },
        ),
      ),
    );
  }
}

String _formatBytes(int bytes) {
  if (bytes < 1024) return '$bytes B';
  if (bytes < 1024 * 1024) return '${(bytes / 1024).toStringAsFixed(1)} KB';
  return '${(bytes / (1024 * 1024)).toStringAsFixed(1)} MB';
}

String _formatPlaybackDuration(Duration d) {
  final m = d.inMinutes.remainder(60).toString().padLeft(2, '0');
  final s = d.inSeconds.remainder(60).toString().padLeft(2, '0');
  return '$m:$s';
}

/// An inline `contentTypeHint: 'image'` (or the sender's own `view_once` copy)
/// photo — mobile counterpart to apps/web's `ImageBubble` (components/chat/
/// bubbles.tsx). Tap to expand full-screen; no download button (mobile's
/// generic file bubble above already covers "save this," and an inline photo
/// here is view-only by design, same scope apps/web ships for this pass).
///
/// A `StatefulWidget` that decodes once in `initState` (not a plain
/// `StatelessWidget` decoding inline in `build`), because this bubble sits in
/// a `ListView.builder` row that rebuilds on every unrelated `setState` in the
/// screen (`_pollDeliveryStatus`'s 8s timer, a realtime `read`/`delivered`
/// event, starring a message, ...) — decoding fresh `base64Decode` bytes on
/// every one of those rebuilds handed `Image.memory` a brand-new `Uint8List`
/// each time, and since `Uint8List` doesn't override `==`, `MemoryImage`'s
/// identity-based equality never matched the previous frame: Flutter treated
/// it as a genuinely new image, clearing the old frame while it decoded the
/// "new" one — the visible blink reported live. Decoding once and reusing the
/// same `Uint8List` (invalidated only if `base64` itself actually changes,
/// via `didUpdateWidget` — belt-and-suspenders for a message list that can
/// still shift slot indices after a deletion) makes every rebuild reuse the
/// exact same `MemoryImage`, so Flutter recognizes it as already-resolved and
/// never swaps frames at all. `gaplessPlayback`/`cacheWidth` are additional,
/// independent hardening: `gaplessPlayback` means even a genuine image change
/// fades rather than blanks, and `cacheWidth` (sized to the actual on-screen
/// box, not the source photo's full resolution) avoids decoding a multi-
/// megapixel camera photo into memory just to paint it into a 220x220
/// thumbnail — real memory/CPU savings on every open of a chat with photos.
class _InlineImageBubble extends StatefulWidget {
  const _InlineImageBubble({required this.base64});
  final String base64;

  @override
  State<_InlineImageBubble> createState() => _InlineImageBubbleState();
}

class _InlineImageBubbleState extends State<_InlineImageBubble> {
  late Uint8List _bytes;

  @override
  void initState() {
    super.initState();
    _bytes = base64Decode(widget.base64);
  }

  @override
  void didUpdateWidget(covariant _InlineImageBubble oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.base64 != widget.base64) {
      _bytes = base64Decode(widget.base64);
    }
  }

  @override
  Widget build(BuildContext context) {
    final cacheWidth = (220 * MediaQuery.of(context).devicePixelRatio).round();
    return GestureDetector(
      onTap: () => _showFullscreenImage(context, _bytes),
      child: ClipRRect(
        borderRadius: BorderRadius.circular(8),
        child: Image.memory(
          _bytes,
          width: 220,
          height: 220,
          fit: BoxFit.cover,
          gaplessPlayback: true,
          cacheWidth: cacheWidth,
        ),
      ),
    );
  }
}

void _showFullscreenImage(BuildContext context, Uint8List bytes) {
  Navigator.of(context).push(
    PageRouteBuilder<void>(
      opaque: false,
      barrierColor: Colors.black87,
      pageBuilder: (context, _, _) => GestureDetector(
        onTap: () => Navigator.of(context).pop(),
        child: Scaffold(
          backgroundColor: Colors.transparent,
          body: SafeArea(
            child: Stack(
              children: [
                Center(child: InteractiveViewer(child: Image.memory(bytes))),
                Positioned(
                  right: 8,
                  top: 8,
                  child: IconButton(
                    icon: const Icon(Icons.close, color: Colors.white),
                    onPressed: () => Navigator.of(context).pop(),
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    ),
  );
}

/// A `contentTypeHint: 'view_once'` photo, the RECIPIENT's side only — mirrors
/// apps/web's `ViewOnceImageBubble` (components/chat/bubbles.tsx) exactly,
/// including WHY the sender's own copy never uses this widget (see that file's
/// docstring: the "one look" promise is about the recipient, not the person who
/// already has it — thread_screen.dart's render switch routes `message.isOwn`
/// straight to `_InlineImageBubble` instead). Opening it fires `onOpen` exactly
/// once (the `_opened` guard), which the caller uses to trigger the actual
/// self-tombstone request.
class _ViewOnceImageBubble extends StatefulWidget {
  const _ViewOnceImageBubble({required this.base64, required this.onOpen});
  final String base64;
  final VoidCallback onOpen;

  @override
  State<_ViewOnceImageBubble> createState() => _ViewOnceImageBubbleState();
}

class _ViewOnceImageBubbleState extends State<_ViewOnceImageBubble> {
  bool _opened = false;

  void _handleOpen() {
    if (!_opened) {
      setState(() => _opened = true);
      widget.onOpen();
    }
    _showFullscreenImage(context, base64Decode(widget.base64));
  }

  @override
  Widget build(BuildContext context) {
    return InkWell(
      onTap: _handleOpen,
      borderRadius: BorderRadius.circular(8),
      child: Container(
        width: 176,
        height: 112,
        decoration: BoxDecoration(
          color: Colors.black12,
          borderRadius: BorderRadius.circular(8),
        ),
        child: const Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Icon(Icons.remove_red_eye_outlined, size: 24),
            SizedBox(height: 4),
            Text('Tap to view photo', style: TextStyle(fontSize: 12)),
          ],
        ),
      ),
    );
  }
}

/// A `contentTypeHint: 'media'` attachment whose mimeType is `image/*` — unlike
/// `_InlineImageBubble` above, the bytes aren't already sitting in the decrypted
/// plaintext (the `media` pipeline only carries a small descriptor; the actual
/// ciphertext lives in object storage), so this fetches them via
/// `ensureDecrypted` (`_ensureMediaDecrypted`) and shows a spinner meanwhile.
/// Only images get this eager-fetch treatment: a picked photo is small/expected
/// enough (this app compresses on send) that matching WhatsApp's inline-
/// thumbnail behavior is worth it, unlike an arbitrary file attachment (still
/// the plain download-on-tap row below) or a video (`_MediaVideoBubble`,
/// deliberately lazy — see its own docstring).
class _MediaImageBubble extends StatefulWidget {
  const _MediaImageBubble({
    required this.attachment,
    required this.ensureDecrypted,
  });
  final AttachmentDescriptor attachment;
  final Future<Uint8List> Function(AttachmentDescriptor) ensureDecrypted;

  @override
  State<_MediaImageBubble> createState() => _MediaImageBubbleState();
}

class _MediaImageBubbleState extends State<_MediaImageBubble> {
  late Future<Uint8List> _future;

  @override
  void initState() {
    super.initState();
    _future = widget.ensureDecrypted(widget.attachment);
  }

  // Defensive, mirrors `_InlineImageBubble`'s own reasoning: this row's
  // `ListView.builder` slot can end up reused for a *different* message (a
  // deletion above it shifts every later index down by one) — without this,
  // `_future` would keep resolving to the previous slot's already-decrypted
  // bytes forever, silently showing the wrong photo. `objectKey` is this
  // attachment's stable identity (AttachmentDescriptor), so this only
  // refetches when the underlying photo actually changed.
  @override
  void didUpdateWidget(covariant _MediaImageBubble oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.attachment.objectKey != widget.attachment.objectKey) {
      _future = widget.ensureDecrypted(widget.attachment);
    }
  }

  void _retry() {
    setState(() => _future = widget.ensureDecrypted(widget.attachment));
  }

  @override
  Widget build(BuildContext context) {
    return FutureBuilder<Uint8List>(
      future: _future,
      builder: (context, snapshot) {
        if (snapshot.hasError) {
          return GestureDetector(
            onTap: _retry,
            child: Container(
              width: 220,
              height: 220,
              decoration: BoxDecoration(
                color: Colors.black12,
                borderRadius: BorderRadius.circular(8),
              ),
              child: const Column(
                mainAxisAlignment: MainAxisAlignment.center,
                children: [
                  Icon(Icons.error_outline, size: 28),
                  SizedBox(height: 6),
                  Text('Couldn\'t load photo — tap to retry', style: TextStyle(fontSize: 12)),
                ],
              ),
            ),
          );
        }
        if (!snapshot.hasData) {
          return const SizedBox(
            width: 220,
            height: 220,
            child: Center(child: CircularProgressIndicator(strokeWidth: 2)),
          );
        }
        final bytes = snapshot.data!;
        final cacheWidth = (220 * MediaQuery.of(context).devicePixelRatio).round();
        return GestureDetector(
          onTap: () => _showFullscreenImage(context, bytes),
          child: ClipRRect(
            borderRadius: BorderRadius.circular(8),
            child: Image.memory(
              bytes,
              width: 220,
              height: 220,
              fit: BoxFit.cover,
              gaplessPlayback: true,
              cacheWidth: cacheWidth,
            ),
          ),
        );
      },
    );
  }
}

/// A `contentTypeHint: 'media'` attachment whose mimeType is `video/*`.
/// Deliberately lazy, unlike `_MediaImageBubble` above: a video can be large
/// enough that eagerly fetching one just to show a thumbnail would be exactly
/// the "defeats the point of the object-storage pipeline" cost the plain file
/// row's own download-on-tap design already avoids. Tapping downloads+decrypts
/// (spinner meanwhile), writes the bytes to a temp file — `video_player` plays
/// from a file/URL, not raw in-memory bytes — then opens a fullscreen player.
class _MediaVideoBubble extends StatefulWidget {
  const _MediaVideoBubble({
    required this.attachment,
    required this.ensureDecrypted,
  });
  final AttachmentDescriptor attachment;
  final Future<Uint8List> Function(AttachmentDescriptor) ensureDecrypted;

  @override
  State<_MediaVideoBubble> createState() => _MediaVideoBubbleState();
}

class _MediaVideoBubbleState extends State<_MediaVideoBubble> {
  bool _loading = false;
  String? _error;

  Future<void> _open() async {
    if (_loading) return;
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final bytes = await widget.ensureDecrypted(widget.attachment);
      final dir = await getTemporaryDirectory();
      // Keeps the real file extension (not a hardcoded .mp4) — video_player's
      // platform players can lean on it for format detection, and this app's
      // media pipeline already carries the sender's original file name.
      final file = File(
        '${dir.path}/comm-video-preview-${widget.attachment.objectKey}-${widget.attachment.fileName}',
      );
      if (!await file.exists()) {
        await file.writeAsBytes(bytes, flush: true);
      }
      if (mounted) await _showFullscreenVideo(context, file);
    } catch (_) {
      if (mounted) setState(() => _error = 'Couldn\'t load video');
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return GestureDetector(
      onTap: _open,
      child: Container(
        width: 220,
        height: 220,
        decoration: BoxDecoration(
          color: Colors.black87,
          borderRadius: BorderRadius.circular(8),
        ),
        child: Center(
          child: _loading
              ? const CircularProgressIndicator(strokeWidth: 2, color: Colors.white)
              : Column(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Icon(
                      _error != null ? Icons.error_outline : Icons.play_circle_fill,
                      color: Colors.white,
                      size: 48,
                    ),
                    const SizedBox(height: 6),
                    Text(
                      _error ?? _formatBytes(widget.attachment.sizeBytes),
                      style: const TextStyle(color: Colors.white70, fontSize: 12),
                    ),
                  ],
                ),
        ),
      ),
    );
  }
}

/// Opens a fullscreen video player over the current screen — the video
/// counterpart to `_showFullscreenImage` above, same `PageRouteBuilder` chrome
/// (transparent barrier, tap-anywhere-to-toggle, a close button). Owns the
/// `VideoPlayerController` for the lifetime of the route and disposes it on the
/// way out, since each open is a fresh decrypt-to-tempfile (`_MediaVideoBubble`
/// above), not a long-lived shared controller.
Future<void> _showFullscreenVideo(BuildContext context, File file) async {
  final controller = VideoPlayerController.file(file);
  await controller.initialize();
  await controller.play();
  if (!context.mounted) {
    await controller.dispose();
    return;
  }
  await Navigator.of(context).push(
    PageRouteBuilder<void>(
      opaque: false,
      barrierColor: Colors.black87,
      pageBuilder: (context, _, _) => _FullscreenVideoPlayer(controller: controller),
    ),
  );
  await controller.dispose();
}

class _FullscreenVideoPlayer extends StatefulWidget {
  const _FullscreenVideoPlayer({required this.controller});
  final VideoPlayerController controller;

  @override
  State<_FullscreenVideoPlayer> createState() => _FullscreenVideoPlayerState();
}

class _FullscreenVideoPlayerState extends State<_FullscreenVideoPlayer> {
  @override
  void initState() {
    super.initState();
    widget.controller.addListener(_onTick);
  }

  @override
  void dispose() {
    widget.controller.removeListener(_onTick);
    super.dispose();
  }

  void _onTick() {
    if (mounted) setState(() {});
  }

  void _togglePlay() {
    if (widget.controller.value.isPlaying) {
      widget.controller.pause();
    } else {
      widget.controller.play();
    }
  }

  @override
  Widget build(BuildContext context) {
    final value = widget.controller.value;
    return Scaffold(
      backgroundColor: Colors.transparent,
      body: SafeArea(
        child: Stack(
          children: [
            Center(
              child: value.isInitialized
                  ? AspectRatio(
                      aspectRatio: value.aspectRatio,
                      child: GestureDetector(
                        onTap: _togglePlay,
                        child: VideoPlayer(widget.controller),
                      ),
                    )
                  : const CircularProgressIndicator(color: Colors.white),
            ),
            Positioned(
              right: 8,
              top: 8,
              child: IconButton(
                icon: const Icon(Icons.close, color: Colors.white),
                onPressed: () => Navigator.of(context).pop(),
              ),
            ),
            if (value.isInitialized)
              Positioned(
                left: 16,
                right: 16,
                bottom: 24,
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    VideoProgressIndicator(
                      widget.controller,
                      allowScrubbing: true,
                      colors: const VideoProgressColors(
                        playedColor: WhatsAppColors.tealAccent,
                      ),
                    ),
                    const SizedBox(height: 4),
                    IconButton(
                      icon: Icon(
                        value.isPlaying ? Icons.pause : Icons.play_arrow,
                        color: Colors.white,
                        size: 36,
                      ),
                      onPressed: _togglePlay,
                    ),
                  ],
                ),
              ),
          ],
        ),
      ),
    );
  }
}

/// Play/pause + progress bar for a `contentTypeHint: 'voice'` bubble — the
/// mobile counterpart to apps/web's `VoiceBubble` (components/chat/bubbles.tsx).
/// Owns its own `AudioPlayer` rather than sharing one across bubbles, same as
/// web owns one `<audio>` element per `VoiceBubble` instance — simplest
/// correct option, and a chat thread never has more than a handful of these
/// mounted at once.
class _VoiceMessagePlayer extends StatefulWidget {
  const _VoiceMessagePlayer({
    required this.base64Audio,
    required this.durationHintSec,
    required this.fgColor,
  });
  final String base64Audio;

  /// Only ever non-null for a message THIS device just recorded and sent —
  /// see CachedMessage.mediaDurationSec's own docstring. Shown until the
  /// player itself reports a real duration after loading.
  final int? durationHintSec;
  final Color fgColor;

  @override
  State<_VoiceMessagePlayer> createState() => _VoiceMessagePlayerState();
}

class _VoiceMessagePlayerState extends State<_VoiceMessagePlayer> {
  final AudioPlayer _player = AudioPlayer();
  bool _playing = false;
  Duration _position = Duration.zero;
  Duration? _duration;
  String? _tempPath;
  // Same fixed set WhatsApp offers, cycled by tapping the speed pill — a voice
  // note is short enough that three steps cover every real use case.
  static const _speeds = [1.0, 1.5, 2.0];
  int _speedIndex = 0;
  double get _speed => _speeds[_speedIndex];
  late final StreamSubscription<Duration> _positionSub;
  late final StreamSubscription<Duration> _durationSub;
  late final StreamSubscription<PlayerState> _stateSub;
  late final StreamSubscription<void> _completeSub;

  @override
  void initState() {
    super.initState();
    _positionSub = _player.onPositionChanged.listen((p) {
      if (mounted) setState(() => _position = p);
    });
    _durationSub = _player.onDurationChanged.listen((d) {
      if (mounted) setState(() => _duration = d);
    });
    _stateSub = _player.onPlayerStateChanged.listen((s) {
      if (mounted) setState(() => _playing = s == PlayerState.playing);
    });
    _completeSub = _player.onPlayerComplete.listen((_) {
      if (mounted) {
        setState(() {
          _playing = false;
          _position = Duration.zero;
        });
      }
    });
  }

  @override
  void dispose() {
    _positionSub.cancel();
    _durationSub.cancel();
    _stateSub.cancel();
    _completeSub.cancel();
    _player.dispose();
    // The materialized temp file (if any) is deliberately left for the OS's
    // own temp-dir reclaim schedule, same as _downloadAttachment's saved
    // files elsewhere in this screen — not cleaned up here, since dispose()
    // can't usefully await an async delete anyway.
    super.dispose();
  }

  /// Decodes this message's base64 audio to a temp file the first time it's
  /// actually played, not eagerly on build — a loaded thread can have many
  /// voice bubbles on screen at once and most are never opened.
  Future<String> _materialize() async {
    final bytes = base64ToBytes(widget.base64Audio);
    final dir = await getTemporaryDirectory();
    final file = File(
      '${dir.path}/comm-voice-play-${DateTime.now().microsecondsSinceEpoch}.m4a',
    );
    await file.writeAsBytes(bytes);
    return file.path;
  }

  Future<void> _toggle() async {
    if (_playing) {
      await _player.pause();
      return;
    }
    final path = _tempPath ??= await _materialize();
    await _player.play(DeviceFileSource(path));
    // A freshly started source resets the player back to 1x — re-apply
    // whatever speed was already selected rather than silently losing it.
    await _player.setPlaybackRate(_speed);
  }

  Future<void> _cycleSpeed() async {
    setState(() => _speedIndex = (_speedIndex + 1) % _speeds.length);
    await _player.setPlaybackRate(_speed);
  }

  String get _speedLabel =>
      _speed == _speed.roundToDouble() ? '${_speed.toInt()}x' : '${_speed}x';

  @override
  Widget build(BuildContext context) {
    final total = _duration ?? Duration(seconds: widget.durationHintSec ?? 0);
    final shown = _playing || _position > Duration.zero ? _position : total;
    final progress = total.inMilliseconds > 0
        ? (_position.inMilliseconds / total.inMilliseconds).clamp(0.0, 1.0)
        : 0.0;

    return SizedBox(
      width: 216,
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          InkWell(
            onTap: _toggle,
            customBorder: const CircleBorder(),
            child: Container(
              width: 34,
              height: 34,
              decoration: BoxDecoration(
                color: widget.fgColor.withValues(alpha: 0.1),
                shape: BoxShape.circle,
              ),
              child: Icon(
                _playing ? Icons.pause : Icons.play_arrow,
                color: widget.fgColor,
                size: 20,
              ),
            ),
          ),
          const SizedBox(width: 8),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisSize: MainAxisSize.min,
              children: [
                ClipRRect(
                  borderRadius: BorderRadius.circular(2),
                  child: LinearProgressIndicator(
                    value: progress,
                    minHeight: 3,
                    backgroundColor: widget.fgColor.withValues(alpha: 0.15),
                    valueColor: AlwaysStoppedAnimation(
                      widget.fgColor.withValues(alpha: 0.7),
                    ),
                  ),
                ),
                const SizedBox(height: 3),
                Text(
                  _formatPlaybackDuration(shown),
                  style: TextStyle(
                    color: widget.fgColor.withValues(alpha: 0.7),
                    fontSize: 11,
                  ),
                ),
              ],
            ),
          ),
          const SizedBox(width: 4),
          InkWell(
            onTap: _cycleSpeed,
            customBorder: const StadiumBorder(),
            child: Container(
              padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 3),
              child: Text(
                _speedLabel,
                style: TextStyle(
                  color: widget.fgColor.withValues(alpha: 0.7),
                  fontSize: 11,
                  fontWeight: FontWeight.w600,
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }
}
