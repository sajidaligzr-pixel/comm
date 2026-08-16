// Loaded before anything else, and before any other import that might touch
// process.env (Prisma/ioredis read DATABASE_URL/REDIS_URL lazily on first real use,
// but this still has to run first for correctness). Dev-only: in production this
// process is started by PM2/systemd with its environment injected directly
// (docs/11-deployment-architecture.md), where apps/worker/.env simply won't exist —
// dotenv's config() is a safe no-op then, and never overwrites an already-set
// process.env value either way. Unlike apps/web (Next.js auto-loads its own .env),
// this is a bare Node entry point with no framework doing that for it, so it has to
// be explicit — this was a real gap: prior to this, apps/worker had NO working path
// to its own DATABASE_URL/REDIS_URL outside of an ambient shell export happening to
// already have them set.
import { config } from 'dotenv';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(here, '../../web/.env') });

// `.js`, not `.ts` and not extensionless: unlike apps/web (bundled by
// Turbopack/webpack, which needs relative imports WITHOUT the extension — see that
// app's own imports), this file is genuinely `tsc`-compiled and run as plain Node
// ESM (`node dist/index.js`), which requires the real, resolvable output extension
// on every relative import specifier — TypeScript never rewrites this at emit time.
// A previously-untested gap: this only ever ran via `tsx watch` in dev, whose
// resolver is lenient about a missing extension, so `node dist/index.js` (the actual
// production start command) has never worked until this fix.
const { runCleanup } = await import('./jobs/cleanup.js');
const { startPushDispatcher } = await import('./realtime/push-dispatch.js');

/**
 * Same reasoning, same fix, as apps/web/server.ts's identical guard (added the same
 * pass this one was) — this process runs the hourly cleanup sweep media retention's
 * whole flood-protection story depends on (docs/10-privacy-data-retention.md) plus
 * push dispatch; an uncaught exception anywhere silently killing it is worse than a
 * crashed web server, since nothing here would even notice until disk usage or a
 * missing push notification gets investigated much later. Every actual call site
 * already found is independently guarded too (`tick()` below,
 * `push-dispatch.ts#handleNewMessage`, `cleanup.ts#runCategory`) — this is the same
 * global backstop for whatever shape of bug isn't found yet.
 */
process.on('uncaughtException', (err) => {
  console.error('[worker] uncaughtException — recovered, process staying up', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[worker] unhandledRejection — recovered, process staying up', reason);
});

/**
 * A single persistent process running one interval-based job plus one event-driven
 * subscriber. This is intentionally NOT a BullMQ consumer yet — there is no queue
 * producer in Phase 2 to consume from (nothing enqueues a job; the cleanup job just
 * wakes up on a timer, and push dispatch reacts to Redis pub/sub, not a queue).
 * BullMQ gets adopted starting Phase 4 (docs/13-roadmap.md) when media processing
 * needs real job queueing/retries; introducing that infrastructure before anything
 * needs it would just be unused complexity.
 */
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000; // hourly

async function tick(): Promise<void> {
  try {
    await runCleanup();
  } catch (err) {
    console.error('[worker] cleanup job failed', err);
  }
}

void tick();
setInterval(() => void tick(), CLEANUP_INTERVAL_MS);
startPushDispatcher();

console.log('[worker] started — running cleanup hourly');
