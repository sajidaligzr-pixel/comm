/// A tiny process-global cache of `conversationId -> display title`, populated
/// wherever a `ConversationSummary` is already fetched for other reasons
/// (chats_list_screen.dart's list load, thread_screen.dart's own load) — read by
/// message_notifier.dart so a background `new`-event notification can show a real
/// conversation name instead of a generic "New message" every time, without an
/// extra network round trip just to look one up. Deliberately not itself a network
/// cache with a TTL/eviction policy — it only ever holds what's already been
/// fetched for a real UI reason, so it can't grow unbounded in practice (bounded by
/// however many conversations this account actually has).
library;

final Map<String, String> conversationTitles = {};
