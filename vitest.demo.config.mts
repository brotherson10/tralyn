import { defineConfig } from "vitest/config";

/**
 * Demo bootstrap tests. DESTRUCTIVE for the LOCAL database (they run
 * `npm run demo:setup` logic, reset included), so they are kept apart from
 * test:db and run only with `npm run test:demo`.
 */
export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    environment: "node",
    include: ["tests/demo/**/*.test.ts"],
    fileParallelism: false,
    testTimeout: 300_000,
    hookTimeout: 60_000,
  },
});
