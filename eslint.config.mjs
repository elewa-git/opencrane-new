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
    // The last two are apps/web's Angular build cache and its project-reference output.
    ignores: ['**/dist/**', '**/node_modules/**', '**/coverage/**', 'spikes/**', '**/.angular/**', '**/out-tsc/**'],
  },
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
    files: ['scripts/**/*.mjs', '*.mjs', 'vitest.config.ts'],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
  },
);
