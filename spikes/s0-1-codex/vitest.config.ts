import { defineConfig } from "vitest/config";

// Scoped to this spike folder only. The repo-root vitest.config.ts
// deliberately excludes spikes/**, so this spike needs its own config to
// run its tests at all (kept local: we never touch the root config).
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    passWithNoTests: false,
    hookTimeout: 30_000,
  },
});
