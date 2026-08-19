/// "Forward" — mobile counterpart to apps/web/components/chat/forward-dialog.tsx,
/// see that file's docstring for the underlying reasoning (the client already holds
/// the decrypted plaintext of any rendered bubble; forwarding is just "re-run the
/// normal send path against a different conversation," not a new crypto primitive).
/// A `media` attachment is the one content type needing real work: its ciphertext
/// lives in object storage under a single-use pending-upload authorization tied to
/// the ORIGINAL message, so this downloads + decrypts the source once, then
/// re-encrypts and re-uploads a fresh copy per target conversation.
library;

import 'dart:convert';
import 'dart:typed_data';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:uuid/uuid.dart';

import '../../api/api_client.dart';
import '../../api/dtos.dart';
import '../../app/providers.dart';
import '../../crypto/attachment_crypto.dart' as attach_crypto;
import '../../crypto/conversation_crypto.dart' as convo;
import '../../crypto/encoding.dart';
import '../../crypto/kek_holder.dart';
import '../../crypto/message_cache.dart';

const _uuid = Uuid();

/// Shows the forward picker as a scrollable bottom sheet. Fire-and-forget from the
/// caller's point of view — errors are surfaced via a SnackBar on the sheet itself,
/// same as every other async action in this screen.
void showForwardSheet(
  BuildContext context, {
  required String currentUserId,
  required CachedMessage message,
}) {
  showModalBottomSheet<void>(
    context: context,
    isScrollControlled: true,
    builder: (context) =>
        _ForwardSheet(currentUserId: currentUserId, message: message),
  );
}

class _ForwardSheet extends ConsumerStatefulWidget {
  const _ForwardSheet({required this.currentUserId, required this.message});
  final String currentUserId;
  final CachedMessage message;

  @override
  ConsumerState<_ForwardSheet> createState() => _ForwardSheetState();
}

