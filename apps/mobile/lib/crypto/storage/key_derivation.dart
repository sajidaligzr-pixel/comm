/// Direct port of `packages/crypto/src/storage/key-derivation.ts` — derives the
/// local-storage key-encryption-key from the account password. Same params as the
/// TS default (see that file's comment for why they're deliberately lighter than
/// the server-side login hash's): tuned for "fast enough not to make login feel
/// broken on a mid-range phone" while still being real, meaningful Argon2id work.
///
/// Argon2id here, not `local_auth`/platform Keystore — this KEK-derivation step is
/// unrelated to (and runs before) biometric unlock; see
/// `features/auth/biometric_unlock.dart` for how the two combine, mirroring
/// `apps/web/lib/crypto/biometric-unlock.ts`'s own "layered on top of, never
/// replacing" relationship between the two.
library;

import 'dart:typed_data';
import 'package:cryptography/cryptography.dart';
import '../primitives.dart';

class KekParams {
  final int memorySizeKiB;
  final int iterations;
  final int parallelism;
  const KekParams({required this.memorySizeKiB, required this.iterations, required this.parallelism});
}

const KekParams defaultKekParams = KekParams(memorySizeKiB: 19456, iterations: 2, parallelism: 1);

const int kekSaltLength = 16;
const int kekLength = 32;

Uint8List generateKekSalt() => randomBytes(kekSaltLength);

Future<Uint8List> deriveKek(String password, Uint8List salt, {KekParams params = defaultKekParams}) async {
  final argon2 = Argon2id(
    parallelism: params.parallelism,
    memory: params.memorySizeKiB,
    iterations: params.iterations,
    hashLength: kekLength,
  );
  final key = await argon2.deriveKeyFromPassword(password: password, nonce: salt);
  return Uint8List.fromList(await key.extractBytes());
}
