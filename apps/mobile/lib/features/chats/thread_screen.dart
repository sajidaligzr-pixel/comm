/// The core "does end-to-end encryption actually work" screen: loads history,
/// decrypts every incoming ciphertext via the real X3DH/Double Ratchet session
/// machinery (crypto/conversation_crypto.dart), sends new messages the same way the
/// web client does (REST, not WS — see messages_api.dart's docstring), and reacts to
/// live `new` events over the realtime socket.
///
/// Group conversations are intentionally NOT wired to real encryption here yet — the
/// group ratchet primitives exist and are tested (crypto/group/), but the session
/// distribution/state-machine layer (the mobile equivalent of
/// apps/web/components/group/group-session-provider.tsx) is a separate, larger
/// follow-up milestone. Opening a group conversation here shows a clear placeholder
/// rather than silently pretending to send.
library;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:uuid/uuid.dart';

import '../../api/api_client.dart';
import '../../api/dtos.dart';
import '../../app/providers.dart';
import '../../crypto/conversation_crypto.dart' as convo;
import '../../crypto/encoding.dart';
import '../../crypto/kek_holder.dart';
import '../../crypto/message_cache.dart';
import '../../crypto/session/session.dart' show MessageEnvelope;
import '../auth/auth_controller.dart';
import '../auth/auth_state.dart';

