/**
 * Migration: sessions に capture_mode テキスト列を追加する (ADR 019ea4ba D4 / TDA-1 019ea49a-0f21 消化)。
 *
 * 背景 (Attach Mode UI バッジ / セッション詳細4ペイン段階1):
 * - sidecar は managed (ラッパ経由) と attach (常駐 daemon が観測) の 2 取得方式を持つ。
 *   attach は「観測専用 (degraded/observability-only)」であり、UI の status-bar に明示する必要がある。
 * - NormalizedEvent.capture_mode は T1 (packages/event-model) で optional 既定 managed。これを
 *   sessions 行へ投影し、realtime-store の JOIN_SELECT から SessionListItem/SessionDetail に載せる。
 *
 * 安全性 (database.md マイグレーション安全):
 * - 列「追加」のみ (削除・型変更なし) で前方/後方互換。既存行は NULL = 未指定 = managed 既定扱い
 *   (projection key には使わない・寛容性 LIVE-FOUND-3)。CHECK 制約は付けず前方互換を優先する
 *   (新 capture_mode 値が増えても破壊しない)。
 * - up = addColumn / down = dropColumn (ロールバック可能・冪等)。
 *
 * T1 整合: packages/event-model/src/event.ts の `capture_mode: z.enum(["managed","attach"]).optional()`
 * が本列の正典形。欠落 (NULL) は managed 既定。
 */
import type { ColumnDefinitions, MigrationBuilder } from "node-pg-migrate";

export const shorthands: ColumnDefinitions | undefined = undefined;

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.addColumn("sessions", {
    capture_mode: {
      type: "text",
      notNull: false,
    },
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropColumn("sessions", "capture_mode");
}
