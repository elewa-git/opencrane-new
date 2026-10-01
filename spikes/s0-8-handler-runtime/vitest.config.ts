import { resolve } from 'node:path';
process.env.SWC_NATIVE_BINDING_CACHE = resolve(import.meta.dirname, '.cache/swc');
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Each test file starts its own PostgreSQL and (for Temporal) its own
    // server on its own random ports and stops them in afterAll. Files run
    // one at a time so the timing numbers are comparable between files and
    // a laptop is not overloaded.
    fileParallelism: false,
    testTimeout: 300_000,
    hookTimeout: 120_000,
    include: ['tests/**/*.test.ts'],
  },
});
