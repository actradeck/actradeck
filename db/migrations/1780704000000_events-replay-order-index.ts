/**
 * Migration: add covering replay-order index for Session Replay history.
 *
 * Replay pages by session and chronological cursor:
 *   WHERE session_id = $1 AND (timestamp, event_id) > (...)
 *   ORDER BY timestamp ASC, event_id ASC
 *
 * The initial schema had (session_id, timestamp), which is enough for rough filtering but still
 * leaves event_id tie-break sorting/filtering work for same-timestamp rows. This explicit index
 * encodes the replay T1 order in storage and keeps large sessions predictable.
 */
import type { ColumnDefinitions, MigrationBuilder } from "node-pg-migrate";

export const shorthands: ColumnDefinitions | undefined = undefined;

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.noTransaction();
  pgm.sql(
    `CREATE INDEX CONCURRENTLY IF NOT EXISTS events_session_id_timestamp_event_id_index
       ON events (session_id, timestamp, event_id)`,
  );
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.noTransaction();
  pgm.sql(`DROP INDEX CONCURRENTLY IF EXISTS events_session_id_timestamp_event_id_index`);
}
