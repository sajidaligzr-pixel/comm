/// `disappearingTimerToMs`/`deletedPlaceholderText` (features/chats/
/// thread_screen.dart) — the two pure-logic pieces behind disappearing
/// messages and message deletion, pulled out for the same reason
/// `tickStateFor` was: worth testing directly, independent of the widget
/// tree/network/WS wiring around them.
library;

import 'package:flutter_test/flutter_test.dart';
import 'package:comm_mobile/features/chats/thread_screen.dart';

void main() {
  group('disappearingTimerToMs', () {
    test('off is never-expires (null)', () {
      expect(disappearingTimerToMs('off'), isNull);
    });

    test('h24 is exactly 24 hours in milliseconds', () {
      expect(disappearingTimerToMs('h24'), 24 * 60 * 60 * 1000);
    });

    test('d7 is exactly 7 days in milliseconds', () {
      expect(disappearingTimerToMs('d7'), 7 * 24 * 60 * 60 * 1000);
    });

    test('d30 is exactly 30 days in milliseconds', () {
      expect(disappearingTimerToMs('d30'), 30 * 24 * 60 * 60 * 1000);
    });

    // Fails closed to "never expires" rather than crashing or guessing, for
    // any value this build doesn't recognize (e.g. a future server-added
    // option an older client hasn't shipped support for yet).
    test('an unrecognized value fails closed to never-expires', () {
      expect(disappearingTimerToMs('bogus'), isNull);
    });
  });

  group('deletedPlaceholderText', () {
    test('a manual delete shows the generic text regardless of content type', () {
      expect(deletedPlaceholderText('text', 'manual'), 'This message was deleted');
      expect(deletedPlaceholderText('voice', 'manual'), 'This message was deleted');
      expect(deletedPlaceholderText('media', 'manual'), 'This message was deleted');
    });

    test('a disappearing-timer expiry shows the generic text too', () {
      expect(deletedPlaceholderText('voice', 'disappearing_timer'), 'This message was deleted');
    });

    test('media_retention gets specific per-content-type text', () {
      expect(deletedPlaceholderText('voice', 'media_retention'), 'This voice message has expired');
      expect(deletedPlaceholderText('media', 'media_retention'), 'This file has expired');
      expect(deletedPlaceholderText('text', 'media_retention'), 'This message was deleted');
    });

    test('a null reason (an old cached row) falls through to the generic text', () {
      expect(deletedPlaceholderText('voice', null), 'This message was deleted');
    });
  });
}
