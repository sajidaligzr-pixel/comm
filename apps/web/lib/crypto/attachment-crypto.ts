'use client';

/**
 * Per-file encryption for the general file-attachment pipeline
 * (docs/13-roadmap.md's media pass, docs/05-crypto-architecture.md#media-encryption).
 *
 * Deliberately a *different* cipher from `@comm/crypto`'s ChaCha20-Poly1305 (used
 * internally by the Double Ratchet) — this uses the browser's native Web Crypto
 * AES-256-GCM, exactly as docs/05 already specifies for media: "Each attachment gets
 * a fresh random 256-bit AES key and 96-bit nonce." A fresh key/nonce is generated
 * per file, never reused; the key/nonce themselves travel to the recipient inside the
 * already end-to-end-encrypted message envelope (see message-thread.tsx's
 * `handleFileSelected`), never alongside the ciphertext in object storage.
 */

export interface EncryptedAttachment {
  ciphertext: Uint8Array;
  key: Uint8Array;
  nonce: Uint8Array;
}

// TS's DOM lib types Web Crypto's `BufferSource` params against a plain
// `ArrayBuffer`-backed view, but `Uint8Array`'s own generic now widens to
// `ArrayBufferLike` (which includes `SharedArrayBuffer`) — these are always real,
// never-shared buffers here (freshly allocated by `crypto.getRandomValues`/passed in
// from a `File`'s own `arrayBuffer()`), so the cast is safe, not a type-safety hole.
// Same pattern already used in components/notification-prompt.tsx's `pushManager.subscribe`.
function asBufferSource(bytes: Uint8Array): BufferSource {
  return bytes as BufferSource;
}

export async function encryptAttachment(plaintext: Uint8Array): Promise<EncryptedAttachment> {
  const key = crypto.getRandomValues(new Uint8Array(32));
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const cryptoKey = await crypto.subtle.importKey('raw', asBufferSource(key), 'AES-GCM', false, ['encrypt']);
  const ciphertextBuf = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: asBufferSource(nonce) }, cryptoKey, asBufferSource(plaintext));
  return { ciphertext: new Uint8Array(ciphertextBuf), key, nonce };
}

export async function decryptAttachment(ciphertext: Uint8Array, key: Uint8Array, nonce: Uint8Array): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey('raw', asBufferSource(key), 'AES-GCM', false, ['decrypt']);
  // Throws (GCM tag mismatch) rather than returning garbage on tamper — same
  // tamper-detection posture as the Double Ratchet's own AEAD, see
  // packages/crypto/src/ratchet/double-ratchet.ts's decrypt docstring.
  const plaintextBuf = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: asBufferSource(nonce) }, cryptoKey, asBufferSource(ciphertext));
  return new Uint8Array(plaintextBuf);
}
