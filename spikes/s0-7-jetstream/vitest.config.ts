import { defineConfig } from "vitest/config";

// Each test file gets its own nats-server process(es) on its own ports, so
// files can run one-at-a-time without port clashes. Tests are long-running
// (cluster boot, 1M-subject scale) so timeouts are generous.
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    testTimeout: 10 * 60 * 1000,
    hookTimeout: 2 * 60 * 1000,
    fileParallelism: false,
    pool: "forks",
  },
});
