import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['spikes/s0-9-postgres-event-store/tests/volume.test.ts'],
    maxWorkers: 1,
    testTimeout: 300_000,
    hookTimeout: 120_000,
    env: { LOG_LEVEL: 'silent' },
  },
});
