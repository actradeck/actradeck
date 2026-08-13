/**
 * "bypassPermissions" 判定の単一出所 (SEC-R2-2・2026-08-13 監査 R2)。
 *
 * governance_mode 宣言 (normalize.ts: session.started に enforcement/unavailable を載せる) と
 * bypass 承認ゲート (approval-bridge.ts: policy 駆動 gate / defer 分岐) は、必ずこの述語を
 * 共有する。独立リテラルの二重記述だと、bridge 側だけに bypass 扱いのモードを追加したとき
 * normalizer が「enforcement (Protected)」を虚偽宣言し `governed_session_started` を過大計上する
 * (SEC-5 と同一の gate↔宣言 decoupling 故障クラス)。
 * inv-governance-bypass-coupling.test.ts がリテラル単一出所 + 両消費サイトを回帰固定する。
 */
export const BYPASS_PERMISSION_MODE = "bypassPermissions";

/** CC permission_mode が承認ゲートを実行パスから外す bypass モードか。 */
export function isBypassPermissionMode(mode: string | undefined): boolean {
  return mode === BYPASS_PERMISSION_MODE;
}

/**
 * session.started に載せる governance_mode の宣言を permission_mode から導出する (SEC-R3-1)。
 * 宣言 (normalize) とゲート (approval-bridge) が **同一 predicate の同一評価** から分岐する
 * ことをこの関数が構造的に保証する — 宣言側がこの関数を、ゲート側が isBypassPermissionMode を
 * 消費し、両者の bypass 集合は定義上一致する。ゲート側だけに bypass 扱いモードを足す変更は
 * inv-governance-bypass-coupling の排他 assert (permission_mode の値比較は本モジュール外に
 * 存在しない + bridge 条件形 pin) が RED にする。
 */
export function governanceModeFor(mode: string | undefined): "unavailable" | "enforcement" {
  return isBypassPermissionMode(mode) ? "unavailable" : "enforcement";
}
