import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // Every test sets process.env and the fake binds a port; one file at a
    // time keeps them from seeing each other.
    fileParallelism: false
  }
});
