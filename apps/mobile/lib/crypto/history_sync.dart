/// Multi-device message HISTORY sync — the per-message half. Direct port of
/// `apps/web/lib/crypto/history-sync.ts`; see that file's docstring for the full
/// reasoning. `syncHistoryEntry` is called from thread_screen.dart at every point
/// a message's plaintext becomes known on this device (composing a send, or a
/// live/catch-up decrypt succeeding); `tryDecryptViaHistory` is the read-side
/// fallback.
library;

import 'dart:convert';
import '../api/history_api.dart';
import '../crypto/message_cache.dart';
import 'encoding.dart';
import 'history_key_holder.dart';
import 'storage/wrap.dart';

/// Best-effort, fire-and-forget by every caller — a failed upload never blocks
/// rendering the message on THIS device; it only means a secondary/future device
/// won't be able to recover this specific message until some other device of
/// this account's own succeeds at writing it instead.
Future<void> syncHistoryEntry(HistoryApi historyApi, CachedMessage message) async {
  final hk = getCurrentHistoryKey();
  if (hk == null) return; // no HK this session — skip silently
  try {
    final wrapped = await wrapBytes(hk, utf8ToBytes(jsonEncode(message.toJson())));
    await historyApi.uploadHistoryCopy(message.id, bytesToBase64(wrapped));
  } catch (_) {
    // See this function's own docstring.
  }
}

/// The stored history ciphertext already IS a full serialized [CachedMessage]
/// (not just raw plaintext) — see [syncHistoryEntry] above — so recovering it is
/// exactly "unwrap, parse," no content-decode step needed the way a live
/// per-device/group decrypt requires. Returns `null` (never throws) on anything
/// short of success.
Future<CachedMessage?> tryDecryptViaHistory(String? historyCiphertextBase64) async {
  if (historyCiphertextBase64 == null) return null;
  final hk = getCurrentHistoryKey();
  if (hk == null) return null;
  try {
    final plaintext = await unwrapBytes(hk, base64ToBytes(historyCiphertextBase64));
    return CachedMessage.fromJson(
      jsonDecode(bytesToUtf8(plaintext)) as Map<String, dynamic>,
    );
  } catch (_) {
    return null;
  }
}
