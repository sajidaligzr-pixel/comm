/// "Seen by" for a group message — mobile counterpart to
/// apps/web/components/chat/message-info-dialog.tsx, see that file's docstring
/// for the underlying reasoning (scoped to groups only; the data has already
/// been recorded for every member since the group-chat pass shipped, this is
/// purely a new read surface over it).
library;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../api/api_client.dart';
import '../../api/dtos.dart';
import '../../app/providers.dart';

const _months = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

/// No `intl` dependency for one timestamp format — manual, same spirit as
/// thread_screen.dart's own `_formatBubbleTime`, just with a date prefix.
String _formatTimestamp(DateTime dt) {
  final hour12 = dt.hour % 12 == 0 ? 12 : dt.hour % 12;
  final minute = dt.minute.toString().padLeft(2, '0');
  final period = dt.hour < 12 ? 'AM' : 'PM';
  return '${_months[dt.month - 1]} ${dt.day}, $hour12:$minute $period';
}

void showMessageInfoSheet(
  BuildContext context,
  WidgetRef ref, {
  required String groupId,
  required String messageId,
  required String currentUserId,
}) {
  showModalBottomSheet<void>(
    context: context,
    isScrollControlled: true,
    builder: (context) => _MessageInfoSheet(
      groupId: groupId,
      messageId: messageId,
      currentUserId: currentUserId,
    ),
  );
}

class _MessageInfoSheet extends ConsumerStatefulWidget {
  const _MessageInfoSheet({
    required this.groupId,
    required this.messageId,
    required this.currentUserId,
  });
  final String groupId;
  final String messageId;
  final String currentUserId;

  @override
  ConsumerState<_MessageInfoSheet> createState() => _MessageInfoSheetState();
}

class _MessageInfoSheetState extends ConsumerState<_MessageInfoSheet> {
  List<GroupMemberDto>? _members;
  List<MessageReceiptDto>? _receipts;
  String? _error;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      final groupFuture = ref.read(groupsApiProvider).get(widget.groupId);
      final receiptsFuture = ref
          .read(messagesApiProvider)
          .receipts(widget.messageId);
      final group = await groupFuture;
      final receipts = await receiptsFuture;
      if (mounted) {
        setState(() {
          _members = group.members
              .where((m) => m.userId != widget.currentUserId)
              .toList();
          _receipts = receipts;
        });
      }
    } on ApiException catch (e) {
      if (mounted) setState(() => _error = e.message);
    }
  }

  @override
  Widget build(BuildContext context) {
    final members = _members;
    final receipts = _receipts;
    final byUser = <String, MessageReceiptDto>{
      for (final r in (receipts ?? [])) r.userId: r,
    };

    List<GroupMemberDto> readBy = [];
    List<GroupMemberDto> deliveredOnly = [];
    List<GroupMemberDto> notYet = [];
    if (members != null) {
      for (final m in members) {
        final r = byUser[m.userId];
        if (r?.readAt != null) {
          readBy.add(m);
        } else if (r?.deliveredAt != null) {
          deliveredOnly.add(m);
        } else {
          notYet.add(m);
        }
      }
    }

    return DraggableScrollableSheet(
      initialChildSize: 0.6,
      minChildSize: 0.3,
      maxChildSize: 0.9,
      expand: false,
      builder: (context, scrollController) => SafeArea(
        child: ListView(
          controller: scrollController,
          padding: const EdgeInsets.all(16),
          children: [
            Text(
              'Message info',
              style: Theme.of(context).textTheme.titleMedium,
            ),
            const SizedBox(height: 12),
            if (_error != null)
              Text(
                _error!,
                style: TextStyle(color: Theme.of(context).colorScheme.error),
              ),
            if (_error == null && members == null)
              const Center(child: CircularProgressIndicator()),
            if (_error == null && members != null) ...[
              _section(
                context,
                'Read by ${readBy.length}',
                readBy,
                byUser,
                (r) => r.readAt,
              ),
              _section(
                context,
                'Delivered to ${deliveredOnly.length}',
                deliveredOnly,
                byUser,
                (r) => r.deliveredAt,
              ),
              if (notYet.isNotEmpty)
                _section(
                  context,
                  'Not delivered yet',
                  notYet,
                  byUser,
                  (_) => null,
                ),
            ],
          ],
        ),
      ),
    );
  }

  Widget _section(
    BuildContext context,
    String title,
    List<GroupMemberDto> people,
    Map<String, MessageReceiptDto> byUser,
    String? Function(MessageReceiptDto) timestampOf,
  ) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 12),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            title.toUpperCase(),
            style: Theme.of(context).textTheme.labelSmall?.copyWith(
              color: Theme.of(context).colorScheme.onSurfaceVariant,
              fontWeight: FontWeight.w600,
            ),
          ),
          if (people.isEmpty)
            const Padding(
              padding: EdgeInsets.symmetric(vertical: 6),
              child: Text('No one yet.'),
            ),
          for (final m in people)
            ListTile(
              contentPadding: EdgeInsets.zero,
              leading: CircleAvatar(
                child: Text(
                  m.displayName.isNotEmpty
                      ? m.displayName[0].toUpperCase()
                      : '?',
                ),
              ),
              title: Text(m.displayName),
              subtitle: () {
                final r = byUser[m.userId];
                final iso = r == null ? null : timestampOf(r);
                if (iso == null) return null;
                final dt = DateTime.tryParse(iso)?.toLocal();
                return dt == null ? null : Text(_formatTimestamp(dt));
              }(),
            ),
        ],
      ),
    );
  }
}
