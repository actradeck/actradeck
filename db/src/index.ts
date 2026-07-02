/**
 * @actradeck/db — public entrypoint.
 *
 * migrations 自体は node-pg-migrate CLI (`pnpm db:migrate`) で適用するのが基本だが、
 * 埋込 PGlite (ADR 019f1b71) の backend 起動時 in-process migration のために
 * programmatic runner を公開する。
 */
export { runMigrations, assertMigrationsFresh, type RunMigrationsOptions } from "./migrate.js";
