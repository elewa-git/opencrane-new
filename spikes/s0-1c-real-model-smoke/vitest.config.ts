import { defineConfig } from "vitest/config";

// Scoped to this spike folder only (the repo-root config excludes spikes/**).
// The tests start real local processes (agentgateway, Codex app-server) and
// share fixed state under .state/, so test files run one after another.
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    passWithNoTests: false,
    testTimeout: 90_000,
    hookTimeout: 60_000,
    fileParallelism: false,
    pool: "forks",
  },
});
