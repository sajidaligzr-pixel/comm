import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * AES-256-GCM encryption for server-held data that must be confidential at rest
 * against a database leak, but where the server itself legitimately needs to read it
 * back — this is NOT part of the E2E message-content crypto (`packages/crypto`,
 * client-only, user-KEK-derived); it's the opposite trust model, a server-held key
 * for server-held metadata. Currently used for `push_tokens.subscription_ciphertext`
 * (docs/02-database-schema.md) — a Web Push subscription's endpoint/keys identify the
 * device to the browser vendor, so they're treated as sensitive even though the
 * server needs them, decrypted, to actually dispatch a push (apps/worker). Standard
 * combined nonce‖ciphertext‖tag format, built only on Node's own audited `crypto`
 * module — nothing hand-rolled here.
 */
const ALGORITHM = 'aes-256-gcm';
const NONCE_BYTES = 12;

function loadKey(keyBase64: string): Buffer {
  const key = Buffer.from(keyBase64, 'base64');
  if (key.length !== 32) {
    throw new Error('Server secret-box key must be 32 bytes (base64-encoded). See .env.example.');
  }
  return key;
}

export function encryptAtRest(keyBase64: string, plaintext: Buffer): Buffer {
  const key = loadKey(keyBase64);
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, nonce);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([nonce, ciphertext, tag]);
}

export function decryptAtRest(keyBase64: string, blob: Buffer): Buffer {
  const key = loadKey(keyBase64);
  const nonce = blob.subarray(0, NONCE_BYTES);
  const tag = blob.subarray(blob.length - 16);
  const ciphertext = blob.subarray(NONCE_BYTES, blob.length - 16);
  const decipher = createDecipheriv(ALGORITHM, key, nonce);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}
