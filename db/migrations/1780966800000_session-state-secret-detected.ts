/**
 * Migration: session_state に secret_detected (boolean) + secret_redaction_count (integer) 列を
 * 追加する (ADR 019ea4ba 段階2 / 右ペイン secret_detected の session 単位投影)。
 *
 * 背景 (右ペイン「このセッションで秘匿が検出されたか」):
 * - これまでの secret_detected は diff pull 由来 (その diff 限定) のみだった。本列は session 内で
 *   一度でも redaction が秘匿を潰したか (bool) と累積件数 (int) を**永続投影**する。
 * - 出所は NormalizedEvent.redaction_count (sink の redactDeep 後 choke point で件数化した
 *   **redacted な数値**。秘匿値そのものは一切載らない / INV-SECRET-DETECTED-NO-VALUE)。
 *   projection package (SessionProjection.secret_detected / secret_redaction_count) が bool OR /
 *   合算で畳み、ingest-store.upsertProjection が本列へ書く。
 *
 * 配置の差 (sessions ではなく session_state):
 * - permission_mode は hook 入力由来ゆえ `sessions` 行 (event のメタ) に投影した。
 * - secret_detected は **projection 由来** (reducer の fold 結果) ゆえ、他の projection 列
 *   (state / current_action / needs_attention / pending_approvals 等) と同じ `session_state` に置く。
 *   realtime-store の JOIN_SELECT は ss.* を読むため SessionDetail へそのまま載る。
 *
 * 安全性 (database.md マイグレーション安全):
 * - 列「追加」のみ (削除・型変更なし) で前方/後方互換。**nullable・default なし** (permission_mode
 *   先例どおり)。QA-1: notNull+default false/0 で既存行を backfill すると「未観測」と「観測済み
 *   クリーン (false/0)」が区別不能になり、旧行に**誤った安心**を与える。NULL のまま残し
 *   「未観測」を本番到達可能な状態として保持する (readProjection が NULL→undefined で復元し、
 *   active session は initialProjection 経由で必ず観測値 false/0 or true/N を持つ)。CHECK なし。
 * - up = addColumn / down = dropColumn (ロールバック可能・冪等)。
 *
 * Replay 契約 (TDA-2): secret_redaction_count / secret_detected は **session_state (増分投影) が
 *   唯一の権威**。events 列に redaction_count は永続しないため、events からの rebuild では count を
 *   再現できない (本列の値が真実)。
 *
 * T1 整合: packages/projection/src/index.ts の SessionProjection.secret_detected (boolean) /
 *   secret_redaction_count (number) と packages/event-model の redaction_count が本列の正典形。
 */
import type { ColumnDefinitions, MigrationBuilder } from "node-pg-migrate";

export const shorthands: ColumnDefinitions | undefined = undefined;

export async function up(pgm: MigrationBuilder): Promise<void> {
  // QA-1: nullable・default なし。旧行は NULL (= 未観測) のまま。false/0 で backfill しない。
  pgm.addColumn("session_state", {
    secret_detected: {
      type: "boolean",
      notNull: false,
    },
    secret_redaction_count: {
      type: "integer",
      notNull: false,
    },
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropColumn("session_state", "secret_detected");
  pgm.dropColumn("session_state", "secret_redaction_count");
}
