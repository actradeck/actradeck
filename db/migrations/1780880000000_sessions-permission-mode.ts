/**
 * Migration: sessions に permission_mode テキスト列を追加する (ADR 019ea4ba D3 / 段階2)。
 *
 * 背景 (セッション詳細4ペイン段階2 / 右ペイン sandbox 表示):
 * - Claude Code hooks の共通入力に `permission_mode` (default / acceptEdits / bypassPermissions /
 *   plan 等) が載る。これは「監督対象 agent がどこまで自動許可されているか」= 介入要否の手がかりで、
 *   右ペインに明示する (どこまで自動実行が許されるかを supervisor が把握できる)。
 * - NormalizedEvent.permission_mode は T1 (packages/event-model) で optional (自由文字列)。これを
 *   sessions 行へ投影し、realtime-store の JOIN_SELECT から SessionDetail に載せる。
 *
 * sticky 方針の差 (capture_mode との対比):
 * - capture_mode は観測モード = session 不変ゆえ sticky (一度 attach なら戻さない)。
 * - permission_mode は session 途中で変わりうる (default→acceptEdits) ため **last-non-null-wins**
 *   (ingest-store が COALESCE(EXCLUDED, existing) で欠落時のみ既存維持・非欠落なら最新へ更新)。
 *
 * 安全性 (database.md マイグレーション安全):
 * - 列「追加」のみ (削除・型変更なし) で前方/後方互換。既存行は NULL = 未指定。CHECK 制約は付けず
 *   前方互換を優先 (新 permission_mode 値が増えても破壊しない)。
 * - up = addColumn / down = dropColumn (ロールバック可能・冪等)。
 *
 * T1 整合: packages/event-model/src/event.ts の `permission_mode: z.string().optional()` が本列の正典形。
 */
import type { ColumnDefinitions, MigrationBuilder } from "node-pg-migrate";

export const shorthands: ColumnDefinitions | undefined = undefined;

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.addColumn("sessions", {
    permission_mode: {
      type: "text",
      notNull: false,
    },
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropColumn("sessions", "permission_mode");
}
