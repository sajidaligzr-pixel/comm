// Named import, not default — ioredis's CJS export shape resolves more reliably this
// way under NodeNext module resolution (the default-import form was type-checking as
// the whole module namespace rather than the Redis class here).
import { Redis } from 'ioredis';

let sharedClient: Redis | undefined;

/**
 * Single shared ioredis connection for request-path operations (rate limiting,
 * session/device socket registry lookups). Pub/sub (docs/04-websocket-realtime.md)
 * needs its own dedicated connection per ioredis's own constraint that a subscribed
 * connection can't issue other commands — that connection is created separately in
 * the realtime module (Phase 3), not here.
 */
export function getRedisClient(): Redis {
  if (!sharedClient) {
    const url = process.env.REDIS_URL;
    if (!url) {
      throw new Error('REDIS_URL is not set. See .env.example.');
    }
    sharedClient = new Redis(url, {
      // `maxRetriesPerRequest` is the real fail-fast guard here: a command still
      // errors out (rather than hanging forever) if Redis is genuinely unreachable.
      // The offline queue itself is left enabled (ioredis's default) — it only ever
      // buffers commands during the brief "still establishing the initial TCP
      // connection" window right after construction, which a disabled queue turned
      // into a spurious immediate failure instead of a normal, brief wait.
      maxRetriesPerRequest: 3,
    });
  }
  return sharedClient;
}

/**
 * A dedicated (non-shared) connection for Redis pub/sub — ioredis's own constraint is
 * that a connection in subscriber mode can't issue any other command, so pub/sub
 * always needs its own connection, separate from `getRedisClient()`'s shared one.
 * Used by both apps/web (`server/realtime/ws-server.ts`) and apps/worker (its push
 * notification dispatch, docs/13-roadmap.md) rather than each hand-rolling `new
 * Redis(...)` — every subscriber connection in this codebase goes through here now.
 */
export function createRedisSubscriber(): Redis {
  const url = process.env.REDIS_URL;
  if (!url) {
    throw new Error('REDIS_URL is not set. See .env.example.');
  }
  return new Redis(url);
}
