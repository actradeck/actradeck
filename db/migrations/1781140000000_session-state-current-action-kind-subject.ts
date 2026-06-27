/**
 * Migration: session_state に current_action_kind / current_action_subject (text) 列を追加する
 * (現在のアクション要約の**表示時ローカライズ** / ADR 019eeac6)。
 *
 * 背景 (current_action 日本語焼付けの根因解消):
 * - 両 normalizer (apps/sidecar/src/normalize.ts / normalize-codex.ts) が event.summary に日本語固定
 *   文字列を焼き込む (「コマンド実行: …」等)。projection がそれを current_action へ素通しするため、
 *   UI を英語にしても要約が日本語のまま残る。
 * - これを断つため projection を **(kind, subject)** へ分解する:
 *     - current_action_kind: 最新 event_type を ActionKind (closed-enum) へ写した分類軸。
 *       出所は packages/event-model の eventTypeToActionKind (純写像)。
 *     - current_action_subject: redacted payload の kind 別 allowlist フィールド (command / path /
 *       server/tool / query / tool_name / reason) からのみ引いた構造値。**summary は出所にしない**
 *       (日本語が焼き付いているため)。
 *   webui がこの (kind, subject) を locale 別述語テンプレートへ流し込む (述語の出所を UI へ移す)。
 * - 既存 current_action 列は **据置** (legacy summary fallback として保持)。
 *
 * 配置 (session_state):
 * - kind/subject は projection (reducer) 由来ゆえ他の projection 列と同じ session_state に置く。
 *   realtime-store の JOIN_SELECT が ss.* を読み SessionDetail / SessionListItem へ載る。
 *
 * 型 (DB text + 読み出しゲート / redaction-kinds T1 昇格 019ec744 と同型):
 * - current_action_kind は **text** とし、読み出し時に event-model の `isActionKind` ゲートで
 *   未知値を graceful に undefined 化する (forward-compat。loose schema・未知 kind を reject しない)。
 * - current_action_subject は text (任意の redacted 構造値・closed-enum ではない)。
 *
 * 安全性 (database.md マイグレーション安全):
 * - 列「追加」のみ (削除・型変更なし) で前方/後方互換。**nullable・default なし**。旧行は NULL
 *   (= 未確定) のまま (readProjection が NULL→undefined で復元、DTO は NULL→キー落とし)。
 * - up = addColumn / down = dropColumn (ロールバック可能・冪等)。CHECK なし・破壊操作なし。
 *
 * T1 整合: packages/projection/src/index.ts の SessionProjection.current_action_kind /
 *   current_action_subject が本列の正典形。current_action_kind の値域は @actradeck/event-model の
 *   ACTION_KINDS (ActionKind)。
 */
import type { ColumnDefinitions, MigrationBuilder } from "node-pg-migrate";

export const shorthands: ColumnDefinitions | undefined = undefined;

export async function up(pgm: MigrationBuilder): Promise<void> {
  // nullable・default なし。旧行は NULL (= 未確定) のまま。current_action 列は据置。
  pgm.addColumn("session_state", {
    current_action_kind: {
      type: "text",
      notNull: false,
    },
    current_action_subject: {
      type: "text",
      notNull: false,
    },
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropColumn("session_state", "current_action_kind");
  pgm.dropColumn("session_state", "current_action_subject");
}
