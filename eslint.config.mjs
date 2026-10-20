// ESLint flat config for the whole workspace.
// Plain recommended + type-checked rules everywhere, and the stricter
// type-checked rule set only on libs/events/src, where the ruleset is cheap
// to run (a small, dependency-free library) and most valuable (it is the
// shared contract every other package relies on).
import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    // spikes and infra have separate qualification; they are not production workspaces.
    // The last two are apps/web's Angular build cache and its project-reference output.
    ignores: ['**/.tools/**', '**/dist/**', '**/node_modules/**', '**/coverage/**', 'spikes/**', 'infra/**', 'docs/design/**/*.js', '**/.angular/**', '**/out-tsc/**'],
  },
  { linterOptions: { reportUnusedDisableDirectives: 'error' } },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      globals: {
        ...globals.node,
      },
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      ...Object.fromEntries([
        'no-floating-promises', 'no-misused-promises', 'no-unsafe-argument',
        'no-unsafe-assignment', 'no-unsafe-call', 'no-unsafe-member-access',
        'no-unsafe-return', 'no-unsafe-function-type', 'no-unsafe-type-assertion',
        'no-unsafe-unary-minus', 'no-unsafe-declaration-merging',
        'no-unsafe-enum-comparison', 'no-unsafe-enum-assignment',
        'no-explicit-any', 'only-throw-error', 'switch-exhaustiveness-check',
      ].map((rule) => [`@typescript-eslint/${rule}`, 'error'])),
      // Plain-English comments beat clever code; we do not lint prose style.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', ignoreRestSiblings: true },
      ],
    },
  },
  {
    // The event envelope and registry are the contract every package reads,
    // so hold this one small library to the stricter type-checked rules.
    files: ['libs/events/src/**/*.ts'],
    extends: [...tseslint.configs.strictTypeChecked],
  },
  {
    files: ['apps/*/src/**/*.ts', 'libs/*/src/**/*.ts'],
    ignores: ['**/*.spec.ts'],
    rules: {
      complexity: ['error', 15],
      'max-depth': ['error', 4],
      'max-lines': ['error', { max: 500, skipBlankLines: true, skipComments: true }],
      'max-lines-per-function': ['warn', { max: 80, skipBlankLines: true, skipComments: true }],
    },
  },
  {
    files: ['apps/server/src/**/*.ts', 'libs/*/src/**/*.ts'],
    rules: { 'no-console': 'error' },
  },
  {
    // Test files may reasonably use looser patterns (e.g. non-null asserts
    // on values a test just set up), so relax a couple of noisy rules.
    files: ['**/*.test.ts'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },
  {
    // Plain Node scripts and root config files: none of these belong to a
    // package tsconfig, so they get no type-aware rules.
    files: [
      'scripts/**/*.mjs', 'docs/process/**/*.mjs', 'apps/computer/test/*.mjs',
      'apps/server/patch-stream-json.mjs',
      '*.mjs', '*.cjs', 'vitest.config.ts',
    ],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
  },
);
