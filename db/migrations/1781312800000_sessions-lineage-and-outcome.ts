/**
 * Migration: run lineage 列 (sessions) + last_turn_outcome 列 (session_state) を追加する
 * (ADR 0014 Phase 3a・decision 019f8032・additive/非破壊)。
 *
 * 背景 (provider lifecycle fidelity + run lineage / decision 019f7d7c):
 * - ADR 0014 は「provider 会話 (provider_session_id) と観測 run (session_id) の分離」+ 直交軸を導入する。
 *   Phase 3a は **データモデルと backend 永続経路のみ**を additive に用意する段 (sidecar の distinct 採番は
 *   Phase 3b)。ゆえに現状イベントが載せる値 (= 大半 NULL) を非破壊に受ける。
 * - **Phase 1 で繰り延べた last_turn_outcome の永続化もここで着地** (TDA-2 解消): backend readProjection が
 *   `last_turn_outcome: undefined` 固定で live/replay 非対称だったのを、session_state 列 → readProjection
 *   復元で解消する (reducer は既に sticky 合成済ゆえ EXCLUDED 反映で正しい)。
 *
 * 追加列 (すべて nullable・default なし・CHECK なし):
 * - sessions.provider_session_id  : provider 発行 raw session id (run lineage 検索キー)。3b まで大半 NULL。
 * - sessions.start_kind           : run の開始種別 (T1 StartKind: fresh/resume/recovery/clear/unknown)。
 * - sessions.resumed_from_session_id : resume run が継続した元 session_id (lineage エッジ)。
 * - sessions.end_kind             : run の終了種別 (T1 EndKind: completed/failed/interrupted/unloaded/
 *                                   cleared/logout/other/unknown・"unloaded"=Codex unload/suspended)。
 * - sessions.recoverability       : 再開可能性 (T1 Recoverability=Continuation 再利用: resumable/
 *                                   not_resumable/unknown)。
 * - provider_session_id への index : lineage 検索用 (NULL 許容・NULL は index 対象外で無害)。
 * - session_state.last_turn_outcome : turn 結果 (T1 LastTurnOutcome)。recoverability の Continuation
 *                                   とは**別物の直交軸**であり同一視しない (値域も別: turn 結果は
 *                                   completed/failed/interrupted / Continuation は resumable/
 *                                   not_resumable/unknown)。reducer が sticky 合成した値を投影。
 *
 * sticky 方針 (ingest-store 側で適用・本 migration は列のみ):
 * - provider_session_id / start_kind / resumed_from_session_id = **first-wins** (started_at と同型・
 *   一度確定したら run の起点情報は変えない)。
 * - end_kind / recoverability = **last-non-null-wins** (permission_mode と同型・終了時に確定/更新)。
 * - last_turn_outcome = reducer 合成済を EXCLUDED で最新反映 (session_state)。
 *
 * 安全性 (database.md マイグレーション安全):
 * - 列「追加」のみ (削除・型変更なし) で前方/後方互換。既存行は NULL = 未指定。**CHECK 制約は付けない**
 *   (既存方針=前方互換・app 層 gate。読み出し時に event-model enum で closed-enum gate する)。
 * - up = addColumn + createIndex / down = 逆順 dropColumn (index は列 drop で自動消滅)。冪等・ロールバック可。
 *
 * T1 整合 (ドリフト時は T1 が勝つ):
 * - DB は TEXT 列、正典 enum は packages/event-model/src/state.ts:
 *     start_kind ↔ StartKind / end_kind ↔ EndKind / recoverability ↔ Recoverability (=Continuation) /
 *     last_turn_outcome ↔ LastTurnOutcome。
 *   packages/event-model/src/event.ts の同名 optional field が NormalizedEvent 側の正典形。
 */
import type { ColumnDefinitions, MigrationBuilder } from "node-pg-migrate";

export const shorthands: ColumnDefinitions | undefined = undefined;

export async function up(pgm: MigrationBuilder): Promise<void> {
  // run lineage 列 (sessions)。すべて nullable・default なし・CHECK なし (前方互換)。
  pgm.addColumn("sessions", {
    provider_session_id: { type: "text", notNull: false },
    start_kind: { type: "text", notNull: false },
    resumed_from_session_id: { type: "text", notNull: false },
    end_kind: { type: "text", notNull: false },
    recoverability: { type: "text", notNull: false },
  });
  // lineage 検索用 index (NULL 許容・NULL 行は index 対象外)。
  pgm.createIndex("sessions", "provider_session_id");

  // Phase 1 で繰り延べた last_turn_outcome の永続化 (TDA-2 解消)。
  pgm.addColumn("session_state", {
    last_turn_outcome: { type: "text", notNull: false },
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  // 逆順に dropColumn。sessions の index は provider_session_id 列 drop で自動消滅する。
  pgm.dropColumn("session_state", "last_turn_outcome");
  pgm.dropColumn("sessions", [
    "provider_session_id",
    "start_kind",
    "resumed_from_session_id",
    "end_kind",
    "recoverability",
  ]);
}
