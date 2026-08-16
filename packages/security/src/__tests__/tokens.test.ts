import { describe, it, expect } from 'vitest';
import { generateSecureToken, hashToken, constantTimeEqual } from '../tokens';

describe('secure tokens', () => {
  it('generates tokens of sufficient entropy and uniqueness', () => {
    const tokens = new Set(Array.from({ length: 1000 }, () => generateSecureToken(32)));
    // No collisions across 1000 samples of a 256-bit token — a collision here would
    // indicate a broken/predictable generator, not bad luck.
    expect(tokens.size).toBe(1000);
  });

  it('hashes deterministically so a stored hash can be looked up by re-hashing the raw token', () => {
    const raw = generateSecureToken();
    expect(hashToken(raw)).toBe(hashToken(raw));
  });

  it('produces different hashes for different tokens', () => {
    const a = generateSecureToken();
    const b = generateSecureToken();
    expect(hashToken(a)).not.toBe(hashToken(b));
  });

  it('never stores or exposes the raw token from the hash', () => {
    const raw = generateSecureToken();
    const hash = hashToken(raw);
    expect(hash).not.toContain(raw);
  });

  describe('constantTimeEqual', () => {
    it('returns true for equal strings', () => {
      expect(constantTimeEqual('abc123', 'abc123')).toBe(true);
    });

    it('returns false for different strings of the same length', () => {
      expect(constantTimeEqual('abc123', 'abc124')).toBe(false);
    });

    it('returns false for different-length strings without throwing', () => {
      expect(constantTimeEqual('short', 'a-lot-longer-string')).toBe(false);
    });
  });
});
