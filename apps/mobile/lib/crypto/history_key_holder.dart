/// In-memory-only holder for this process's unwrapped message History Key (HK)
/// — direct port of `apps/web/lib/crypto/history-key-holder.ts`. See that file's
/// docstring: never persisted raw (an app kill clears this, `ensureHistoryKey` in
/// history_key.dart re-derives/re-reads it on the next unlock), even though HK
/// itself IS also persisted locally in wrapped form (storage/blob_store.dart,
/// under the local KEK).
library;

import 'dart:typed_data';
import 'primitives.dart';

Uint8List? _currentHistoryKey;

void setCurrentHistoryKey(Uint8List? hk) {
  _currentHistoryKey = hk;
}

Uint8List? getCurrentHistoryKey() => _currentHistoryKey;

void clearCurrentHistoryKey() {
  final hk = _currentHistoryKey;
  if (hk != null) wipe(hk);
  _currentHistoryKey = null;
}
