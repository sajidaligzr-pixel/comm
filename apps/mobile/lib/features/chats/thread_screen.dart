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

import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';
import 'package:file_picker/file_picker.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:image_picker/image_picker.dart';
import 'package:path_provider/path_provider.dart';
import 'package:uuid/uuid.dart';

import '../../api/api_client.dart';
import '../../api/dtos.dart';
import '../../app/providers.dart';
import '../../crypto/attachment_crypto.dart' as attach_crypto;
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
    String text = '';
    AttachmentDescriptor? attachment;
    if (isOwn && alreadyMine) {
      text = '[Sent from another device — not available on this one]';
    } else {
      try {
        final envelope = MessageEnvelope(header: dto.envelope.header, ciphertext: dto.envelope.ciphertext);
        final plaintext = await convo.decryptFromDeviceOnce(dto.id, dto.senderDeviceId, envelope, dto.x3dhInit);
        if (dto.contentTypeHint == 'media') {
          try {
            attachment = AttachmentDescriptor.fromJson(jsonDecode(bytesToUtf8(plaintext)) as Map<String, dynamic>);
          } catch (_) {
            text = '[Malformed attachment]';
          }
        } else {
          text = bytesToUtf8(plaintext);
        }
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

  /// Shared by `_send`/`_sendFile` — resolves the recipient device, runs the real
  /// X3DH/Double Ratchet encrypt, sends via REST, and echoes the result into the
  /// local cache immediately (this device already has the plaintext; no need to
  /// wait for a round trip through decrypt to display it).
  Future<void> _sendEnvelope({
    required String contentTypeHint,
    required Uint8List plaintext,
    required String cacheText,
    AttachmentDescriptor? cacheAttachment,
    MessageAttachmentRef? attachmentRef,
  }) async {
    final conversation = _conversation;
    if (conversation == null || conversation.type != 'direct') return;
    final kek = getCurrentKek();
    if (kek == null) return;

    setState(() => _sending = true);
    try {
      final target = await ref.read(conversationsApiProvider).recipientDevice(widget.conversationId);
      if (target == null) throw StateError('The other person has no reachable device right now.');

      final outgoing = await convo.encryptForDevice(ref.read(keysApiProvider), target.userId, target.deviceId, plaintext);

      final req = SendMessageRequest(
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
                  itemBuilder: (context, index) =>
                      _MessageBubble(message: _messages[index], onDownload: _downloadAttachment),
                ),
        ),
        SafeArea(
          top: false,
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
            child: Row(
              children: [
                PopupMenuButton<String>(
                  enabled: !_sending,
                  icon: const Icon(Icons.add_circle_outline),
                  onSelected: (choice) => choice == 'photo' ? _pickAndSendPhoto() : _pickAndSendFile(),
                  itemBuilder: (context) => const [
                    PopupMenuItem(value: 'photo', child: ListTile(leading: Icon(Icons.photo), title: Text('Photo'))),
                    PopupMenuItem(value: 'file', child: ListTile(leading: Icon(Icons.attach_file), title: Text('File'))),
                  ],
                ),
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
  const _MessageBubble({required this.message, required this.onDownload});
  final CachedMessage message;
  final void Function(AttachmentDescriptor) onDownload;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final fgColor = message.isOwn ? scheme.onPrimary : scheme.onSurface;
    final attachment = message.attachment;

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
