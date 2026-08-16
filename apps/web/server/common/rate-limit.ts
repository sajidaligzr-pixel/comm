import type { NextRequest } from 'next/server';
import { checkRateLimit, checkCombinedRateLimit, getRedisClient, type RateLimitRule } from '@comm/security';
import { AppError } from '@comm/types';
import { getClientIp, hashIp } from './ip';

/** Throws RATE_LIMITED (mapped to HTTP 429 by docs/03-api-design.md's error table) if
 * the given identity has exceeded `rule`. Identity is caller-supplied so this same
 * helper covers per-account, per-IP, and per-resource limiting uniformly. */
export async function enforceRateLimit(rule: RateLimitRule, identity: string): Promise<void> {
  const result = await checkRateLimit(getRedisClient(), rule, identity);
  if (!result.allowed) {
    throw new AppError('RATE_LIMITED', 'Too many attempts. Please wait a moment and try again.');
  }
}

/** Per-IP variant — hashes the request's client IP before it ever becomes a Redis key
 * or touches a log line, per docs/10-privacy-data-retention.md. */
export async function enforceRateLimitByIp(rule: RateLimitRule, req: NextRequest): Promise<void> {
  await enforceRateLimit(rule, hashIp(getClientIp(req)));
}

/** Independent account + IP buckets, both enforced — see
 * docs/07-auth-architecture.md's brute-force protection section for why login
 * specifically needs both rather than either alone. */
export async function enforceCombinedRateLimit(
  req: NextRequest,
  checks: Array<{ rule: RateLimitRule; accountIdentity?: string }>,
): Promise<void> {
  const ipHash = hashIp(getClientIp(req));
  const result = await checkCombinedRateLimit(
    getRedisClient(),
    checks.map((c) => ({ rule: c.rule, identity: c.accountIdentity ?? ipHash })),
  );
  if (!result.allowed) {
    throw new AppError('RATE_LIMITED', 'Too many attempts. Please wait a moment and try again.');
  }
}
