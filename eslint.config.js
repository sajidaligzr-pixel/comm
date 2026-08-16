// Single root flat config covering the whole monorepo — simpler than a per-package
// config file for a project this size; packages/config/eslint.base.js is still the
// actual shared rule set (docs/78-source-code-structure.md keeps it isolated there
// so it's reviewed once), this file just applies it repo-wide and adds the
// module-boundary rule described in docs/00-overview.md#module-boundary-without-nest.
import { baseConfig } from '@comm/config/eslint.base.js';

/** @type {import('eslint').Linter.Config[]} */
export default [
  ...baseConfig,
  {
    ignores: ['**/generated/**', '**/.next/**', '**/dist/**', '**/node_modules/**', '**/coverage/**'],
  },
  {
    // Type-aware rules (no-floating-promises, no-misused-promises — both flag real
    // correctness/security bugs, e.g. a forgotten `await` on an auth check) need a
    // typed program to run against. `projectService: true` has typescript-eslint
    // auto-discover the nearest tsconfig.json per linted file — every package/app in
    // this monorepo has its own, so this "just works" without listing them by hand.
    files: ['**/*.ts', '**/*.tsx'],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    // apps/worker has no request/response cycle or structured logger yet (that's a
    // later-phase concern) — its whole job is periodic operational status output,
    // captured by the process manager (docs/11-deployment-architecture.md), so
    // plain console.log is the right tool here, not a smell. Same reasoning for the
    // one-shot operator-run bootstrap script — it's a CLI tool talking to a human.
    files: ['apps/worker/**/*.ts', 'packages/database/scripts/**/*.ts'],
    rules: {
      'no-console': 'off',
    },
  },
  {
    // apps/web/server/modules/* is where authorization logic must live centrally
    // (docs/00-overview.md) — nothing outside a module's own directory should reach
    // into another module's Prisma calls directly. This is a coarse first pass (flags
    // cross-module relative imports); tightened per-module if it proves too broad.
    files: ['apps/web/app/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'warn',
        {
          patterns: [
            {
              group: ['@comm/database'],
              message:
                'Route Handlers/pages should not import @comm/database directly — go through a server/modules/*/service.ts function so authorization stays centralized (docs/00-overview.md).',
            },
          ],
        },
      ],
    },
  },
];
