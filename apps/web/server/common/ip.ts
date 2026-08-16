import type { NextRequest } from 'next/server';
import { createHash } from 'node:crypto';

/**
 * Only ever handed to rate limiting and security-event logging as a salted hash —
 * never the raw address. See docs/10-privacy-data-retention.md ("IP addresses...
 * stored as salted hashes, never raw") and docs/38-logging's example event shape.
 * The salt is a separate env value from every other secret so rotating it doesn't
 * touch auth/token secrets, and rotating it deliberately breaks correlation of
 * historical hashes with new ones — an intentional forward-secrecy property for this
 * one field, not a bug.
 */
function ipHashSalt(): string {
  return process.env.IP_HASH_SALT ?? process.env.JWT_ACCESS_SECRET ?? 'dev-only-insecure-salt';
}

export function getClientIp(req: NextRequest): string {
  // Behind a reverse proxy (docs/11-deployment-architecture.md), the real client IP
  // arrives via X-Forwarded-For, set by our own trusted Caddy/Nginx layer — not
  // user-controlled in production because the proxy overwrites any client-supplied
  // value for this header rather than appending to it blindly. In local dev there is
  // no proxy, so this falls back to a fixed placeholder.
  const forwarded = req.headers.get('x-forwarded-for');
  if (forwarded) return forwarded.split(',')[0]!.trim();
  return '127.0.0.1';
}

export function hashIp(ip: string): string {
  return createHash('sha256').update(ipHashSalt()).update(ip).digest('hex');
}
