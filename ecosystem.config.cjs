/**
 * PM2 process definitions for production — docs/11-deployment-architecture.md's
 * "PM2 is the default recommendation" (systemd unit files are the documented
 * alternative for operators who'd rather not add PM2 as a dependency; this file is
 * the PM2 half of that choice). `.cjs`, not `.js` — root package.json sets
 * `"type": "module"`, and PM2 ecosystem files use CommonJS's `module.exports`; a
 * plain `.js` here would be loaded as ESM and fail.
 *
 * Used by `pm2 startOrReload ecosystem.config.cjs` in infrastructure/scripts/deploy.sh
 * — starts both processes on the very first deploy, zero-downtime-reloads them on
 * every one after.
 *
 * What does NOT live here: every other app secret/config (DATABASE_URL, REDIS_URL,
 * JWT_ACCESS_SECRET, etc.) — those belong in apps/web/.env and apps/worker/.env on the
 * server (gitignored, never touched by a deploy — see docs/11's "Secrets management"),
 * loaded by Next's own auto env-loading (apps/web) / dotenv (apps/worker, see
 * apps/worker/src/index.ts's own comment on this). Only `NODE_ENV` and `PORT` are set
 * explicitly below, because apps/web/server.ts reads both at module top-level —
 * `next({ dev })` and `app.prepare()` (where Next's env-loading actually happens)
 * don't run until *after* that — so a value that only exists in apps/web/.env would be
 * too late for these two specifically. Everything else in the app reads env vars after
 * `prepare()` has resolved and gets `.env` normally.
 */
module.exports = {
  apps: [
    {
      name: 'comm-web',
      cwd: './apps/web',
      script: 'npm',
      args: 'start',
      env: {
        NODE_ENV: 'production',
        PORT: '3000',
      },
      max_memory_restart: '500M',
      // Node's own crash-recovery net for whatever a code-level fix hasn't caught yet
      // (docs/11's "memory ceiling as a safety net, on top of — not instead of —
      // actually auditing for leaks"). exp_backoff_restart_delay avoids a hard
      // crash-loop hammering Postgres/Redis with reconnect attempts.
      exp_backoff_restart_delay: 200,
      max_restarts: 15,
    },
    {
      name: 'comm-worker',
      cwd: './apps/worker',
      script: 'npm',
      args: 'start',
      env: {
        NODE_ENV: 'production',
      },
      max_memory_restart: '300M',
      exp_backoff_restart_delay: 200,
      max_restarts: 15,
    },
  ],
};
