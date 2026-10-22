import { defineConfig } from 'vitest/config';
import DurationSequencer from './scripts/ci/sequencer.mjs';

// One config for every package: vitest finds every *.test.ts file under
// apps/ and libs/, so a new package needs no config of its own.
export default defineConfig({
  test: {
    include: ['apps/**/*.test.ts', 'libs/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', 'spikes/**'],
    environment: 'node',
    sequence: { sequencer: DurationSequencer },
    passWithNoTests: false,
    // Disposable service fixtures need room under load; authority tests assert their own deadlines.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // apps/server now logs JSON via pino; keep test output readable.
    env: { LOG_LEVEL: 'silent' },
  },
});
