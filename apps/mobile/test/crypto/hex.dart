import 'dart:typed_data';

/// dart:convert has no built-in hex codec — this is the only hand-rolled bit in
/// the whole crypto test suite, and it's test-only plumbing, not cryptographic
/// logic.
Uint8List hexToBytes(String hex) {
  final out = Uint8List(hex.length ~/ 2);
  for (var i = 0; i < out.length; i++) {
    out[i] = int.parse(hex.substring(i * 2, i * 2 + 2), radix: 16);
  }
  return out;
}

String bytesToHex(Uint8List bytes) => bytes.map((b) => b.toRadixString(16).padLeft(2, '0')).join();
