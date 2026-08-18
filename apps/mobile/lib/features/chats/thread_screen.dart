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

import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';
import 'package:file_picker/file_picker.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:image_picker/image_picker.dart';
import 'package:path_provider/path_provider.dart';
import 'package:uuid/uuid.dart';

import '../../api/api_client.dart';
import '../../api/dtos.dart';
import '../../app/app.dart' show WhatsAppColors;
import '../../app/providers.dart';
import '../../crypto/attachment_crypto.dart' as attach_crypto;
import '../../crypto/conversation_crypto.dart' as convo;
import '../../crypto/encoding.dart';
import '../../crypto/kek_holder.dart';
import '../../crypto/message_cache.dart';
import '../../crypto/session/session.dart' show MessageEnvelope;
import '../auth/auth_controller.dart';
import '../auth/auth_state.dart';
import '../calls/call_controller.dart';
import '../groups/group_session_controller.dart';

const _uuid = Uuid();

class _DecodedContent {
  final String text;
  final AttachmentDescriptor? attachment;
  const _DecodedContent({required this.text, this.attachment});
}

_DecodedContent _decodeContent(String contentTypeHint, Uint8List plaintext) {
  if (contentTypeHint == 'media') {
    try {
      return _DecodedContent(text: '', attachment: AttachmentDescriptor.fromJson(jsonDecode(bytesToUtf8(plaintext)) as Map<String, dynamic>));
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

      if (conversation.type == 'group' && conversation.groupId != null) {
        final groupController = ref.read(groupSessionControllerProvider);
        await groupController.registerGroupMembership(conversation.groupId!);
        await groupController.ensureGroupKeysUpToDate(conversation.groupId!);
      }

      final page = await ref.read(messagesApiProvider).list(widget.conversationId, limit: 100);
      final cachedIds = cached.map((m) => m.id).toSet();
      for (final dto in page.items) {
        if (cachedIds.contains(dto.id)) continue;
        await _ingestIncoming(dto, alreadyMine: dto.senderUserId == _myUserId);
      }
      await ref.read(conversationsApiProvider).markRead(widget.conversationId, page.items.isNotEmpty ? page.items.last.id : '');
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
  Future<void> _ingestIncoming(MessageDto dto, {bool alreadyMine = false, bool retriedAfterKeySync = false}) async {
    final kek = getCurrentKek();
    if (kek == null) return;

    final isOwn = dto.senderUserId == _myUserId;
    String text = '';
    AttachmentDescriptor? attachment;
    if (isOwn && alreadyMine) {
      text = '[Sent from another device — not available on this one]';
    } else if (dto.envelopeType == 'megolm_group') {
      final conversation = _conversation;
      final groupId = conversation?.groupId;
      if (groupId == null) {
        text = '[Could not decrypt this message]';
      } else {
        try {
          final envelope = EncryptedGroupEnvelope(header: dto.envelope.header, ciphertext: dto.envelope.ciphertext);
          final plaintext =
              await ref.read(groupSessionControllerProvider).decryptGroupMessageOnce(dto.id, groupId, dto.senderUserId, envelope);
          final decoded = _decodeContent(dto.contentTypeHint, plaintext);
          text = decoded.text;
          attachment = decoded.attachment;
        } catch (e) {
          if (!retriedAfterKeySync) {
            // This device may simply not have the sender's group session yet (a
            // key-share that hasn't landed) — sync once and retry before giving up,
            // mirroring the TS provider's documented "try ensureGroupKeysUpToDate
            // and retry once" contract.
            await ref.read(groupSessionControllerProvider).ensureGroupKeysUpToDate(groupId);
            return _ingestIncoming(dto, alreadyMine: alreadyMine, retriedAfterKeySync: true);
          }
          text = '[Could not decrypt this message]';
        }
      }
    } else {
      try {
        final envelope = MessageEnvelope(header: dto.envelope.header, ciphertext: dto.envelope.ciphertext);
        final plaintext = await convo.decryptFromDeviceOnce(dto.id, dto.senderDeviceId, envelope, dto.x3dhInit);
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
    if (text.isEmpty) return;
    _textController.clear();
    await _sendEnvelope(contentTypeHint: 'text', plaintext: utf8ToBytes(text), cacheText: text);
  }

  Future<void> _sendFile(Uint8List bytes, String fileName, String mimeType) async {
    setState(() => _sending = true);
    try {
      final encrypted = await attach_crypto.encryptAttachment(bytes);
      final uploaded = await ref.read(mediaApiProvider).uploadAttachmentCiphertext(encrypted.ciphertext);
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
        attachmentRef: MessageAttachmentRef(objectKey: uploaded.objectKey, encryptedSizeBytes: uploaded.encryptedSizeBytes),
      );
    } on ApiException catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(e.message)));
    } catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('Could not send that file: $e')));
    } finally {
      if (mounted) setState(() => _sending = false);
    }
  }

  /// Shared by `_send`/`_sendFile` — resolves the recipient(s), runs the real
  /// encrypt (X3DH/Double Ratchet for a direct conversation, the group ratchet via
  /// `GroupSessionController` for a group one), sends via REST, and echoes the
  /// result into the local cache immediately (this device already has the
  /// plaintext; no need to wait for a round trip through decrypt to display it).
  Future<void> _sendEnvelope({
    required String contentTypeHint,
    required Uint8List plaintext,
    required String cacheText,
    AttachmentDescriptor? cacheAttachment,
    MessageAttachmentRef? attachmentRef,
  }) async {
    final conversation = _conversation;
    if (conversation == null) return;
    final kek = getCurrentKek();
    if (kek == null) return;

    setState(() => _sending = true);
    try {
      final SendMessageRequest req;
      if (conversation.type == 'group') {
        final groupId = conversation.groupId;
        if (groupId == null) throw StateError('Missing group id.');
        final encrypted = await ref.read(groupSessionControllerProvider).encryptForGroup(groupId, _myUserId, plaintext);
        req = SendMessageRequest(
          messageId: _uuid.v4(),
          recipientDeviceId: null, // the server resolves every current member's primary device itself
          envelopeType: 'megolm_group',
          envelope: MessageEnvelopeUpload(header: encrypted.header, ciphertext: encrypted.ciphertext),
          x3dhInit: null, // group key material moves via the separate key-share channel, not per-message
          contentTypeHint: contentTypeHint,
          replyToMessageId: null,
          sentAt: DateTime.now().toUtc().toIso8601String(),
          attachment: attachmentRef,
        );
      } else {
        final target = await ref.read(conversationsApiProvider).recipientDevice(widget.conversationId);
        if (target == null) throw StateError('The other person has no reachable device right now.');

        final outgoing = await convo.encryptForDevice(ref.read(keysApiProvider), target.userId, target.deviceId, plaintext);
        req = SendMessageRequest(
          messageId: _uuid.v4(),
          recipientDeviceId: target.deviceId,
          envelopeType: 'x3dh_ratchet_1to1',
          envelope: MessageEnvelopeUpload(header: outgoing.envelope.header, ciphertext: outgoing.envelope.ciphertext),
          x3dhInit: outgoing.x3dhInit,
          contentTypeHint: contentTypeHint,
          replyToMessageId: null,
          sentAt: DateTime.now().toUtc().toIso8601String(),
          attachment: attachmentRef,
        );
      }
      final sent = await ref.read(messagesApiProvider).send(widget.conversationId, req);

      final cached = CachedMessage(
        id: sent.id,
        conversationId: widget.conversationId,
        senderUserId: _myUserId,
        isOwn: true,
        contentTypeHint: contentTypeHint,
        text: cacheText,
        sentAt: sent.sentAt,
        replyToMessageId: null,
        attachment: cacheAttachment,
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

  Future<void> _pickAndSendPhoto() async {
    final picked = await ImagePicker().pickImage(source: ImageSource.gallery, imageQuality: 90);
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
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('Downloading ${descriptor.fileName}…')));
    try {
      final ciphertext = await ref.read(mediaApiProvider).downloadAttachmentCiphertext(descriptor.objectKey);
      final plaintext = await attach_crypto.decryptAttachment(ciphertext, base64ToBytes(descriptor.key), base64ToBytes(descriptor.nonce));

      final dir = await getApplicationDocumentsDirectory();
      final savedDir = Directory('${dir.path}/comm-downloads')..createSync(recursive: true);
      final file = File('${savedDir.path}/${descriptor.fileName}');
      await file.writeAsBytes(plaintext);

      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('Saved ${descriptor.fileName} to app storage')));
      }
    } catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('Could not download: $e')));
    }
  }

  @override
  Widget build(BuildContext context) {
    final conversation = _conversation;
    final isGroup = conversation != null && conversation.type == 'group' && conversation.groupId != null;
    return Scaffold(
      appBar: AppBar(
        title: InkWell(
          onTap: isGroup ? () => context.push('/groups/${conversation.groupId}/info') : null,
          child: Text(conversation?.displayTitle() ?? 'Chat'),
        ),
        actions: [
          if (conversation != null && conversation.type == 'direct' && conversation.otherUserId != null)
            IconButton(
              icon: const Icon(Icons.call),
              tooltip: 'Call',
              onPressed: () => ref
                  .read(callControllerProvider.notifier)
                  .startCall(widget.conversationId, conversation.otherUserId!, conversation.displayTitle()),
            ),
          if (isGroup)
            IconButton(icon: const Icon(Icons.info_outline), tooltip: 'Group info', onPressed: () => context.push('/groups/${conversation.groupId}/info')),
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
    if (_error != null) return Center(child: Text(_error!));

    return Column(
      children: [
        Expanded(
          child: _messages.isEmpty
              ? const Center(child: Text('No messages yet — say hello.'))
              : ListView.builder(
                  controller: _scrollController,
                  padding: const EdgeInsets.all(12),
                  itemCount: _messages.length,
                  itemBuilder: (context, index) =>
                      _MessageBubble(message: _messages[index], onDownload: _downloadAttachment),
                ),
        ),
        // The compose bar sits on its own white strip above the keyboard, same as
        // WhatsApp — distinct from the beige thread background behind it.
        Container(
          color: WhatsAppColors.listBackground,
          child: SafeArea(
            top: false,
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 8),
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.end,
                children: [
                  PopupMenuButton<String>(
                    enabled: !_sending,
                    icon: const Icon(Icons.attach_file, color: WhatsAppColors.tealAccent),
                    onSelected: (choice) => choice == 'photo' ? _pickAndSendPhoto() : _pickAndSendFile(),
                    itemBuilder: (context) => const [
                      PopupMenuItem(value: 'photo', child: ListTile(leading: Icon(Icons.photo), title: Text('Photo'))),
                      PopupMenuItem(value: 'file', child: ListTile(leading: Icon(Icons.attach_file), title: Text('File'))),
                    ],
                  ),
                  Expanded(
                    child: Container(
                      constraints: const BoxConstraints(minHeight: 44),
                      padding: const EdgeInsets.symmetric(horizontal: 16),
                      decoration: BoxDecoration(color: const Color(0xFFF0F0F0), borderRadius: BorderRadius.circular(24)),
                      child: TextField(
                        controller: _textController,
                        decoration: const InputDecoration(hintText: 'Message', border: InputBorder.none, isCollapsed: true),
                        style: const TextStyle(color: WhatsAppColors.bubbleText),
                        minLines: 1,
                        maxLines: 5,
                        textInputAction: TextInputAction.send,
                        onSubmitted: (_) => _send(),
                      ),
                    ),
                  ),
                  const SizedBox(width: 8),
                  // Round green send button — WhatsApp's own shape, not the
                  // square filled-icon-button Material default.
                  Material(
                    color: WhatsAppColors.green,
                    shape: const CircleBorder(),
                    child: InkWell(
                      customBorder: const CircleBorder(),
                      onTap: _sending ? null : _send,
                      child: Padding(
                        padding: const EdgeInsets.all(10),
                        child: _sending
                            ? const SizedBox(
                                width: 20,
                                height: 20,
                                child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white),
                              )
                            : const Icon(Icons.send, color: Colors.white, size: 20),
                      ),
                    ),
                  ),
                ],
              ),
            ),
          ),
        ),
      ],
    );
  }
}

