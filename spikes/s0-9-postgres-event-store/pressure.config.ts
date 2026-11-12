import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['spikes/s0-9-postgres-event-store/tests/pressure.test.ts'],
    maxWorkers: 1,
    testTimeout: 300_000,
    hookTimeout: 30_000,
  },
});
