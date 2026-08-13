/**
 * Tombstone / cleanup migration (QA-R2-2, 2026-08-13 audit R2).
 *
 * An earlier revision of this branch created a `usage_daily` view here. The view was superseded
 * by range-limited parameterized queries in the backend UsageStore (audit R1, TDA-2/QA-3/QA-4)
 * and the migration file was deleted — which structurally broke `migrate:down` on any database
 * that had already applied it ("Definitions of migrations ... have been deleted") and left the
 * stale view plus an orphan pgmigrations row behind.
 *
 * Keeping this file as an idempotent cleanup restores the migration chain's integrity:
 * - fresh databases: `DROP VIEW IF EXISTS` is a no-op;
 * - mid-branch databases: `down` works again, and re-running `up` removes the stale view.
 */
import type { ColumnDefinitions, MigrationBuilder } from "node-pg-migrate";

export const shorthands: ColumnDefinitions | undefined = undefined;

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.sql("DROP VIEW IF EXISTS usage_daily;");
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  // The view is intentionally not recreated: nothing in the codebase reads it anymore.
  pgm.sql("DROP VIEW IF EXISTS usage_daily;");
}
