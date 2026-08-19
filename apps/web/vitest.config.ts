import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    environment: 'node',
    include: ['server/**/*.test.ts'],
    setupFiles: ['./vitest.setup.ts'],
    testTimeout: 20000,
    // Integration tests share one Postgres/Redis and create real rows — run them
    // sequentially within a file to avoid two tests racing on the same rate-limit
    // buckets or unique constraints in ways that would produce flaky, not genuine,
    // failures. Cross-file parallelism is still fine (each file uses its own
    // randomly-suffixed usernames/emails).
    fileParallelism: true,
    sequence: { concurrent: false },
    // Found live: CI (GitHub Actions' ubuntu-latest runners) intermittently failed
    // `prisma.user.create()` calls in exactly one or two test files per run with
    // "Environment variable not found: DATABASE_URL" — Prisma reading an empty
    // `process.env` in that file's specific forked worker — while every other file
    // in the same run (same job, same `env:` block) read it fine. Every local
    // repro (including against a from-scratch database, matching CI's fresh-DB
    // setup exactly) passed 100% of the time, which points at vitest's default
    // `pool: 'forks'` spawning one child process per file and, under CI's more
    // constrained/containerized runner, occasionally not fully propagating
    // `process.env` to one of several concurrently-forked children — not
    // anything about this app's code or tests. Pinning to a single fork removes
    // the multi-process env-propagation variable entirely; this suite runs in a
    // few seconds either way, so the lost cross-file parallelism costs nothing
    // worth trading correctness for.
    poolOptions: { forks: { singleFork: true } },
  },
});
