import { defineConfig } from "vitest/config";

// Root vitest config shared by workspace packages via `extends`.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.{test,spec}.ts", "test/**/*.{test,spec}.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
    },
  },
});
