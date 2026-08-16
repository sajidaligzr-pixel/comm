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
  },
});
