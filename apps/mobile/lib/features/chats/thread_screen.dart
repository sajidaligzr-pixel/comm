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
import 'package:flutter/services.dart' show HapticFeedback;
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:image_picker/image_picker.dart';
import 'package:path_provider/path_provider.dart';
import 'package:record/record.dart';
import 'package:uuid/uuid.dart';

import '../../api/api_client.dart';
import '../../api/dtos.dart';
import '../../app/app.dart' show WhatsAppColors;
import '../../app/providers.dart';
import '../notifications/conversation_titles.dart';
import '../notifications/local_notifications.dart' show clearNotificationFor;
import '../../crypto/attachment_crypto.dart' as attach_crypto;
import '../../crypto/conversation_crypto.dart' as convo;
import '../../crypto/encoding.dart';
import '../../crypto/kek_holder.dart';
import '../../crypto/message_cache.dart';
import '../../crypto/session/session.dart' show MessageEnvelope;
import '../../shared/widgets/error_state.dart';
import '../auth/auth_controller.dart';
import '../auth/auth_state.dart';
import '../calls/call_controller.dart';
import '../groups/group_session_controller.dart';

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
  if (contentTypeHint == 'voice') {
    // Raw audio bytes, not JSON — same inline-envelope path as text, just
    // base64'd for storage the same way apps/web keeps `mediaBase64` in its
    // own local cache. See thread_screen.dart's recording docstring for the
    // format this device records in and the cross-client playback story.
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
  return _DecodedContent(text: bytesToUtf8(plaintext));
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

  /// The message a long-press has staged to reply to — mirrors web's
  /// `replyingTo` (message-thread.tsx) exactly: shown as a preview strip above
  /// the composer, cleared the instant a send actually starts (not after it
  /// completes — see `_sendEnvelope`), and carried as `replyToMessageId` on
  /// the outgoing request.
  CachedMessage? _replyingTo;
  final _scrollController = ScrollController();
  String? _error;
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
          _status[dto.id] = (
            delivered: dto.deliveredAt != null,
            read: dto.readAt != null,
          );
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
    setState(
      () => _status[messageId] = (
        delivered: true,
        read: _status[messageId]?.read ?? false,
      ),
    );
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
          }
        }
      } else {
        // The read message isn't in this device's local cache/view (e.g. it
        // arrived on a different device) — fall back to the old exact-id update,
        // still strictly better than doing nothing with it.
        _status[upToMessageId] = (delivered: true, read: true);
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
          }
        }
        if (cachedIds.contains(dto.id)) continue;
        final result = await _ingestIncoming(
          dto,
          alreadyMine: dto.senderUserId == _myUserId,
          persist: false,
        );
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

  /// `alreadyMine` covers REST history backfill for this device's OWN earlier sent
  /// messages that never made it into the local cache (e.g. sent from a different
  /// device) — those ciphertexts can never be decrypted (a sending chain is
  /// one-directional), so they're shown as a placeholder rather than silently
  /// dropped or crashing the load.
  ///
  /// `persist: false` skips the individual disk write and just returns the
  /// decrypted [CachedMessage] instead — `_load()`'s history catch-up uses this
  /// to batch every message from one page into a single write via
  /// `appendCachedMessages` rather than one read-modify-write per message (see
  /// that function's docstring). The live single-message path (`_onRealtimeNew`)
  /// leaves `persist` at its default; there's nothing to batch for one message.
  Future<CachedMessage?> _ingestIncoming(
    MessageDto dto, {
    bool alreadyMine = false,
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
    if (isOwn && alreadyMine) {
      text = '[Sent from another device — not available on this one]';
    } else if (dto.envelopeType == 'megolm_group') {
      final conversation = _conversation;
      final groupId = conversation?.groupId;
      if (groupId == null) {
        text = '[Could not decrypt this message]';
      } else {
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
              alreadyMine: alreadyMine,
              retriedAfterKeySync: true,
              isLive: isLive,
              persist: persist,
            );
          }
          text = '[Could not decrypt this message]';
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
      } catch (e) {
        text = '[Could not decrypt this message]';
      }
    }

    final cached = CachedMessage(
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
    );
    if (persist) await appendCachedMessage(kek, cached);
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

  void _scrollToBottom() {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (_scrollController.hasClients) {
        _scrollController.animateTo(
          _scrollController.position.maxScrollExtent,
          duration: const Duration(milliseconds: 200),
          curve: Curves.easeOut,
        );
      }
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

  /// Long-press a bubble — Reply (any message) + Delete (own messages only,
  /// "delete for everyone," matching web's own `m.isOwn` gate on showing the
  /// button at all). Uses the same bottom-sheet pattern chats_list_screen.dart's
  /// own long-press menu already established, rather than a different one-off
  /// interaction just for this screen.
  void _showMessageActions(CachedMessage message) {
    HapticFeedback.selectionClick();
    showModalBottomSheet<void>(
      context: context,
      builder: (context) => SafeArea(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            ListTile(
              leading: const Icon(Icons.reply),
              title: const Text('Reply'),
              onTap: () {
                Navigator.of(context).pop();
                _startReply(message);
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
          targets = _targetDevices = [...otherMemberDevices, ...ownOtherDevices];
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
    );
    if (picked == null) return;
    final bytes = await picked.readAsBytes();
    await _sendFile(bytes, picked.name, picked.mimeType ?? 'image/jpeg');
  }

  Future<void> _pickAndSendFile() async {
    final result = await FilePicker.platform.pickFiles(withData: true);
    final picked = result?.files.single;
    if (picked?.bytes == null) return;
    await _sendFile(picked!.bytes!, picked.name, 'application/octet-stream');
  }

  Future<void> _downloadAttachment(AttachmentDescriptor descriptor) async {
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(content: Text('Downloading ${descriptor.fileName}…')),
    );
    try {
      final ciphertext = await ref
          .read(mediaApiProvider)
          .downloadAttachmentCiphertext(descriptor.objectKey);
      final plaintext = await attach_crypto.decryptAttachment(
        ciphertext,
        base64ToBytes(descriptor.key),
        base64ToBytes(descriptor.nonce),
      );

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
    return Scaffold(
      appBar: AppBar(
        title: InkWell(
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

    // Typing indicator renders as a trailing list item, not a widget bolted on
    // outside the ListView — that keeps it scrolling into view with everything
    // else instead of needing its own separate layout/visibility logic.
    final showTyping = _otherTyping && _conversation?.type == 'direct';
    final itemCount = _messages.length + (showTyping ? 1 : 0);

    return Column(
      children: [
        Expanded(
          child: _messages.isEmpty && !showTyping
              ? const EmptyState(
                  icon: Icons.chat_bubble_outline,
                  message: 'No messages yet — say hello.',
                )
              : ListView.builder(
                  controller: _scrollController,
                  padding: const EdgeInsets.all(12),
                  itemCount: itemCount,
                  itemBuilder: (context, index) {
                    if (index == _messages.length) {
                      return const _TypingIndicatorBubble();
                    }
                    final message = _messages[index];
                    return _MessageBubble(
                      message: message,
                      onDownload: _downloadAttachment,
                      status: _status[message.id],
                      pending: _pendingIds.contains(message.id),
                      replySource: message.replyToMessageId != null
                          ? messagesById[message.replyToMessageId]
                          : null,
                      onLongPress: message.deleted
                          ? null
                          : () => _showMessageActions(message),
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
                              onSelected: (choice) => choice == 'photo'
                                  ? _pickAndSendPhoto()
                                  : _pickAndSendFile(),
                              itemBuilder: (context) => const [
                                PopupMenuItem(
                                  value: 'photo',
                                  child: ListTile(
                                    leading: Icon(Icons.photo),
                                    title: Text('Photo'),
                                  ),
                                ),
                                PopupMenuItem(
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
    required this.message,
    required this.onDownload,
    this.status,
    this.pending = false,
    this.replySource,
    this.onLongPress,
  });
  final CachedMessage message;
  final void Function(AttachmentDescriptor) onDownload;
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
      child: GestureDetector(
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
                                crossAxisAlignment: CrossAxisAlignment.start,
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
                                      color: fgColor.withValues(alpha: 0.75),
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
                    : Text(message.text, style: TextStyle(color: fgColor)),
              ),
              // Timestamp + delivery/read tick, bottom-right inside the bubble —
              // WhatsApp's own placement. Ticks only ever appear on OWN messages
              // (they show what happened to a message you sent); an incoming message
              // never carries them, on WhatsApp or here.
              Row(
                mainAxisSize: MainAxisSize.min,
                children: [
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
                          tick == TickState.sent ? Icons.done : Icons.done_all,
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
  }

  @override
  Widget build(BuildContext context) {
    final total = _duration ?? Duration(seconds: widget.durationHintSec ?? 0);
    final shown = _playing || _position > Duration.zero ? _position : total;
    final progress = total.inMilliseconds > 0
        ? (_position.inMilliseconds / total.inMilliseconds).clamp(0.0, 1.0)
        : 0.0;

    return SizedBox(
      width: 180,
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
        ],
      ),
    );
  }
}
