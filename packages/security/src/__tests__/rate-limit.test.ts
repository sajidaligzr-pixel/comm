import { describe, it, expect, afterAll } from 'vitest';
import { Redis } from 'ioredis';
import { checkRateLimit, checkCombinedRateLimit, type RateLimitRule } from '../rate-limit';

// Runs against the local dev Redis (see docs/11-deployment-architecture.md — this
// machine runs a native Homebrew Redis on localhost, no Docker). A dedicated key
// prefix per test run keeps this from colliding with anything else using the same
// instance.
const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379');
const testId = () => `test:${Math.random().toString(36).slice(2)}`;

afterAll(async () => {
  await redis.quit();
});

describe('checkRateLimit', () => {
  it('allows requests under the limit and blocks once the limit is reached', async () => {
    const rule: RateLimitRule = { namespace: `rl-test-${Date.now()}`, windowSeconds: 60, max: 3 };
    const identity = testId();

    const r1 = await checkRateLimit(redis, rule, identity);
    const r2 = await checkRateLimit(redis, rule, identity);
    const r3 = await checkRateLimit(redis, rule, identity);
    const r4 = await checkRateLimit(redis, rule, identity);

    expect(r1.allowed).toBe(true);
    expect(r2.allowed).toBe(true);
    expect(r3.allowed).toBe(true);
    expect(r4.allowed).toBe(false);
    expect(r4.remaining).toBe(0);
  });

  it('keeps independent counters per identity', async () => {
    const rule: RateLimitRule = { namespace: `rl-test-${Date.now()}`, windowSeconds: 60, max: 1 };
    const a = await checkRateLimit(redis, rule, 'account-a');
    const b = await checkRateLimit(redis, rule, 'account-b');
    expect(a.allowed).toBe(true);
    expect(b.allowed).toBe(true);
  });

  it('sets an expiry so the window actually resets (TTL is present, not permanent)', async () => {
    const rule: RateLimitRule = { namespace: `rl-test-${Date.now()}`, windowSeconds: 60, max: 5 };
    const identity = testId();
    const result = await checkRateLimit(redis, rule, identity);
    const key = `ratelimit:${rule.namespace}:${identity}`;
    const ttl = await redis.pttl(key);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(60_000);
    expect(result.resetAt.getTime()).toBeGreaterThan(Date.now());
  });
});

describe('checkCombinedRateLimit', () => {
  it('blocks if either the account or IP bucket is exhausted', async () => {
    const accountRule: RateLimitRule = { namespace: `rl-acct-${Date.now()}`, windowSeconds: 60, max: 100 };
    const ipRule: RateLimitRule = { namespace: `rl-ip-${Date.now()}`, windowSeconds: 60, max: 1 };
    const account = testId();
    const ip = testId();

    const first = await checkCombinedRateLimit(redis, [
      { rule: accountRule, identity: account },
      { rule: ipRule, identity: ip },
    ]);
    expect(first.allowed).toBe(true);

    // Second call from the same IP (spraying across accounts) trips the IP bucket
    // even though the per-account bucket for a *different* account is still fresh —
    // this is the exact scenario docs/07-auth-architecture.md's brute-force section
    // describes.
    const second = await checkCombinedRateLimit(redis, [
      { rule: accountRule, identity: testId() },
      { rule: ipRule, identity: ip },
    ]);
    expect(second.allowed).toBe(false);
  });
});
