import { argon2id } from 'hash-wasm';
import { randomBytes } from '../primitives';

/**
 * Derives the local-storage key-encryption-key from the account password —
 * docs/05-crypto-architecture.md#local-key-storage. Runs identically in the browser
 * and under Node/Vitest (hash-wasm is WASM-based either way), which is what makes
 * this function directly testable rather than only exercisable through a browser.
 *
 * Argon2id, not the Node-native `argon2` package used server-side for login password
 * hashing (packages/security) — that package is a native addon and cannot run in a
 * browser at all. This is a deliberate, separate implementation for a deliberately
 * different purpose: packages/security's Argon2id protects the *login* credential
 * server-side; this one derives a *local* key-wrapping key client-side. Same
 * algorithm, different library, because only one of the two runs in a browser.
 */
export interface KekParams {
  memorySizeKiB: number;
  iterations: number;
  parallelism: number;
}

const DEFAULT_PARAMS: KekParams = {
  // Deliberately lighter than the server-side login hash's parameters
  // (packages/security defaults to 64 MiB/3 iterations) — this derivation runs on
  // every login in the browser's main thread (or a worker), on a wide range of
  // client hardware including phones, and protects a *local* at-rest key rather
  // than being the sole barrier against a remote brute-force attempt the way the
  // server-side login hash is. Tuned for "fast enough not to make login feel
  // broken on a mid-range phone" while still being real, meaningful Argon2id work
  // — not a token gesture.
  memorySizeKiB: 19456, // 19 MiB
  iterations: 2,
  parallelism: 1,
};

export const KEK_SALT_LENGTH = 16;
export const KEK_LENGTH = 32;

export function generateKekSalt(): Uint8Array {
  return randomBytes(KEK_SALT_LENGTH);
}

export async function deriveKek(password: string, salt: Uint8Array, params: KekParams = DEFAULT_PARAMS): Promise<Uint8Array> {
  const hash = await argon2id({
    password,
    salt,
    iterations: params.iterations,
    parallelism: params.parallelism,
    memorySize: params.memorySizeKiB,
    hashLength: KEK_LENGTH,
    outputType: 'binary',
  });
  return hash;
}
