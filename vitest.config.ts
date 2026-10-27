import { defineConfig } from 'vitest/config';
import DurationSequencer from './scripts/ci/sequencer.mjs';

// Keep package recovery fixtures in the same file list as library and app tests,
// so the ordinary CI shards run their real NATS and PostgreSQL checks.
export default defineConfig({
  test: {
    include: ['apps/**/*.test.ts', 'libs/**/*.test.ts', 'scripts/*.test.mjs',
      'infra/package/upgrade-recovery*.test.ts', 'infra/package/bootstrap.test.ts',
      'infra/package/backup-capture.test.ts'],
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
