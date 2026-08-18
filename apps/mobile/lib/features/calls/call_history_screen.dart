/// The "Calls" tab (asked for directly — WhatsApp's own call log) — every 1:1 call
/// across every conversation, newest first, direction + outcome shown per row the
/// same way WhatsApp's does. Pushed from a new AppBar icon on chats_list_screen.dart
/// rather than folded into a bottom-tab-bar shell: this app has no tab bar anywhere
/// else (Devices/Admin are the same "pushed screen from an AppBar icon" shape this
/// follows), and introducing one just for this single screen would be a much larger,
/// unrequested navigation restructure.
library;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../api/api_client.dart';
import '../../api/calls_api.dart';
import '../../app/app.dart' show WhatsAppColors;
import '../../app/providers.dart';
import '../../shared/widgets/error_state.dart';
import 'call_controller.dart';

class CallHistoryScreen extends ConsumerStatefulWidget {
  const CallHistoryScreen({super.key});
  @override
  ConsumerState<CallHistoryScreen> createState() => _CallHistoryScreenState();
}

class _CallHistoryScreenState extends ConsumerState<CallHistoryScreen> {
  List<CallHistoryEntry>? _calls;
  String? _error;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() => _error = null);
    try {
      final calls = await ref.read(callsApiProvider).history();
      if (mounted) setState(() => _calls = calls);
    } on ApiException catch (e) {
      if (mounted) setState(() => _error = e.message);
    }
  }

  void _callAgain(CallHistoryEntry entry) {
    final otherUserId = entry.otherUserId;
    if (otherUserId == null) return;
    ref
        .read(callControllerProvider.notifier)
        .startCall(entry.conversationId, otherUserId, entry.displayName());
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Calls')),
      body: _buildBody(),
    );
  }

  Widget _buildBody() {
    if (_error != null) return ErrorState(message: _error!, onRetry: _load);
    final calls = _calls;
    if (calls == null) return const Center(child: CircularProgressIndicator());
    if (calls.isEmpty) {
      return const EmptyState(
        icon: Icons.call_outlined,
        message: 'No calls yet — calls you make or receive will show up here.',
      );
    }

    return RefreshIndicator(
      onRefresh: _load,
      child: ListView(
        children: [
          for (var i = 0; i < calls.length; i++) ...[
            if (i > 0) const Divider(height: 1),
            _CallRow(entry: calls[i], onTap: () => _callAgain(calls[i])),
          ],
        ],
      ),
    );
  }
}

class _CallRow extends StatelessWidget {
  const _CallRow({required this.entry, required this.onTap});
  final CallHistoryEntry entry;
  final VoidCallback onTap;

  bool get _missedOrDeclined => entry.status != 'answered';
  bool get _isIncoming => entry.direction == 'incoming';

  @override
  Widget build(BuildContext context) {
    final name = entry.displayName();
    // Red is reserved for a missed/declined call on the RECEIVING end — the same
    // WhatsApp convention this mirrors: an unanswered outgoing call reads as
    // unremarkable (you tried, no one picked up), but an incoming one you missed is
    // the one worth calling out visually.
    final directionColor = _isIncoming && _missedOrDeclined
        ? Theme.of(context).colorScheme.error
        : WhatsAppColors.tealAccent;
    final directionIcon = _isIncoming ? Icons.call_received : Icons.call_made;

    return ListTile(
      leading: CircleAvatar(
        child: Text(name.isNotEmpty ? name[0].toUpperCase() : '?'),
      ),
      title: Text(
        name,
        style: _missedOrDeclined && _isIncoming
            ? TextStyle(color: Theme.of(context).colorScheme.error)
            : null,
      ),
      subtitle: Row(
        children: [
          Icon(directionIcon, size: 15, color: directionColor),
          const SizedBox(width: 4),
          Text(_subtitleText()),
        ],
      ),
      trailing: IconButton(
        icon: const Icon(Icons.call, color: WhatsAppColors.tealAccent),
        onPressed: onTap,
        tooltip: 'Call again',
      ),
      onTap: onTap,
    );
  }

  String _subtitleText() {
    final outcome = switch (entry.status) {
      'missed' => _isIncoming ? 'Missed' : 'No answer',
      'declined' => _isIncoming ? 'Declined' : 'Declined',
      _ => _isIncoming ? 'Incoming' : 'Outgoing',
    };
    final duration = entry.callDuration();
    final time = _formatWhen(entry.createdAt);
    if (duration != null) {
      return '$outcome · ${_formatDuration(duration)} · $time';
    }
    return '$outcome · $time';
  }
}

String _formatDuration(Duration d) {
  final m = d.inMinutes.remainder(60).toString().padLeft(2, '0');
  final s = d.inSeconds.remainder(60).toString().padLeft(2, '0');
  final h = d.inHours;
  return h > 0 ? '$h:$m:$s' : '$m:$s';
}

/// Same relative-time shape devices_screen.dart's own `_relativeTime` uses for
/// "Last active" — kept as its own small copy rather than shared, matching how
/// small this each of these formatters is (not worth a shared utils file for two
/// three-line functions with slightly different rounding needs).
String _formatWhen(String iso) {
  final time = DateTime.tryParse(iso);
  if (time == null) return iso;
  final now = DateTime.now().toUtc();
  final local = time.toUtc();
  final diff = now.difference(local);
  if (diff.inMinutes < 1) return 'Just now';
  if (diff.inHours < 1) return '${diff.inMinutes}m ago';
  if (diff.inHours < 24) return '${diff.inHours}h ago';
  if (diff.inDays < 7) return '${diff.inDays}d ago';
  final local2 = local.toLocal();
  return '${local2.month}/${local2.day}/${local2.year}';
}
