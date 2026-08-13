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