class _ForwardSheetState extends ConsumerState<_ForwardSheet> {
  List<ConversationSummary>? _conversations;
  final Set<String> _selected = {};
  String _search = '';
  bool _sending = false;
  String? _error;
  bool _done = false;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      final list = await ref.read(conversationsApiProvider).list();
      if (mounted) setState(() => _conversations = list);
    } on ApiException catch (e) {
      if (mounted) setState(() => _error = e.message);
    }
  }

  /// Re-derives fresh plaintext (and, for `media`, a fresh uploaded copy) for
  /// each target — the ONE exception is the decrypted source file, downloaded
  /// once by the caller and passed in here, since it doesn't depend on which
  /// conversation it's headed to.
  Future<
    ({
      Uint8List plaintext,
      MessageAttachmentRef? attachmentRef,
      AttachmentDescriptor? descriptor,
    })
  >
  _resolvePlaintext(Uint8List? decryptedFile) async {
    final m = widget.message;
    if (m.contentTypeHint == 'text') {
      return (
        plaintext: utf8ToBytes(m.text),
        attachmentRef: null,
        descriptor: null,
      );
    }
    if (m.contentTypeHint == 'voice') {
      return (
        plaintext: base64ToBytes(m.mediaBase64 ?? ''),
        attachmentRef: null,
        descriptor: null,
      );
    }
    // media — re-encrypt + re-upload a fresh copy for THIS target.
    if (decryptedFile == null) {
      throw StateError('That file could not be forwarded.');
    }
    final encrypted = await attach_crypto.encryptAttachment(decryptedFile);
    final uploaded = await ref
        .read(mediaApiProvider)
        .uploadAttachmentCiphertext(encrypted.ciphertext);
    final descriptor = AttachmentDescriptor(
      objectKey: uploaded.objectKey,
      key: bytesToBase64(encrypted.key),
      nonce: bytesToBase64(encrypted.nonce),
      mimeType: m.attachment?.mimeType ?? 'application/octet-stream',
      fileName: m.attachment?.fileName ?? 'File',
      sizeBytes: m.attachment?.sizeBytes ?? decryptedFile.length,
    );
    return (
      plaintext: utf8ToBytes(jsonEncode(descriptor.toJson())),
      attachmentRef: MessageAttachmentRef(
        objectKey: uploaded.objectKey,
        encryptedSizeBytes: uploaded.encryptedSizeBytes,
      ),
      descriptor: descriptor,
    );
  }

  Future<void> _sendTo(
    ConversationSummary target,
    Uint8List plaintext,
    MessageAttachmentRef? attachmentRef,
    AttachmentDescriptor? descriptor,
  ) async {
    final kek = getCurrentKek();
    if (kek == null) {
      throw StateError('This device is locked. Please sign in again.');
    }
    final messageId = _uuid.v4();
    final sentAt = DateTime.now().toUtc().toIso8601String();
    final m = widget.message;

    final SendMessageRequest req;
    if (target.type == 'group') {
      final groupId = target.groupId;
      if (groupId == null) throw StateError('Missing group id.');
      final encrypted = await ref
          .read(groupSessionControllerProvider)
          .encryptForGroup(groupId, widget.currentUserId, plaintext);
      req = SendMessageRequest(
        messageId: messageId,
        envelopeType: 'megolm_group',
        envelope: MessageEnvelopeUpload(
          header: encrypted.header,
          ciphertext: encrypted.ciphertext,
        ),
        x3dhInit: null,
        contentTypeHint: m.contentTypeHint,
        replyToMessageId: null,
        sentAt: sentAt,
        attachment: attachmentRef,
      );
    } else {
      final otherMemberDevices = await ref
          .read(conversationsApiProvider)
          .recipientDevices(target.id);
      final ownDevices = await ref.read(devicesApiProvider).list();
      final ownOtherDevices = ownDevices
          .where((d) => !d.isCurrentDevice && d.status == 'active')
          .map((d) => (userId: widget.currentUserId, deviceId: d.id));
      final targets = [...otherMemberDevices, ...ownOtherDevices];
      if (targets.isEmpty) {
        throw StateError(
          '${target.displayTitle()} has no reachable device right now.',
        );
      }
      final recipients = <RecipientEnvelope>[];
      for (final t in targets) {
        final outgoing = await convo.encryptForDevice(
          ref.read(keysApiProvider),
          t.userId,
          t.deviceId,
          plaintext,
        );
        recipients.add(
          RecipientEnvelope(
            deviceId: t.deviceId,
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
        contentTypeHint: m.contentTypeHint,
        replyToMessageId: null,
        sentAt: sentAt,
        attachment: attachmentRef,
      );
    }

    await ref.read(messagesApiProvider).send(target.id, req);

    // Same reasoning as message-thread.tsx's identical cache write: this
    // device's own outgoing plaintext is only ever knowable at the instant it's
    // sent, and the target thread's own catch-up fetch deliberately skips
    // re-decrypting the caller's own messages — without this, a forward into a
    // conversation that isn't currently open would never show up in this
    // device's own view of it.
    await appendCachedMessage(
      kek,
      CachedMessage(
        id: messageId,
        conversationId: target.id,
        senderUserId: widget.currentUserId,
        isOwn: true,
        contentTypeHint: m.contentTypeHint,
        text: m.text,
        sentAt: sentAt,
        replyToMessageId: null,
        attachment: descriptor,
        mediaBase64: m.mediaBase64,
        mediaDurationSec: m.mediaDurationSec,
      ),
    );
  }

  Future<void> _forward() async {
    final conversations = _conversations;
    if (conversations == null || _selected.isEmpty) return;
    setState(() {
      _sending = true;
      _error = null;
    });
    try {
      Uint8List? decryptedFile;
      final attachment = widget.message.attachment;
      if (widget.message.contentTypeHint == 'media' && attachment != null) {
        final ciphertext = await ref
            .read(mediaApiProvider)
            .downloadAttachmentCiphertext(attachment.objectKey);
        decryptedFile = await attach_crypto.decryptAttachment(
          ciphertext,
          base64ToBytes(attachment.key),
          base64ToBytes(attachment.nonce),
        );
      }
      final targets = conversations.where((c) => _selected.contains(c.id));
      for (final target in targets) {
        final resolved = await _resolvePlaintext(decryptedFile);
        await _sendTo(
          target,
          resolved.plaintext,
          resolved.attachmentRef,
          resolved.descriptor,
        );
      }
      if (!mounted) return;
      setState(() => _done = true);
      await Future<void>.delayed(const Duration(milliseconds: 600));
      if (mounted) Navigator.of(context).pop();
    } on ApiException catch (e) {
      if (mounted) setState(() => _error = e.message);
    } catch (e) {
      if (mounted) setState(() => _error = 'Could not forward that message.');
    } finally {
      if (mounted) setState(() => _sending = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final conversations = _conversations;
    final query = _search.trim().toLowerCase();
    final filtered = (conversations ?? [])
        .where((c) => c.displayTitle().toLowerCase().contains(query))
        .toList();

    return DraggableScrollableSheet(
      initialChildSize: 0.75,
      minChildSize: 0.4,
      maxChildSize: 0.92,
      expand: false,
      builder: (context, scrollController) => SafeArea(
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 16),
          child: Column(
            children: [
              const SizedBox(height: 12),
              Text(
                'Forward message',
                style: Theme.of(context).textTheme.titleMedium,
              ),
              const SizedBox(height: 12),
              TextField(
                decoration: const InputDecoration(
                  hintText: 'Search chats',
                  prefixIcon: Icon(Icons.search),
                  isDense: true,
                  border: OutlineInputBorder(
                    borderRadius: BorderRadius.all(Radius.circular(24)),
                  ),
                ),
                onChanged: (v) => setState(() => _search = v),
              ),
              const SizedBox(height: 8),
              if (conversations == null && _error == null)
                const Expanded(
                  child: Center(child: CircularProgressIndicator()),
                ),
              if (conversations != null)
                Expanded(
                  child: filtered.isEmpty
                      ? const Center(child: Text('No chats found.'))
                      : ListView.builder(
                          controller: scrollController,
                          itemCount: filtered.length,
                          itemBuilder: (context, index) {
                            final c = filtered[index];
                            final isSelected = _selected.contains(c.id);
                            return CheckboxListTile(
                              value: isSelected,
                              onChanged: (_) => setState(() {
                                if (isSelected) {
                                  _selected.remove(c.id);
                                } else {
                                  _selected.add(c.id);
                                }
                              }),
                              secondary: CircleAvatar(
                                child: Text(
                                  c.displayTitle().isNotEmpty
                                      ? c.displayTitle()[0].toUpperCase()
                                      : '?',
                                ),
                              ),
                              title: Text(c.displayTitle()),
                              controlAffinity: ListTileControlAffinity.trailing,
                            );
                          },
                        ),
                ),
              if (_error != null)
                Padding(
                  padding: const EdgeInsets.symmetric(vertical: 8),
                  child: Text(
                    _error!,
                    style: TextStyle(
                      color: Theme.of(context).colorScheme.error,
                    ),
                  ),
                ),
              if (_done)
                const Padding(
                  padding: EdgeInsets.symmetric(vertical: 8),
                  child: Text('Forwarded.'),
                ),
              Padding(
                padding: const EdgeInsets.symmetric(vertical: 12),
                child: SizedBox(
                  width: double.infinity,
                  child: FilledButton(
                    onPressed: (_selected.isEmpty || _sending)
                        ? null
                        : _forward,
                    child: Text(
                      _sending
                          ? 'Forwarding…'
                          : _selected.isEmpty
                          ? 'Forward'
                          : 'Forward to ${_selected.length}',
                    ),
                  ),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
