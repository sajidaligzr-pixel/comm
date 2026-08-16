import { describe, it, expect } from 'vitest';
import {
  generateX25519KeyPair,
  generateEd25519KeyPair,
  dh,
  sign,
  verify,
  hkdfSha256,
  hmacSha256,
  aeadEncrypt,
  aeadDecrypt,
  randomBytes,
  AEAD_NONCE_LEN,
} from '../primitives';

describe('primitives', () => {
  it('X25519: two parties deriving DH from each other\'s public keys agree', () => {
    const alice = generateX25519KeyPair();
    const bob = generateX25519KeyPair();
    const sharedA = dh(alice.privateKey, bob.publicKey);
    const sharedB = dh(bob.privateKey, alice.publicKey);
    expect(sharedA).toEqual(sharedB);
  });

  it('Ed25519: signs and verifies; a tampered message fails verification', () => {
    const identity = generateEd25519KeyPair();
    const message = new TextEncoder().encode('signed pre-key bytes');
    const signature = sign(identity.privateKey, message);
    expect(verify(identity.publicKey, message, signature)).toBe(true);

    const tampered = new TextEncoder().encode('signed pre-key BYTES');
    expect(verify(identity.publicKey, tampered, signature)).toBe(false);
  });

  it('Ed25519: a signature from the wrong key fails verification', () => {
    const a = generateEd25519KeyPair();
    const b = generateEd25519KeyPair();
    const message = new TextEncoder().encode('hello');
    const sigFromA = sign(a.privateKey, message);
    expect(verify(b.publicKey, message, sigFromA)).toBe(false);
  });

  it('HKDF is deterministic for the same inputs and differs for different info strings', () => {
    const ikm = randomBytes(32);
    const salt = randomBytes(32);
    const a = hkdfSha256(ikm, salt, 'info-a', 32);
    const aAgain = hkdfSha256(ikm, salt, 'info-a', 32);
    const b = hkdfSha256(ikm, salt, 'info-b', 32);
    expect(a).toEqual(aAgain);
    expect(a).not.toEqual(b);
  });

  it('HMAC-SHA256 is deterministic and key-dependent', () => {
    const key = randomBytes(32);
    const msg = randomBytes(16);
    expect(hmacSha256(key, msg)).toEqual(hmacSha256(key, msg));
    expect(hmacSha256(key, msg)).not.toEqual(hmacSha256(randomBytes(32), msg));
  });

  it('AEAD: round-trips plaintext and authenticates associated data', () => {
    const key = randomBytes(32);
    const nonce = randomBytes(AEAD_NONCE_LEN);
    const plaintext = new TextEncoder().encode('hello, bob');
    const aad = new TextEncoder().encode('header-bytes');

    const ciphertext = aeadEncrypt(key, nonce, plaintext, aad);
    const decrypted = aeadDecrypt(key, nonce, ciphertext, aad);
    expect(new TextDecoder().decode(decrypted)).toBe('hello, bob');
  });

  it('AEAD: a flipped ciphertext bit fails to decrypt rather than returning garbage', () => {
    const key = randomBytes(32);
    const nonce = randomBytes(AEAD_NONCE_LEN);
    const ciphertext = aeadEncrypt(key, nonce, new TextEncoder().encode('secret'), new Uint8Array());

    const tampered = new Uint8Array(ciphertext);
    tampered[0] = tampered[0]! ^ 0xff;

    expect(() => aeadDecrypt(key, nonce, tampered, new Uint8Array())).toThrow();
  });

  it('AEAD: wrong associated data fails authentication even with the right key/nonce', () => {
    const key = randomBytes(32);
    const nonce = randomBytes(AEAD_NONCE_LEN);
    const ciphertext = aeadEncrypt(key, nonce, new TextEncoder().encode('secret'), new TextEncoder().encode('aad-1'));

    expect(() => aeadDecrypt(key, nonce, ciphertext, new TextEncoder().encode('aad-2'))).toThrow();
  });

  it('randomBytes never produces the same output twice across a large sample', () => {
    const samples = new Set(Array.from({ length: 500 }, () => Buffer.from(randomBytes(32)).toString('hex')));
    expect(samples.size).toBe(500);
  });
});