class _MessageBubble extends StatelessWidget {
  const _MessageBubble({required this.message, required this.onDownload});
  final CachedMessage message;
  final void Function(AttachmentDescriptor) onDownload;

  @override
  Widget build(BuildContext context) {
    // WhatsApp uses the same near-black text on both bubble colors — never a
    // light-on-primary combination the way a generic Material bubble would.
    const fgColor = WhatsAppColors.bubbleText;
    final attachment = message.attachment;

    return Align(
      alignment: message.isOwn ? Alignment.centerRight : Alignment.centerLeft,
      child: Container(
        margin: const EdgeInsets.symmetric(vertical: 2),
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
        constraints: BoxConstraints(maxWidth: MediaQuery.of(context).size.width * 0.78),
        decoration: BoxDecoration(
          color: message.isOwn ? WhatsAppColors.outgoingBubble : WhatsAppColors.incomingBubble,
          // The pinched corner on the side nearest the sender approximates
          // WhatsApp's speech-bubble tail — a plain uniform radius reads as a
          // generic chat bubble, not specifically WhatsApp's.
          borderRadius: BorderRadius.only(
            topLeft: const Radius.circular(8),
            topRight: const Radius.circular(8),
            bottomLeft: Radius.circular(message.isOwn ? 8 : 0),
            bottomRight: Radius.circular(message.isOwn ? 0 : 8),
          ),
          boxShadow: const [BoxShadow(color: Color(0x14000000), blurRadius: 1, offset: Offset(0, 1))],
        ),
        child: attachment != null
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
                          Text(attachment.fileName, style: TextStyle(color: fgColor), overflow: TextOverflow.ellipsis),
                          Text(_formatBytes(attachment.sizeBytes), style: TextStyle(color: fgColor.withValues(alpha: 0.75), fontSize: 12)),
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
    );
  }
}

String _formatBytes(int bytes) {
  if (bytes < 1024) return '$bytes B';
  if (bytes < 1024 * 1024) return '${(bytes / 1024).toStringAsFixed(1)} KB';
  return '${(bytes / (1024 * 1024)).toStringAsFixed(1)} MB';
}
