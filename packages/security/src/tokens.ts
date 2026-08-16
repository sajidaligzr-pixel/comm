import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';

/**
 * Generates a cryptographically secure random token (Node's `crypto.randomBytes`,
 * backed by the OS CSPRNG — never `Math.random`), base64url-encoded for safe use in
 * URLs. Used for invite tokens, refresh tokens, and device-linking tokens — anywhere
 * docs/02-database-schema.md stores only a hash and hands the raw value to the client
 * exactly once.
 */
export function generateSecureToken(byteLength = 32): string {
  return randomBytes(byteLength).toString('base64url');
}

/**
 * One-way hash of a raw token for at-rest storage (docs/02-database-schema.md:
 * `invites.token_hash`, `sessions.refresh_token_hash`). SHA-256 is appropriate here —
 * unlike a password, a token already has full CSPRNG entropy, so a slow KDF like
 * Argon2id buys nothing and would only add latency to every authenticated request.
 */
export function hashToken(rawToken: string): string {
  return createHash('sha256').update(rawToken, 'utf8').digest('hex');
}

/**
 * Constant-time comparison for anywhere a raw secret is compared against a value
 * derived from user input outside the hash-then-DB-lookup path (e.g. comparing a
 * TURN/webhook signature) — using `===` on secrets risks a timing side-channel.
 * Hashed-token lookups (`hashToken` + a DB unique-index lookup) don't need this
 * separately: the hash itself is compared by Postgres, and a mismatched hash simply
 * fails to find a row, which is already timing-uniform relative to token guesses.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) {
    // Deliberately still do a (dummy) timingSafeEqual so this function's timing
    // doesn't itself leak length information through an early return in the caller.
    timingSafeEqual(bufA, bufA);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}
