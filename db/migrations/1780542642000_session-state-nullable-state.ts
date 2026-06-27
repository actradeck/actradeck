/**
 * Migration: session_state.state を nullable 化する (TDA-1 修正)。
 *
 * 背景 (再監査#5 TDA-1, M):
 * - reducer (packages... event-model 経由) の **first-observation 意味論**: state を持たない
 *   初イベント (heartbeat / notification / subagent.* など) は projection.state を undefined の
 *   まま通す (まだ正規化状態が確定していない、という観測事実を保持する)。
 * - しかし init migration (9930c4b, 1717459200000) で `session_state.state` は NOT NULL のため、
 *   ingest-store が undefined を "created" で代替して永続していた。これにより:
 *     - 「未確定 (undefined)」と「本物の created」が DB round-trip 後に区別不能になり、
 *     - 次の ingest で running.* (UserPromptSubmit→turn.started 等) が来ると prev.state="created"
 *       となり isValidTransition("created","running.model_wait")=false で **state が created に
 *       貼り付く** → plan.md 最重要 KPI「観測された実際の作業状態のみ表示」違反 (実走中
 *       セッションが UI で created 停止に見える)。
 *
 * 修正方針 (database.md マイグレーション安全):
 * - init migration はコミット済み (9930c4b) のため **書き換えず**、本 **新規 migration** で
 *   `session_state.state` の NOT NULL 制約のみを段階的に外す (列削除・型変更ではないため
 *   前方/後方互換: 既存の "created"/"running.*" 等の値はそのまま残る)。
 * - up = DROP NOT NULL / down = SET NOT NULL。down は NULL 行が残っていると失敗するため、
 *   ロールバック前に NULL を "created" へ畳んで後方互換を保つ (init スキーマの不変条件へ復帰)。
 *
 * T1 整合: events.state は init から既に nullable (notNull:false)。本変更で session_state.state も
 * 同じ nullable 表現へ揃え、reducer の first-observation 意味論を DB 跨ぎで保持する。
 */
import type { ColumnDefinitions, MigrationBuilder } from "node-pg-migrate";

export const shorthands: ColumnDefinitions | undefined = undefined;

export async function up(pgm: MigrationBuilder): Promise<void> {
  // first-observation 未確定 (undefined) を NULL として round-trip できるように NOT NULL を外す。
  pgm.alterColumn("session_state", "state", { notNull: false });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  // 後方互換ロールバック: NOT NULL を復元する前に、本 migration 以降に書かれた NULL
  // (= first-observation 未確定) を init スキーマの既定だった "created" へ畳む。
  // これがないと NULL 行が残った状態で SET NOT NULL が失敗する。
  pgm.sql(`UPDATE session_state SET state = 'created' WHERE state IS NULL`);
  pgm.alterColumn("session_state", "state", { notNull: true });
}
