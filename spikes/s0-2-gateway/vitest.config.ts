import { defineConfig } from "vitest/config";

// This spike's tests drive one shared stack of real local processes
// (OpenFGA, agentgateway, and our four stub services), started once in
// beforeAll. That means the single test file must run alone, not
// sharded across worker threads/forks.
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    testTimeout: 30 * 1000,
    hookTimeout: 60 * 1000,
    fileParallelism: false,
    pool: "forks",
  },
});
