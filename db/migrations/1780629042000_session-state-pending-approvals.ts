/**
 * Migration: session_state に pending_approvals jsonb 列を追加する (ADR 019e9999)。
 *
 * 背景 (承認フロー UI / 段階①):
 * - reducer は `tool.permission.requested` から未解決の承認要求 (request_id / tool_name /
 *   redaction 済み command/path / risk_level) を畳み込み、`tool.permission.resolved` で除去する。
 * - この pending_approvals を UI へ届ける outbound 経路のため、projection の永続表現に専用列を足す。
 *   liveness jsonb への混在を避け、意味的に分離する (liveness は別モジュールが合成する診断情報)。
 *
 * 安全性 (database.md マイグレーション安全):
 * - 列「追加」のみ (削除・型変更なし) で前方/後方互換。既存行は DEFAULT '[]'::jsonb で埋まる。
 * - up = addColumn / down = dropColumn (ロールバック可能・冪等)。
 * - **値は sidecar (INV-REDACTION choke point) で redaction 済み**。backend は再 redaction しない
 *   契約のため、ここに生 payload を新規露出させない (command は summarize、path 含む全フィールドは
 *   sidecar EventSink.emit の redactDeep で redaction 済み)。
 *
 * T1 整合: reducer.PendingApproval (apps/backend/src/reducer.ts) が本列 jsonb の正典形。
 */
import type { ColumnDefinitions, MigrationBuilder } from "node-pg-migrate";

export const shorthands: ColumnDefinitions | undefined = undefined;

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.addColumn("session_state", {
    pending_approvals: {
      type: "jsonb",
      notNull: true,
      default: pgm.func("'[]'::jsonb"),
    },
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropColumn("session_state", "pending_approvals");
}
