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
 * session は、ゲートでは操作単位で正しく bypass 経路へ分岐する (既定は DEFAULT_GATED
 * カテゴリ該当で Web UI 承認カード経路・非該当のみ defer — R5T TDA-R5T-4 で訂正) 一方、
 * start 時の enforcement 宣言は残る (指標側の over-report 方向として docs/usage-metrics.md
 * に開示・demote は v0.8 follow-up task 019ffc38-92ac)。
 * ゲート側だけに bypass 扱いモードを足す変更を実際に討ち取るのは inv-approval.test.ts の
 * gate 側 mode 列挙テスト (bypass 集合の挙動 pin) であり、その列挙は現行 CC の closed set
 * に閉じている — **未列挙の将来 mode を使う第二ゲートはどのテストにも当たらない** (R5T
 * QA-R5T-1 で probe 実証・構造閉塞は follow-up task 019ffc38-b973)。
 * inv-governance-bypass-coupling の permission_mode 出現 allowlist は**純増方向のみ**の
 * tripwire で、コメント予算を使う件数保存 comment↔code swap には可換 (同 test docstring
 * 参照)。既知の限界: 動的プロパティ構成・件数保存 swap・未列挙 mode は本モジュール周辺の
 * ガード群単体では検知しない。
 */
export function governanceModeFor(mode: string | undefined): "unavailable" | "enforcement" {
  return isBypassPermissionMode(mode) ? "unavailable" : "enforcement";
}
