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

export const prisma: PrismaClient =
  globalForPrisma.prisma ??
  new PrismaClient({
    // Deliberately never enables Prisma's 'query' log level: it prints bound
    // parameter values, which for this schema can include password-hash writes,
    // token hashes, and similar — see docs/10-privacy-data-retention.md and the
    // logging rule in docs/08-threat-model.md. 'warn'/'error' only.
    log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
  });

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
}
