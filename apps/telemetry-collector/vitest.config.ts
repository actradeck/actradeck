import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

const migrations = await readD1Migrations("./migrations");

export default defineConfig({
  plugins: [
    cloudflareTest({
      miniflare: {
        compatibilityDate: "2026-08-13",
        d1Databases: ["DB"],
        bindings: {
          ADMIN_TOKEN: "a".repeat(32),
          HASH_SECRET: "h".repeat(32),
          TEST_MIGRATIONS: migrations,
        },
      },
    }),
  ],
  test: {
    include: ["src/**/*.test.ts"],
  },
});
