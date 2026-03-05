import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*-e2e.test.ts"],
    hookTimeout: 180_000,
    testTimeout: 120_000,
    maxWorkers: 1,
    minWorkers: 1,
    pool: "forks",
  },
});
