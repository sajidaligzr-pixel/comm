import argon2 from 'argon2';

/**
 * Argon2id parameters, tunable via env (docs/.env.example) rather than hardcoded, so
 * they can be re-benchmarked against real production hardware without a code change —
 * see docs/07-auth-architecture.md and docs/14-risk-register.md #12. Defaults here are
 * a reasonable dev-machine starting point (~64 MiB, 3 iterations, 1 lane), deliberately
 * NOT tuned down for test speed in this module — the login-flow integration tests
 * (docs/12-testing-strategy.md) are expected to pay the real hashing cost, because a
 * cheap hash in "test mode" that differs from production is exactly the kind of drift
 * that hides a real-world timing/strength regression.
 */
export interface Argon2Params {
  memoryCostKiB: number;
  timeCost: number;
  parallelism: number;
}

function paramsFromEnv(): Argon2Params {
  return {
    memoryCostKiB: Number(process.env.ARGON2_MEMORY_KIB ?? 65536),
    timeCost: Number(process.env.ARGON2_ITERATIONS ?? 3),
    parallelism: Number(process.env.ARGON2_PARALLELISM ?? 1),
  };
}

/**
 * Hashes a plaintext password. The returned string encodes the algorithm, version,
 * and cost parameters alongside the hash (argon2's standard encoded format) — this is
 * what lets `verifyPassword` keep validating old hashes after `paramsFromEnv()`
 * changes, and lets a future migration re-hash-on-login without a mass password reset.
 */
export async function hashPassword(plaintext: string, params: Argon2Params = paramsFromEnv()): Promise<string> {
  return argon2.hash(plaintext, {
    type: argon2.argon2id,
    memoryCost: params.memoryCostKiB,
    timeCost: params.timeCost,
    parallelism: params.parallelism,
  });
}

/**
 * Verifies a plaintext password against a stored Argon2id hash. Never throws on a
 * mismatch — returns false — so callers can't accidentally treat a verification
 * error as "unknown" and skip the rate-limit/lockout path that a normal failed
 * attempt would go through (see docs/07-auth-architecture.md, brute-force section).
 * The plaintext password must never be logged by any caller of this function.
 */
export async function verifyPassword(plaintext: string, storedHash: string): Promise<boolean> {
  try {
    return await argon2.verify(storedHash, plaintext);
  } catch {
    // Malformed/foreign hash format, or a verification-internal error — treated as
    // "does not match," never as a distinct error state an attacker could use to
    // distinguish "account doesn't exist" from "wrong password" via error shape.
    return false;
  }
}

/**
 * True if a stored hash was produced with weaker-than-current parameters — callers
 * (the login flow) use this to opportunistically re-hash with current params after a
 * successful verify, without ever forcing a mass reset.
 */
export function needsRehash(storedHash: string, params: Argon2Params = paramsFromEnv()): boolean {
  // No `type` field here — argon2's needsRehash only compares cost parameters, not
  // the variant. This codebase only ever produces argon2id hashes (hashPassword
  // above hardcodes `type: argon2.argon2id`), so there's no argon2i/argon2d variant
  // that could otherwise slip past this check undetected.
  return argon2.needsRehash(storedHash, {
    memoryCost: params.memoryCostKiB,
    timeCost: params.timeCost,
    parallelism: params.parallelism,
  });
}
