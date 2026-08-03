/**
 * Migration #12: work_items 投影テーブル (ADR 0015 evidence-based completion・§D4・additive/非破壊).
 *
 * 背景:
 * - エージェントが「完了」と自己申告した work item を、その claim / 検証 / staleness と共に 1 行で保持する
 *   **投影テーブル** (session_state と同格の projection・source of truth は append-only events)。
 *   packages/projection の純 fold (`reduceWorkItems`) が唯一の書き手ロジックで、rebuild-from-events 可能。
 * - 本 slice (A1) は**テーブルのみ**。backend の増分 wiring (ingest tx 内で fold→upsert) は A2。
 *
 * 家風 (database.md / 既存 11 本):
 * - TEXT 列 + **CHECK 制約なし** (前方互換・app 層 closed-enum gate = event-model の
 *   WorkItemStatus / VerificationState / CheckKind / CheckMatch / ObservationMethod/Fidelity)。
 *   ドリフト時は T1 (packages/event-model/src/work-item.ts) が勝つ。
 * - additive のみ (列削除・型変更なし)。up = createTable / down = dropTable (冪等・ロールバック可)。
 *
 * PK / FK (§D4):
 * - PK `(session_id, work_item_id)` — per-session の work item 同一性。追加 index は付けない
 *   (per-session cardinality 小・list 面は PK prefix で join)。
 * - FK `session_id → sessions(session_id)` ON DELETE CASCADE (session_state / events と同じ整合)。
 *
 * 列 (§D4・NOT NULL は status / verification_state / updated_at のみ・他は nullable):
 * - id_scheme         : "task" | "plan" (WorkItemIdScheme・観測形状で命名)。
 * - subject           : redacted + post-floor 有界 (boundTurnSummary 再利用)。**description は投影しない**
 *                       (leak/bloat trim・redacted event が保持し UI detail は timeline から読む)。
 * - status            : WorkItemStatus (NOT NULL)。
 * - ordinal           : plan snapshot の配列 index (task scheme は NULL)。
 * - created_at / created_event_id : 初観測。
 * - claimed_at / claim_event_id / claim_method / claim_fidelity : CompletionClaim (§D5・初観測 + 最高 fidelity)。
 * - verification_state: VerificationState (NOT NULL・**永久 verified boolean は存在しない**・§D5)。
 * - verified_at / verification_event_id / check_kind / check_match / check_exit_code / verified_tree_fp :
 *                       束縛した check の証跡 (§D5/§D6)。
 * - run_dirty         : check 実行中に tree が動いたか (§D5・false-green 防止)。
 * - stale_at / stale_event_id : passed → stale (fingerprint 変化) の証跡。
 * - updated_at        : 最終更新 (NOT NULL)。
 */
import type { ColumnDefinitions, MigrationBuilder } from "node-pg-migrate";

export const shorthands: ColumnDefinitions | undefined = undefined;

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable("work_items", {
    session_id: {
      type: "text",
      notNull: true,
      references: "sessions(session_id)",
      onDelete: "CASCADE",
    },
    work_item_id: { type: "text", notNull: true },
    id_scheme: { type: "text", notNull: false },
    subject: { type: "text", notNull: false },
    status: { type: "text", notNull: true },
    ordinal: { type: "integer", notNull: false },
    created_at: { type: "timestamptz", notNull: false },
    created_event_id: { type: "text", notNull: false },
    claimed_at: { type: "timestamptz", notNull: false },
    claim_event_id: { type: "text", notNull: false },
    claim_method: { type: "text", notNull: false },
    claim_fidelity: { type: "text", notNull: false },
    verification_state: { type: "text", notNull: true },
    verified_at: { type: "timestamptz", notNull: false },
    verification_event_id: { type: "text", notNull: false },
    check_kind: { type: "text", notNull: false },
    check_match: { type: "text", notNull: false },
    check_exit_code: { type: "integer", notNull: false },
    verified_tree_fp: { type: "text", notNull: false },
    run_dirty: { type: "boolean", notNull: true, default: false },
    stale_at: { type: "timestamptz", notNull: false },
    stale_event_id: { type: "text", notNull: false },
    updated_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
  });

  // PK (session_id, work_item_id)。追加 index は付けない (§D4・per-session cardinality 小)。
  pgm.addConstraint("work_items", "work_items_pkey", {
    primaryKey: ["session_id", "work_item_id"],
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable("work_items");
}
