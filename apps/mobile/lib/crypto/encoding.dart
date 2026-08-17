/// Encoding helpers — the Dart counterpart of `packages/crypto/src/encoding.ts`.
///
/// That TypeScript file hand-rolls base64 specifically to avoid `Buffer`/`btoa`/
/// `atob` environment differences between a browser tab and Node/Vitest. That
/// reason doesn't apply here: `dart:convert`'s `base64Encode`/`base64Decode` and
/// `utf8.encode`/`utf8.decode` are already environment-agnostic across every Dart
/// runtime (Flutter on-device, `dart test`, Dart VM), spec-compliant (RFC 4648), and
/// exactly what the standard library is for — so this file is a thin set of
/// `Uint8Array`-shaped names matching the TS API for readability across the two
/// codebases, not a reimplementation.
library;

import 'dart:convert';
import 'dart:typed_data';

String bytesToBase64(Uint8List bytes) => base64Encode(bytes);

Uint8List base64ToBytes(String b64) => base64Decode(b64);

Uint8List utf8ToBytes(String text) => Uint8List.fromList(utf8.encode(text));

String bytesToUtf8(Uint8List bytes) => utf8.decode(bytes);

Uint8List concatBytes(List<Uint8List> chunks) {
  final total = chunks.fold<int>(0, (sum, c) => sum + c.length);
  final out = Uint8List(total);
  var offset = 0;
  for (final chunk in chunks) {
    out.setAll(offset, chunk);
    offset += chunk.length;
  }
  return out;
}