const _uuid = Uuid();

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
  final _scrollController = ScrollController();
  String? _error;
  bool _loading = true;
  bool _sending = false;

  String get _myUserId {
    final state = ref.read(authControllerProvider);
    return state is AuthSignedIn ? state.profile.id : '';
  }

  @override
  void initState() {
    super.initState();
    _load();
    ref.read(realtimeClientProvider).on('new', _onRealtimeNew);
  }

  @override
  void dispose() {
    ref.read(realtimeClientProvider).off('new', _onRealtimeNew);
    _textController.dispose();
    _scrollController.dispose();
    super.dispose();
  }

  void _onRealtimeNew(Map<String, dynamic> payload) {
    final raw = payload['message'];
    if (raw is! Map<String, dynamic>) return;
    final dto = MessageDto.fromJson(raw);
    if (dto.conversationId != widget.conversationId) return;
    _ingestIncoming(dto);
  }

  Future<void> _load() async {
    try {
      final conversation = await ref.read(conversationsApiProvider).get(widget.conversationId);
      final kek = getCurrentKek();
      if (kek == null) throw StateError('Local keys are locked.');

      final cached = await loadCachedMessages(kek, widget.conversationId);
      if (mounted) {
        setState(() {
          _conversation = conversation;
          _messages
            ..clear()
            ..addAll(cached);
        });
      }

      if (conversation.type == 'direct') {
        final page = await ref.read(messagesApiProvider).list(widget.conversationId, limit: 100);
        final cachedIds = cached.map((m) => m.id).toSet();
        for (final dto in page.items) {
          if (cachedIds.contains(dto.id)) continue;
          await _ingestIncoming(dto, alreadyMine: dto.senderUserId == _myUserId);
        }
        await ref.read(conversationsApiProvider).markRead(widget.conversationId, page.items.isNotEmpty ? page.items.last.id : '');
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

  /// `alreadyMine` covers REST history backfill for this device's OWN earlier sent
  /// messages that never made it into the local cache (e.g. sent from a different
  /// device) — those ciphertexts can never be decrypted (a sending chain is
  /// one-directional), so they're shown as a placeholder rather than silently
  /// dropped or crashing the load.
  Future<void> _ingestIncoming(MessageDto dto, {bool alreadyMine = false}) async {
    final kek = getCurrentKek();
    if (kek == null) return;

    final isOwn = dto.senderUserId == _myUserId;
    String text;
    if (isOwn && alreadyMine) {
      text = '[Sent from another device — not available on this one]';
    } else {
      try {
        final envelope = MessageEnvelope(header: dto.envelope.header, ciphertext: dto.envelope.ciphertext);
        final plaintext = await convo.decryptFromDeviceOnce(dto.id, dto.senderDeviceId, envelope, dto.x3dhInit);
        text = bytesToUtf8(plaintext);
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
    );
    await appendCachedMessage(kek, cached);
    if (mounted) {
      setState(() {
        if (!_messages.any((m) => m.id == cached.id)) _messages.add(cached);
        _messages.sort((a, b) => a.sentAt.compareTo(b.sentAt));
      });
      _scrollToBottom();
    }
    if (!isOwn) {
      await ref.read(messagesApiProvider).markDelivered(dto.id).catchError((_) {});
    }
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
    final conversation = _conversation;
    if (text.isEmpty || conversation == null || conversation.type != 'direct') return;

    final kek = getCurrentKek();
    if (kek == null) return;

    setState(() => _sending = true);
    _textController.clear();
    try {
      final target = await ref.read(conversationsApiProvider).recipientDevice(widget.conversationId);
      if (target == null) throw StateError('The other person has no reachable device right now.');

      final outgoing = await convo.encryptForDevice(
        ref.read(keysApiProvider),
        target.userId,
        target.deviceId,
        utf8ToBytes(text),
      );

      final messageId = _uuid.v4();
      final req = SendMessageRequest(
        messageId: messageId,
        recipientDeviceId: target.deviceId,
        envelopeType: 'x3dh_ratchet_1to1',
        envelope: MessageEnvelopeUpload(header: outgoing.envelope.header, ciphertext: outgoing.envelope.ciphertext),
        x3dhInit: outgoing.x3dhInit,
        contentTypeHint: 'text',
        replyToMessageId: null,
        sentAt: DateTime.now().toUtc().toIso8601String(),
      );
      final sent = await ref.read(messagesApiProvider).send(widget.conversationId, req);

      final cached = CachedMessage(
        id: sent.id,
        conversationId: widget.conversationId,
        senderUserId: _myUserId,
        isOwn: true,
        contentTypeHint: 'text',
        text: text,
        sentAt: sent.sentAt,
        replyToMessageId: null,
      );
      await appendCachedMessage(kek, cached);
      if (mounted) {
        setState(() => _messages.add(cached));
        _scrollToBottom();
      }
    } on ApiException catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(e.message)));
    } catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('Could not send: $e')));
    } finally {
      if (mounted) setState(() => _sending = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: Text(_conversation?.displayTitle() ?? 'Chat')),
      body: SafeArea(child: _buildBody()),
    );
  }

  Widget _buildBody() {
    if (_loading) return const Center(child: CircularProgressIndicator());
    if (_error != null) return Center(child: Text(_error!));

    final conversation = _conversation;
    if (conversation != null && conversation.type == 'group') {
      return const Center(
        child: Padding(
          padding: EdgeInsets.all(24),
          child: Text(
            'Group messaging isn\'t wired up in the app yet — the encryption is built and tested, '
            'but the group session UI is a follow-up milestone.',
            textAlign: TextAlign.center,
          ),
        ),
      );
    }

    return Column(
      children: [
        Expanded(
          child: _messages.isEmpty
              ? const Center(child: Text('No messages yet — say hello.'))
              : ListView.builder(
                  controller: _scrollController,
                  padding: const EdgeInsets.all(12),
                  itemCount: _messages.length,
                  itemBuilder: (context, index) => _MessageBubble(message: _messages[index]),
                ),
        ),
        SafeArea(
          top: false,
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
            child: Row(
              children: [
                Expanded(
                  child: TextField(
                    controller: _textController,
                    decoration: const InputDecoration(hintText: 'Message', border: OutlineInputBorder()),
                    minLines: 1,
                    maxLines: 5,
                    textInputAction: TextInputAction.send,
                    onSubmitted: (_) => _send(),
                  ),
                ),
                const SizedBox(width: 8),
                IconButton.filled(
                  onPressed: _sending ? null : _send,
                  icon: _sending
                      ? const SizedBox(width: 16, height: 16, child: CircularProgressIndicator(strokeWidth: 2))
                      : const Icon(Icons.send),
                ),
              ],
            ),
          ),
        ),
      ],
    );
  }
}

class _MessageBubble extends StatelessWidget {
  const _MessageBubble({required this.message});
  final CachedMessage message;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Align(
      alignment: message.isOwn ? Alignment.centerRight : Alignment.centerLeft,
      child: Container(
        margin: const EdgeInsets.symmetric(vertical: 4),
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
        constraints: BoxConstraints(maxWidth: MediaQuery.of(context).size.width * 0.75),
        decoration: BoxDecoration(
          color: message.isOwn ? scheme.primary : scheme.surfaceContainerHighest,
          borderRadius: BorderRadius.circular(16),
        ),
        child: Text(message.text, style: TextStyle(color: message.isOwn ? scheme.onPrimary : scheme.onSurface)),
      ),
    );
  }
}
