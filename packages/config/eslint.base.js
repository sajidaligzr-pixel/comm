// Shared ESLint flat-config base. Each app/package extends this and adds its own
// scoped rules (e.g. apps/web adds a no-restricted-imports rule per server module —
// see docs/00-overview.md#module-boundary-without-nest).
import tseslint from '@typescript-eslint/eslint-plugin';
import tsParser from '@typescript-eslint/parser';
import prettierConfig from 'eslint-config-prettier';
import noSecrets from 'eslint-plugin-no-secrets';

/** @type {import('eslint').Linter.Config[]} */
export const baseConfig = [
  {
    ignores: ['**/dist/**', '**/.next/**', '**/node_modules/**', '**/coverage/**', '**/generated/**'],
  },
  {
    files: ['**/*.ts', '**/*.tsx'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        sourceType: 'module',
        ecmaFeatures: { jsx: true },
      },
    },
    plugins: {
      '@typescript-eslint': tseslint,
      'no-secrets': noSecrets,
    },
    rules: {
      // `any` defeats the point of strict TS on security-sensitive code paths — see
      // docs/101 coding standards. A narrow, explicitly-commented escape hatch is
      // still possible via a targeted eslint-disable, which is reviewable; a blanket
      // allowance is not.
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/no-floating-promises': 'error',
      // `attributes: false` — React event handlers (onClick={async () => ...}) are a
      // deliberate, common, safe pattern (React doesn't care about the handler's
      // return type); without this the rule flags essentially every form submit/click
      // handler in apps/web's components. Everywhere else (real void-typed callback
      // params) the rule still applies at full strength.
      '@typescript-eslint/no-misused-promises': ['error', { checksVoidReturn: { attributes: false } }],
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      // Catches accidental hardcoded secrets/keys before they reach a commit — a
      // second line of defense behind the repo-level secret scan in CI, not a
      // replacement for it (see docs/11-deployment-architecture.md).
      'no-secrets/no-secrets': ['error', { tolerance: 4.2 }],
      // Nothing in this codebase should shell out with dynamically built input —
      // see docs/12-testing-strategy.md's command-injection test note.
      'no-restricted-properties': [
        'error',
        {
          object: 'child_process',
          property: 'exec',
          message: 'Avoid shelling out with interpolated input. If genuinely needed, use execFile with an argument array and get this reviewed.',
        },
      ],
    },
  },
  prettierConfig,
];

export default baseConfig;
