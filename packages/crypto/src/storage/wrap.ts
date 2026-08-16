import { aeadEncrypt, aeadDecrypt, randomBytes, AEAD_NONCE_LEN } from '../primitives';
import { concatBytes } from '../encoding';

/**
 * Wraps arbitrary key material (or any sensitive bytes — a serialized ratchet
 * state, a private key) for storage in IndexedDB, under the Argon2id-derived KEK —
 * docs/05-crypto-architecture.md#local-key-storage. Uses the same ChaCha20-Poly1305
 * AEAD as message encryption (primitives.ts) rather than introducing a second
 * cipher for this — one audited AEAD construction to review, not two.
 *
 * Output layout: `nonce (12 bytes) || ciphertext+tag`. The nonce is fresh random
 * per call — wrapping is infrequent enough (once per session-state save, not
 * per-message) that a random 96-bit nonce's collision probability is negligible, so
 * there's no need for the counter-based nonce discipline the message ratchet uses.
 */
export function wrapBytes(kek: Uint8Array, plaintext: Uint8Array): Uint8Array {
  const nonce = randomBytes(AEAD_NONCE_LEN);
  const ciphertext = aeadEncrypt(kek, nonce, plaintext, new Uint8Array());
  return concatBytes(nonce, ciphertext);
}

export function unwrapBytes(kek: Uint8Array, wrapped: Uint8Array): Uint8Array {
  const nonce = wrapped.slice(0, AEAD_NONCE_LEN);
  const ciphertext = wrapped.slice(AEAD_NONCE_LEN);
  return aeadDecrypt(kek, nonce, ciphertext, new Uint8Array());
}
