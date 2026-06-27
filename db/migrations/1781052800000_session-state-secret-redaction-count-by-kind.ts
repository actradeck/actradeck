/**
 * Migration: session_state に secret_redaction_count_by_kind (jsonb) 列を追加する
 * (強み(a)③ redaction 可視化 / 設計 019ec68c)。
 *
 * 背景 (右ペイン「秘匿の種類別件数」):
 * - 既存 secret_detected (bool) / secret_redaction_count (合算 int) を **kind 別**へ拡張する。
 *   kind は redactor のマーカー由来の安定 enum (github-token / aws-access-key-id 等)。
 * - 出所は NormalizedEvent.redaction_count_by_kind (sink の redactDeep 後 choke point で
 *   redacted ツリーを kind 別集計した **redacted な件数**。秘匿値そのものは一切載らない /
 *   INV-SECRET-DETECTED-NO-VALUE の kind 別版)。projection package
 *   (SessionProjection.secret_redaction_count_by_kind) が kind 別 merge fold し、
 *   ingest-store.upsertProjection が本列へ書く。
 * - 正直な整合 (QA-1/TDA-2): jsonb の値の総和 <= secret_redaction_count。by_kind は既知 kind に
 *   帰属した件数の部分集合・secret_redaction_count は全 [REDACTED:*] マーカー数。等号は全 event が
 *   by_kind を持ち全マーカーが既知 kind のときのみ。legacy/混在 event (count あり・by_kind 欠落) を
 *   畳むと sum < count になりうる (旧 `===` 主張は誇張だった)。
 *
 * 配置 (session_state):
 * - secret_detected / secret_redaction_count と同じく **projection 由来** (reducer の fold 結果)
 *   ゆえ、他の projection 列と同じ session_state に置く。realtime-store の JOIN_SELECT が ss.* を
 *   読み SessionDetail へ載る。
 *
 * 安全性 (database.md マイグレーション安全):
 * - 列「追加」のみ (削除・型変更なし) で前方/後方互換。**nullable・default なし** (secret_detected
 *   先例どおり)。旧行は NULL (= 未観測) のまま。`{}` で backfill すると「未観測」と「観測済み
 *   クリーン (kind なし)」が区別不能になるため NULL を保持する (readProjection が NULL→{} で
 *   fold 入力へ畳み、DTO 側 realtime-store が NULL→キー落とし=undefined で「未観測」を保つ)。
 * - up = addColumn / down = dropColumn (ロールバック可能・冪等)。CHECK なし・破壊操作なし。
 *
 * T1 整合: packages/projection/src/index.ts の SessionProjection.secret_redaction_count_by_kind
 *   (Record<string, number>) と packages/event-model の redaction_count_by_kind が本列の正典形。
 */
import type { ColumnDefinitions, MigrationBuilder } from "node-pg-migrate";

export const shorthands: ColumnDefinitions | undefined = undefined;

export async function up(pgm: MigrationBuilder): Promise<void> {
  // nullable・default なし。旧行は NULL (= 未観測) のまま。{} で backfill しない。
  pgm.addColumn("session_state", {
    secret_redaction_count_by_kind: {
      type: "jsonb",
      notNull: false,
    },
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropColumn("session_state", "secret_redaction_count_by_kind");
}
