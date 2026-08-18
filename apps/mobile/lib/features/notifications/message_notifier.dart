/// Turns a live `new` WS event into a system notification — the piece that makes
/// local_notifications.dart actually fire without the user having to reopen the
/// app first (the exact bug reported: a message would only ever show up the next
/// time the app was opened, never live). Mounted once at app-shell level (a plain
/// `Provider` in app/providers.dart), same placement reasoning as
/// `GroupSessionController`: a message can arrive for ANY conversation regardless
/// of which screen happens to be open right now, not just while a specific thread
/// is mounted.
///
/// Deliberately does not decrypt the message to show a real content preview — it
/// only ever shows a conversation name + a generic "New message." Decrypting here
/// would run the exact same Double Ratchet/group-ratchet decrypt path
/// thread_screen.dart's own catch-up loop uses, and this listener has no way to
/// guarantee it runs in the correct order relative to that loop (a WS event racing
/// a thread's own REST catch-up) — for a stateful, order-sensitive ratchet, an
/// out-of-order decrypt attempt from here risks desyncing session state in exactly
/// the way `decryptFromDeviceOnce`'s own memoization was built to prevent for
/// *concurrent* attempts at the *same* message, not this different hazard of two
/// *different* messages decrypted out of order. Not worth that risk for a
/// notification preview.
library;

import '../../api/dtos.dart';
import '../../realtime/ws_client.dart';
import 'conversation_titles.dart';
import 'local_notifications.dart';

class MessageNotifier {
  MessageNotifier({required this.realtime, required this.getOpenConversationId});

  final RealtimeClient realtime;
  final String? Function() getOpenConversationId;
  String? _currentUserId;

  void setCurrentUserId(String userId) => _currentUserId = userId;

  void start() => realtime.on('new', _onNew);
  void dispose() => realtime.off('new', _onNew);

  void _onNew(Map<String, dynamic> payload) {
    final raw = payload['message'];
    if (raw is! Map<String, dynamic>) return;
    final dto = MessageDto.fromJson(raw);

    // Never notify for a message this account sent — including from another
    // device (that echoes back over the same 'new' event shape); only ever notify
    // about something arriving FROM someone else.
    if (_currentUserId == null || dto.senderUserId == _currentUserId) return;
    // Already visible on screen right now — thread_screen.dart sets this via
    // currentOpenConversationIdProvider on mount/unmount.
    if (dto.conversationId == getOpenConversationId()) return;

    final title = conversationTitles[dto.conversationId] ?? 'New message';
    showNewMessageNotification(conversationId: dto.conversationId, title: title, body: 'New message');
  }
}
