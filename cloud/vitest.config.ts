import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globals: false,
    setupFiles: ["./test/setup.ts"],
    fileParallelism: false, // one Owner can exist in the shared test database, and several files create one
    testTimeout: 20000,
    hookTimeout: 20000,
  },
});
