import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.{test,spec}.ts", "test/**/*.{test,spec}.ts"],
    // 整合テストが実 Postgres に接続するため .env を process.env へ読み込む。
    setupFiles: ["./test/setup-env.ts"],
  },
});
