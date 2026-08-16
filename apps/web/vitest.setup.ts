import { config } from 'dotenv';

// Loads apps/web/.env into process.env for the test run — Vitest (unlike Next.js)
// doesn't do this automatically, and these tests intentionally run against the real
// local Postgres/Redis (see docs/12-testing-strategy.md's "test against the real
// thing" approach), not mocks, so DATABASE_URL/REDIS_URL/etc. must be present.
config();
