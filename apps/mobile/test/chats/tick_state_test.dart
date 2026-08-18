/// `tickStateFor` (features/chats/thread_screen.dart) decides which of WhatsApp's
/// three tick states an own-message bubble shows — the one piece of the delivery/
/// read-receipt feature that's pure logic and worth testing directly, independent
/// of the widget tree around it (the `delivered`/`read` WS-event wiring and the
/// icon/color rendering both need a live realtime socket or a pumped widget to
/// exercise meaningfully, neither of which this suite is set up for elsewhere).
library;

import 'package:flutter_test/flutter_test.dart';
import 'package:comm_mobile/features/chats/thread_screen.dart';

void main() {
  group('tickStateFor', () {
    test('null status (nothing seeded/received yet) is sent', () {
      expect(tickStateFor(null), TickState.sent);
    });

    test('delivered:false, read:false is sent', () {
      expect(tickStateFor((delivered: false, read: false)), TickState.sent);
    });

    test('delivered:true, read:false is delivered', () {
      expect(tickStateFor((delivered: true, read: false)), TickState.delivered);
    });

    test('delivered:true, read:true is read', () {
      expect(tickStateFor((delivered: true, read: true)), TickState.read);
    });

    // The "read" WS event mirrors what a client with a lagged/missed 'delivered'
    // event could observe — read is the stronger signal (you can't read a message
    // that wasn't delivered) and must win regardless of what `delivered` says.
    test('read:true wins even if delivered is (incorrectly) false', () {
      expect(tickStateFor((delivered: false, read: true)), TickState.read);
    });

    // pending is the optimistic-render window between "rendered locally" and
    // "server confirmed the POST" (thread_screen.dart's `_pendingIds`) — it must
    // win over whatever `status` says, since an optimistic bubble's `status` is
    // always null anyway (nothing server-confirmed has happened yet) but the
    // precedence is worth pinning down explicitly rather than left implicit.
    test('pending:true is sending, regardless of status', () {
      expect(tickStateFor(null, pending: true), TickState.sending);
      expect(tickStateFor((delivered: true, read: true), pending: true), TickState.sending);
    });
  });
}
