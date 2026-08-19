import { PrismaClient } from '../generated/client/index.js';

export * from '../generated/client/index.js';

/**
 * A single shared Prisma client per process, not one per request — Prisma's own
 * connection pool handles concurrency internally, and creating a new client per
 * request would exhaust Postgres connections under load. In Next.js dev mode with hot
 * reload, the client is cached on `globalThis` so repeated module reloads don't leak
 * connections — a well-known Prisma+Next.js pitfall this sidesteps deliberately.
 */
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

/**
 * Found live in CI (GitHub Actions): a couple of the ten server test files —
 * never the same two twice across "which files ran first," but always exactly
 * the earliest-collected ones — intermittently threw
 * `PrismaClientInitializationError: Environment variable not found:
 * DATABASE_URL` from deep inside `prisma.user.create()`, never at import time.
 * That shape (fails at first QUERY, not at `new PrismaClient()`) matches
 * Prisma's default behavior of resolving `env("DATABASE_URL")` from
 * `schema.prisma` LAZILY, on first use — never reproduced locally (including
 * against a from-scratch database and driving the exact same `npm run test` →
 * `turbo run test` → `vitest run` chain CI uses), which points at some
 * CI-runner-specific timing gap between process start and that lazy first
 * read, not anything wrong with the query itself. Passing `datasourceUrl`
 * explicitly forces an EAGER, synchronous read of `process.env.DATABASE_URL`
 * right here at module-evaluation time instead — this module is always
 * imported well after any env setup (Next.js's own loading in prod/dev, or
 * vitest.setup.ts's `dotenv.config()` in tests) has already run, so there's no
 * later "first query" moment left for a timing gap to hide in. Failing loudly
 * here (rather than passing `undefined` through to Prisma's own less specific
 * error) is also just a better error for the next person to hit a genuinely
 * missing DATABASE_URL, in any environment.
 */
function requireDatabaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error('DATABASE_URL is not set — see .env.example. (packages/database/src/index.ts)');
  }
  return url;
}

export const prisma: PrismaClient =
  globalForPrisma.prisma ??
  new PrismaClient({
    datasourceUrl: requireDatabaseUrl(),
    // Deliberately never enables Prisma's 'query' log level: it prints bound
    // parameter values, which for this schema can include password-hash writes,
    // token hashes, and similar — see docs/10-privacy-data-retention.md and the
    // logging rule in docs/08-threat-model.md. 'warn'/'error' only.
    log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
  });

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
}
