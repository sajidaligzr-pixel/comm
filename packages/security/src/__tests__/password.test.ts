import { describe, it, expect } from 'vitest';
import { hashPassword, verifyPassword, needsRehash } from '../password';

// Smaller-than-production-but-still-real Argon2id cost so this suite runs quickly —
// note this is the one place a lighter cost is acceptable: it's exercising the
// hash/verify *logic*, not standing in for a production timing benchmark the way the
// login integration test (apps/web) intentionally does at full cost. See the comment
// in packages/security/src/password.ts for why that distinction matters.
const testParams = { memoryCostKiB: 8192, timeCost: 2, parallelism: 1 };

describe('password hashing (Argon2id)', () => {
  it('hashes and verifies a correct password', async () => {
    const hash = await hashPassword('correct horse battery staple', testParams);
    expect(hash).toMatch(/^\$argon2id\$/);
    await expect(verifyPassword('correct horse battery staple', hash)).resolves.toBe(true);
  });

  it('rejects an incorrect password', async () => {
    const hash = await hashPassword('correct horse battery staple', testParams);
    await expect(verifyPassword('wrong password entirely', hash)).resolves.toBe(false);
  });

  it('never returns true for an empty/malformed stored hash instead of throwing to the caller', async () => {
    await expect(verifyPassword('anything', 'not-a-real-hash')).resolves.toBe(false);
  });

  it('produces a different hash for the same password each time (unique salt)', async () => {
    const a = await hashPassword('same password', testParams);
    const b = await hashPassword('same password', testParams);
    expect(a).not.toBe(b);
    await expect(verifyPassword('same password', a)).resolves.toBe(true);
    await expect(verifyPassword('same password', b)).resolves.toBe(true);
  });

  it('flags a hash produced with weaker parameters as needing rehash', async () => {
    const weakHash = await hashPassword('same password', { memoryCostKiB: 1024, timeCost: 2, parallelism: 1 });
    expect(needsRehash(weakHash, testParams)).toBe(true);
    const currentHash = await hashPassword('same password', testParams);
    expect(needsRehash(currentHash, testParams)).toBe(false);
  });
});
