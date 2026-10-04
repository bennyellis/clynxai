import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globals: false,
    setupFiles: ["./test/setup.ts"],
    testTimeout: 20000,
    hookTimeout: 20000,
  },
});
