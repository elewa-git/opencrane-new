// ESLint flat config for the whole workspace.
// Plain recommended + type-checked rules everywhere, and the stricter
// type-checked rule set only on libs/events/src, where the ruleset is cheap
// to run (a small, dependency-free library) and most valuable (it is the
// shared contract every other package relies on).
import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

const recordIdRestriction = {
  selector: 'Literal[regex.pattern="^[\\\\w-]{1,200}$"][regex.flags="u"], ' +
    'Literal[regex.pattern="^[A-Za-z0-9_-]{1,200}$"][regex.flags="u"]',
  message: 'Import recordIdSchema or recordIdPattern instead of copying the ID pattern.',
};

const jsonTextComparisonRestriction = {
  selector: 'BinaryExpression[operator=/^(===|!==|==|!=)$/]' +
    '[left.type="CallExpression"][left.callee.type="MemberExpression"]' +
    '[left.callee.object.name="JSON"][left.callee.property.name="stringify"]' +
    '[right.type="CallExpression"][right.callee.type="MemberExpression"]' +
    '[right.callee.object.name="JSON"][right.callee.property.name="stringify"]',
  message: 'Import sameJson instead of comparing JSON.stringify results.',
};

export default tseslint.config(
  {
    // spikes and infra have separate qualification; they are not production workspaces.
    // The last two are apps/web's Angular build cache and its project-reference output.
    ignores: ['**/.tools/**', '**/dist/**', '**/node_modules/**', '**/coverage/**', 'spikes/**', 'infra/**', 'docs/design/**/*.js', '**/.angular/**', '**/out-tsc/**'],
  },
  { linterOptions: { reportUnusedDisableDirectives: 'error' } },
  js.configs.recommended,
  {
    files: ['apps/web/public/mermaid-renderer.js'],
    languageOptions: { globals: globals.browser },
  },
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      globals: {
        ...globals.node,
      },
      parserOptions: {
        // Share Node packages so they reuse one copy of imported library types.
        project: [
          './tsconfig.lint.json',
          './apps/web/tsconfig.app.json',
          './apps/web/tsconfig.spec.json',
          './apps/web/test/tsconfig.json',
        ],
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
      'max-params': ['error', 5],
      complexity: ['error', 15],
      'max-depth': ['error', 4],
      'max-lines': ['error', { max: 500, skipBlankLines: true, skipComments: true }],
      'max-lines-per-function': ['error', { max: 80, skipBlankLines: true, skipComments: true }],
    },
  },
  {
    files: ['apps/*/src/**/*.ts', 'libs/*/src/**/*.ts'],
    ignores: ['libs/events/src/ids.ts'],
    rules: {
      'no-restricted-syntax': ['error', recordIdRestriction],
    },
  },
  {
    files: ['apps/*/src/**/*.ts', 'libs/*/src/**/*.ts'],
    ignores: ['**/*.test.ts', '**/*.spec.ts'],
    rules: {
      'no-restricted-syntax': ['error', recordIdRestriction, jsonTextComparisonRestriction],
    },
  },
  {
    // Exempt the shared ID definition only from its own copy rule.
    files: ['libs/events/src/ids.ts'],
    rules: { 'no-restricted-syntax': ['error', jsonTextComparisonRestriction] },
  },
  {
    files: ['apps/*/src/**/*.ts', 'libs/*/src/**/*.ts'],
    ignores: ['**/*.test.ts', '**/*.spec.ts'],
    rules: {
      'no-restricted-imports': ['error', {
        paths: [{
          name: 'node:crypto',
          importNames: ['createHash'],
          message: 'Import sha256Hex or sha256HexOfJson from @opencrane/events/digest.',
        }],
      }],
    },
  },
  {
    files: [
      'libs/events/src/digest.ts', // Own the shared Node SHA-256 hex implementation.
      'libs/models/src/connection-custody.ts', // Feed conditional identity parts into one hash.
      'libs/models/src/oauth-attempt.ts', // Encode the OAuth challenge as base64url.
      'apps/computer/src/bridge-socket.ts', // Compare raw digest bytes in constant time.
      'apps/server/src/members/bootstrap.ts', // Compare raw digest bytes in constant time.
      'apps/server/src/overview/rows.ts', // Hash progress and ordered rows with separate updates.
    ],
    rules: { 'no-restricted-imports': 'off' },
  },
  {
    files: ['**/*.test.ts', '**/*.spec.ts', '**/*.test.mjs'],
    rules: {
      'max-lines': ['error', { max: 1500, skipBlankLines: true, skipComments: true }],
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
