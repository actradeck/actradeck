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
 * 宣言 (normalize) とゲート (approval-bridge) は **同一の bypass 集合** をこの単一出所から
 * 消費する — ただし評価時点は同一ではない (R5 SEC-R5-1≡TDA-R5-2 で訂正): 宣言は run 起点
 * (session.started) の 1 回・ゲートは操作ごと。run 途中で bypassPermissions へ切り替わった
 * session はゲートでは正しく操作単位で defer になる一方、start 時の enforcement 宣言は
 * 残る (指標側の over-report 方向として docs/usage-metrics.md に開示・demote は v0.8
 * follow-up task 019ffc38-92ac)。
 * ゲート側だけに bypass 扱いモードを足す変更は inv-governance-bypass-coupling の
 * **permission_mode トークン出現 allowlist** (file→件数の完全一致 pin・R4 SEC-R4-1 で
 * 比較形 regex から置換) と bridge 条件形 pin が RED にする。排他性の実担保 (R5 QA-R5-1 で
 * 訂正): 出現数 pin はコメント内出現も数えるため「件数保存の comment↔code swap」には
 * 可換であり、単体では第二ゲートを塞がない。実際に塞ぐのは (a) bridge の出現丁度 1
 * (コメント予算ゼロ) + 条件行 pin、(b) normalize 側の挙動テスト (bypassPermissions を
 * enforcement と宣言しない over-claim pin)。既知の限界: 動的プロパティ構成と件数保存 swap は
 * allowlist 単体では検知しない (comment-strip 集計化は full 監査対象の follow-up task
 * 019ffc38-b973)。
 */
export function governanceModeFor(mode: string | undefined): "unavailable" | "enforcement" {
  return isBypassPermissionMode(mode) ? "unavailable" : "enforcement";
}
