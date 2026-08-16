import { describe, it, expect } from 'vitest';
import { deriveKek, generateKekSalt, KEK_LENGTH } from '../storage/key-derivation';
import { wrapBytes, unwrapBytes } from '../storage/wrap';
import { randomBytes } from '../primitives';

// Lighter-than-production Argon2id cost so this suite runs quickly — same rationale
// as packages/security's password tests: this exercises the derivation *logic*, the
// production cost constants live in storage/key-derivation.ts's own default and are
// what actually ships.
const testParams = { memorySizeKiB: 8192, iterations: 2, parallelism: 1 };

describe('local key-encryption-key derivation (Argon2id)', () => {
  it('derives a 32-byte key deterministically from the same password + salt', async () => {
    const salt = generateKekSalt();
    const kekA = await deriveKek('correct horse battery staple', salt, testParams);
    const kekB = await deriveKek('correct horse battery staple', salt, testParams);
    expect(kekA).toEqual(kekB);
    expect(kekA.length).toBe(KEK_LENGTH);
  });

  it('produces a different key for a different password', async () => {
    const salt = generateKekSalt();
    const kekA = await deriveKek('password one', salt, testParams);
    const kekB = await deriveKek('password two', salt, testParams);
    expect(kekA).not.toEqual(kekB);
  });

  it('produces a different key for a different salt, same password', async () => {
    const kekA = await deriveKek('same password', generateKekSalt(), testParams);
    const kekB = await deriveKek('same password', generateKekSalt(), testParams);
    expect(kekA).not.toEqual(kekB);
  });
});

describe('local key wrapping (ChaCha20-Poly1305 under the KEK)', () => {
  it('round-trips arbitrary bytes', async () => {
    const kek = await deriveKek('a password', generateKekSalt(), testParams);
    const secret = randomBytes(64); // stand-in for a private key or serialized session

    const wrapped = wrapBytes(kek, secret);
    const unwrapped = unwrapBytes(kek, wrapped);

    expect(unwrapped).toEqual(secret);
  });

  it('produces different ciphertext each time even for the same input (random nonce)', async () => {
    const kek = await deriveKek('a password', generateKekSalt(), testParams);
    const secret = randomBytes(32);

    const wrapped1 = wrapBytes(kek, secret);
    const wrapped2 = wrapBytes(kek, secret);

    expect(wrapped1).not.toEqual(wrapped2);
    expect(unwrapBytes(kek, wrapped1)).toEqual(secret);
    expect(unwrapBytes(kek, wrapped2)).toEqual(secret);
  });

  it('fails to unwrap under the wrong KEK', async () => {
    const kekA = await deriveKek('password A', generateKekSalt(), testParams);
    const kekB = await deriveKek('password B', generateKekSalt(), testParams);
    const wrapped = wrapBytes(kekA, randomBytes(32));

    expect(() => unwrapBytes(kekB, wrapped)).toThrow();
  });

  it('fails to unwrap tampered ciphertext', async () => {
    const kek = await deriveKek('a password', generateKekSalt(), testParams);
    const wrapped = wrapBytes(kek, randomBytes(32));
    const tampered = new Uint8Array(wrapped);
    tampered[tampered.length - 1] = tampered[tampered.length - 1]! ^ 0xff;

    expect(() => unwrapBytes(kek, tampered)).toThrow();
  });
});
