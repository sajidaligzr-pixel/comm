/// Multi-device message HISTORY sync bootstrap — direct port of
/// `apps/web/lib/crypto/history-key.ts`. See that file's docstring for the full
/// three-case reasoning (cached locally / fetch-or-create with the password /
/// biometric unlock with nothing cached yet, degrade gracefully).
library;

import 'dart:typed_data';
import '../api/history_api.dart';
import 'encoding.dart';
import 'history_key_holder.dart';
import 'primitives.dart';
import 'storage/key_derivation.dart';
import 'storage/wrap.dart';
import '../storage/blob_store.dart';
import '../api/api_client.dart' show ApiException;

const _historyKeyBlobKey = 'history-key';
const _hkLength = 32;

Future<void> ensureHistoryKey(
  HistoryApi historyApi,
  Uint8List localKek,
  String? password,
) async {
  final cached = await getBlob(_historyKeyBlobKey);
  if (cached != null) {
    try {
      setCurrentHistoryKey(await unwrapBytes(localKek, cached));
      return;
    } catch (_) {
      // Shouldn't happen (the local KEK unlocking right now is the same one that
      // wrapped this) — fall through and re-bootstrap rather than leaving this
      // session with no HK at all over a corrupted cache entry.
    }
  }

  if (password == null) {
    return; // biometric path, nothing cached yet — see this file's own docstring
  }

  UserHistoryKeyResponse? existing;
  try {
    existing = await historyApi.getHistoryKey();
  } on ApiException catch (e) {
    if (e.code == 'NOT_FOUND') {
      existing = null;
    } else {
      return; // best-effort bootstrap — a network hiccup shouldn't block sign-in
    }
  } catch (_) {
    return;
  }

  Uint8List hk;
  if (existing != null) {
    final wrapKek = await deriveKek(password, base64ToBytes(existing.salt));
    hk = await unwrapBytes(wrapKek, base64ToBytes(existing.wrappedKey));
  } else {
    hk = randomBytes(_hkLength);
    final salt = generateKekSalt();
    final wrapKek = await deriveKek(password, salt);
    final wrappedKey = await wrapBytes(wrapKek, hk);
    final canonical = await historyApi.createHistoryKey(
      wrappedKey: bytesToBase64(wrappedKey),
      salt: bytesToBase64(salt),
    );
    // Lost a race with another of this account's own devices creating one at
    // the same time — adopt the WINNING row (packages/types/src/history.ts's
    // own doc comment on this response).
    if (canonical.wrappedKey != bytesToBase64(wrappedKey)) {
      final winningKek = await deriveKek(
        password,
        base64ToBytes(canonical.salt),
      );
      hk = await unwrapBytes(winningKek, base64ToBytes(canonical.wrappedKey));
    }
  }

  await putBlob(_historyKeyBlobKey, await wrapBytes(localKek, hk));
  setCurrentHistoryKey(hk);
}
