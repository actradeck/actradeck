/**
 * Privacy-preserving local usage projection.
 *
 * The view contains UTC day buckets and aggregate counts only. It intentionally exposes no
 * session/event identifiers, commands, prompts, paths, repositories, or sub-day timestamps.
 * It is derived from the append-only store, so retries and multiple session.started events
 * cannot silently double-count a session.
 */
import type { ColumnDefinitions, MigrationBuilder } from "node-pg-migrate";

export const shorthands: ColumnDefinitions | undefined = undefined;

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    CREATE VIEW usage_daily AS
    WITH session_daily AS (
      SELECT
        (started_at AT TIME ZONE 'UTC')::date AS day,
        count(*) FILTER (WHERE session_id LIKE 'demo-safety-%')::bigint AS cockpit_demo_started,
        count(*) FILTER (WHERE session_id NOT LIKE 'demo-safety-%')::bigint AS real_sessions,
        count(*) FILTER (
          WHERE session_id NOT LIKE 'demo-safety-%'
            AND governance_mode = 'enforcement'
        )::bigint AS protected_sessions
      FROM sessions
      WHERE started_at IS NOT NULL
      GROUP BY 1
    ),
    event_daily AS (
      SELECT
        (timestamp AT TIME ZONE 'UTC')::date AS day,
        count(DISTINCT session_id) FILTER (
          WHERE session_id LIKE 'demo-safety-%'
            AND event_type = 'session.ended'
        )::bigint AS cockpit_demo_completed,
        count(*) FILTER (
          WHERE session_id NOT LIKE 'demo-safety-%'
            AND event_type = 'tool.permission.requested'
        )::bigint AS approval_requests,
        count(*) FILTER (
          WHERE session_id NOT LIKE 'demo-safety-%'
            AND event_type = 'tool.permission.resolved'
            AND payload->>'resolution_origin' = 'operator'
        )::bigint AS operator_decisions
      FROM events
      GROUP BY 1
    ),
    days AS (
      SELECT day FROM session_daily
      UNION
      SELECT day FROM event_daily
    )
    SELECT
      days.day,
      COALESCE(session_daily.cockpit_demo_started, 0)::bigint AS cockpit_demo_started,
      COALESCE(event_daily.cockpit_demo_completed, 0)::bigint AS cockpit_demo_completed,
      COALESCE(session_daily.real_sessions, 0)::bigint AS real_sessions,
      COALESCE(session_daily.protected_sessions, 0)::bigint AS protected_sessions,
      COALESCE(event_daily.approval_requests, 0)::bigint AS approval_requests,
      COALESCE(event_daily.operator_decisions, 0)::bigint AS operator_decisions
    FROM days
    LEFT JOIN session_daily USING (day)
    LEFT JOIN event_daily USING (day)
  `);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.sql("DROP VIEW usage_daily");
}
