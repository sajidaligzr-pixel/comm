/**
 * Thin, direct wrappers around `@noble/curves` / `@noble/hashes` / `@noble/ciphers` —
 * see docs/05-crypto-architecture.md#library-decision for why these three libraries
 * specifically. This file adds no cryptographic logic of its own; it exists so every
 * other file in this package imports curve/hash/cipher operations from one place with
 * names that match the Signal spec's own notation (DH, KDF, ENCRYPT, ...), which is
 * what makes the X3DH/Double Ratchet implementations reviewable against that spec
 * line-by-line.
 */
import { x25519, ed25519 } from '@noble/curves/ed25519.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { randomBytes as nobleRandomBytes } from '@noble/hashes/utils.js';
import { chacha20poly1305 } from '@noble/ciphers/chacha.js';

export const X25519_KEY_LEN = 32;
export const ED25519_KEY_LEN = 32;
export const ED25519_SIG_LEN = 64;
export const AEAD_KEY_LEN = 32;
export const AEAD_NONCE_LEN = 12;

export interface KeyPair {
  privateKey: Uint8Array;
  publicKey: Uint8Array;
}

export function randomBytes(length: number): Uint8Array {
  return nobleRandomBytes(length);
}

// ── X25519 (Diffie-Hellman key agreement) ─────────────────────────────────────
export function generateX25519KeyPair(): KeyPair {
  const kp = x25519.keygen();
  return { privateKey: kp.secretKey, publicKey: kp.publicKey };
}

/** `DH(pair, pub)` in the X3DH/Double Ratchet specs' own notation. */
export function dh(ourPrivateKey: Uint8Array, theirPublicKey: Uint8Array): Uint8Array {
  return x25519.getSharedSecret(ourPrivateKey, theirPublicKey);
}

// ── Ed25519 (identity signing) ─────────────────────────────────────────────────
export function generateEd25519KeyPair(): KeyPair {
  const kp = ed25519.keygen();
  return { privateKey: kp.secretKey, publicKey: kp.publicKey };
}

export function sign(privateKey: Uint8Array, message: Uint8Array): Uint8Array {
  return ed25519.sign(message, privateKey);
}

export function verify(publicKey: Uint8Array, message: Uint8Array, signature: Uint8Array): boolean {
  try {
    return ed25519.verify(signature, message, publicKey);
  } catch {
    // A malformed signature/key should fail closed, not throw past the caller —
    // signature verification failing is a normal, expected outcome (e.g. a tampered
    // or spoofed bundle), not an exceptional program state.
    return false;
  }
}

// ── HKDF / HMAC (root-key and chain-key derivation) ────────────────────────────
export function hkdfSha256(ikm: Uint8Array, salt: Uint8Array, info: string, length: number): Uint8Array {
  return hkdf(sha256, ikm, salt, new TextEncoder().encode(info), length);
}

export function hmacSha256(key: Uint8Array, message: Uint8Array): Uint8Array {
  return hmac(sha256, key, message);
}

// ── AEAD (message content encryption) ───────────────────────────────────────────
/**
 * ChaCha20-Poly1305 — a well-studied AEAD with no known implementation footguns
 * comparable to AES-GCM's nonce-reuse catastrophe (a repeated nonce under GCM leaks
 * the authentication key; ChaCha20-Poly1305 degrades more gracefully, though nonce
 * uniqueness is still required and enforced by construction here — see
 * ratchet/double-ratchet.ts, where the nonce is derived per-message, never reused).
 */
export function aeadEncrypt(key: Uint8Array, nonce: Uint8Array, plaintext: Uint8Array, aad: Uint8Array): Uint8Array {
  return chacha20poly1305(key, nonce, aad).encrypt(plaintext);
}

export function aeadDecrypt(key: Uint8Array, nonce: Uint8Array, ciphertext: Uint8Array, aad: Uint8Array): Uint8Array {
  // Throws on tag mismatch — callers must not catch-and-ignore this (see
  // ratchet/double-ratchet.ts's decrypt, which lets it propagate as a decryption
  // failure rather than returning corrupted plaintext).
  return chacha20poly1305(key, nonce, aad).decrypt(ciphertext);
}

/**
 * Best-effort overwrite of sensitive bytes once they're no longer needed (X3DH's
 * intermediate DH outputs, consumed ephemeral private keys). JS gives no hard
 * guarantee this defeats a sufficiently determined memory-scraping attacker (the GC
 * or JIT may have made copies before this runs) — it is defense in depth, not a
 * claim of secure erasure, and is documented as such rather than oversold.
 */
export function wipe(bytes: Uint8Array): void {
  bytes.fill(0);
}
