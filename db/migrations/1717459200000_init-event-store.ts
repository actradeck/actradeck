/**
 * Migration: init event store (Phase 0).
 *
 * 設計原則 (.claude/rules/database.md):
 * - events は append-only (破壊的 UPDATE/DELETE を基本としない)。
 * - 識別子は時系列ソート可能な UUIDv7 を推奨 (id 列)。ただし正規化イベントの
 *   冪等性キーは plan.md §6 の event_id (provider 由来) で、これに UNIQUE 制約。
 * - session_state は reducer 由来の projection (1 行 / セッション)。
 * - up/down 両方を用意・検証 (ロールバック可能)。
 *
 * スキーマは T1 正典 (packages/event-model, Phase 1) と一致させる。ドリフト時は T1 が勝つ。
 * Phase 1 で enum 値 (event_type / state) を厳格化する余地を残し、現段階では
 * TEXT + CHECK は付けず前方互換を優先する (新イベント型追加で破壊しない)。
 */
import type { ColumnDefinitions, MigrationBuilder } from "node-pg-migrate";

export const shorthands: ColumnDefinitions | undefined = undefined;

export async function up(pgm: MigrationBuilder): Promise<void> {
  // UUIDv7 を生成する pgcrypto/uuid 拡張は環境依存のため、ID はアプリ側 (event-model)
  // で UUIDv7 を採番して渡す方針。DB ではデフォルト gen を強制しない。

  // --- sessions: セッション単位メタ -------------------------------------
  pgm.createTable("sessions", {
    session_id: { type: "text", primaryKey: true },
    provider: { type: "text", notNull: true }, // claude_code | codex ...
    source: { type: "text", notNull: true }, // hooks | app_server | sdk
    agent_id: { type: "text", notNull: false },
    repo: { type: "text", notNull: false },
    branch: { type: "text", notNull: false },
    cwd: { type: "text", notNull: false },
    started_at: { type: "timestamptz", notNull: false },
    ended_at: { type: "timestamptz", notNull: false },
    metadata: { type: "jsonb", notNull: true, default: pgm.func("'{}'::jsonb") },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
    updated_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
  });
  pgm.createIndex("sessions", "provider");
  pgm.createIndex("sessions", "started_at");

  // --- events: append-only 正規化イベントストア (plan.md §6) -------------
  pgm.createTable("events", {
    // DB 内部 PK (時系列ソート可能 ID をアプリで採番)。
    id: { type: "uuid", primaryKey: true },
    // plan.md §6 正規化イベント ID。冪等性のため UNIQUE。
    event_id: { type: "text", notNull: true },
    provider: { type: "text", notNull: true },
    source: { type: "text", notNull: true },
    session_id: { type: "text", notNull: true },
    thread_id: { type: "text", notNull: false },
    turn_id: { type: "text", notNull: false },
    agent_id: { type: "text", notNull: false },
    event_type: { type: "text", notNull: true },
    state: { type: "text", notNull: false },
    timestamp: { type: "timestamptz", notNull: true },
    cwd: { type: "text", notNull: false },
    summary: { type: "text", notNull: false },
    payload: { type: "jsonb", notNull: true, default: pgm.func("'{}'::jsonb") },
    metrics: { type: "jsonb", notNull: true, default: pgm.func("'{}'::jsonb") },
    // 取り込み時刻 (受信側の壁時計)。順序診断・遅延計測に使う。
    ingested_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
  });

  // 冪等性: 同一 event_id の二重取り込みを拒否 (Phase 3 で ON CONFLICT DO NOTHING)。
  pgm.addConstraint("events", "events_event_id_unique", {
    unique: ["event_id"],
  });

  // タイムライン取得・状態 reduce の主クエリ用。
  pgm.createIndex("events", ["session_id", "timestamp"]);
  pgm.createIndex("events", "timestamp");
  pgm.createIndex("events", "event_type");

  // events → sessions の参照整合 (セッション未登録イベントは Phase 3 で upsert 先行)。
  pgm.addConstraint("events", "events_session_fk", {
    foreignKeys: {
      columns: "session_id",
      references: "sessions(session_id)",
      onDelete: "CASCADE",
    },
  });

  // --- session_state: reducer 由来 projection (1 行 / セッション) --------
  pgm.createTable("session_state", {
    session_id: {
      type: "text",
      primaryKey: true,
      references: "sessions(session_id)",
      onDelete: "CASCADE",
    },
    // 現在の正規化状態 (plan.md §4: running.* / waiting.* / stalled ...)。
    state: { type: "text", notNull: true },
    current_action: { type: "text", notNull: false }, // 例: "npm test 実行中"
    last_event_id: { type: "text", notNull: false },
    last_event_at: { type: "timestamptz", notNull: false },
    // Liveness 分解シグナル (plan.md §5)。projection に保持し UI へ根拠表示。
    liveness: { type: "jsonb", notNull: true, default: pgm.func("'{}'::jsonb") },
    needs_attention: { type: "boolean", notNull: true, default: false },
    // reducer の冪等再構築用 (適用済み最終イベントの順序位置)。
    last_applied_seq: { type: "bigint", notNull: false },
    updated_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
  });
  pgm.createIndex("session_state", "state");
  pgm.createIndex("session_state", "needs_attention");
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  // 依存順に drop (projection → events → sessions)。
  pgm.dropTable("session_state");
  pgm.dropTable("events");
  pgm.dropTable("sessions");
}
