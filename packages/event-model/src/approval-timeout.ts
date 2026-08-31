/**
 * approval-timeout — 承認待ち時間と agent 側フック timeout の **正準単一出所** (T1)。
 *
 * ## なぜ単一出所でなければならないか (fail-open の順序不変条件)
 * ActraDeck の承認ゲートは、CC の PreToolUse / PermissionRequest フック応答を**握り続ける**ことで
 * 成立している。Claude Code の契約は次のとおり (公式 docs `hooks`):
 *
 * > A timed-out `command`, `http`, or `mcp_tool` hook doesn't block the tool call.
 * > The call continues through the normal permission flow, so don't count on a stalled hook
 * > to act as a gate.
 *
 * つまり **フック timeout が先に発火すると、承認カードは deny ではなく「素通り」になる**
 * (通常の permission flow へ落ち、bypass/YOLO では実行される)。安全側 deny を保証する唯一の
 * 条件は「ActraDeck の承認待ちが、フック timeout より**厳密に**先に切れる」こと。
 *
 * 両者は別ファイルの別リテラルとして書かれていたため (approval-bridge の 30s と settings-merge の
 * 35s)、片方だけを編集すると**無言で fail-open へ反転する**。ここを単一出所にし、フック timeout は
 * 承認待ちから**導出**する。順序は `INV-APPROVAL-TIMEOUT-ORDERING` が回帰固定する。
 *
 * ## 値の根拠
 * - `DEFAULT_APPROVAL_TIMEOUT_MS` = 300s。操作者が席を外していても戻って対応できる長さ。
 *   無人時は満了で**安全側 deny** になるため、伸ばすほど「エージェントが止まる最大時間」が伸びる
 *   というトレードオフを持つ (安全性は下がらない・可用性が下がる)。
 * - `APPROVAL_HOOK_MARGIN_MS` = 30s。承認解決の emit → relay → 応答書き込みが満了直前に走った
 *   場合でも、フック timeout より先に決着させるための余裕。
 * - `MAX_APPROVAL_TIMEOUT_MS` = 570s。CC の `http` フック既定 timeout は **600s** で、docs に上限の
 *   記載は無い。導出後のフック timeout が 600s を超えない範囲に承認待ちを制限する
 *   (600s は「既定として安全に使える」ことが分かっている唯一の上限であり、それ以上は未検証)。
 *
 * ## 適用範囲の正直な開示
 * この導出が守るのは **Claude Code の hook 経路**である。managed Codex は承認を JSON-RPC の
 * inbound server-request として受けるため、codex 側が応答をどれだけ待つかは ActraDeck の設定では
 * 決まらない (`ACTRADECK_CODEX_RPC_TIMEOUT_MS` は ActraDeck からの **outbound** 要求用でこの経路に
 * 掛からない)。Codex rollout tail は observe-only でそもそもブロックしない。
 */

/** 承認待ちの既定 (ms)。満了は**安全側 deny**。 */
export const DEFAULT_APPROVAL_TIMEOUT_MS = 300_000;

/** 承認待ち満了とフック timeout の間に置く余裕 (ms)。解決の relay/書き込み分。 */
export const APPROVAL_HOOK_MARGIN_MS = 30_000;

/**
 * 承認待ちの上限 (ms)。導出フック timeout が CC の `http` 既定 600s を超えない範囲。
 * これを超える値は「未検証の領域でゲートが素通りに反転しうる」ため受け付けない。
 *
 * **現行 production では到達しない (QA-V9R2-4・sweep 019fd74b)**: 出荷経路の入口は
 * `effectiveApprovalTimeoutMs`（実効値を `DEFAULT_APPROVAL_TIMEOUT_MS` = 300s で頭打ちにする）と
 * `hookTimeoutSecondsFor(DEFAULT_APPROVAL_TIMEOUT_MS)`（引数が既定そのもの）の 2 つだけなので、
 * この上限が実際に切り詰めるケースは今のところ無い。守っているのは**既定を昇格させたときの上界**
 * であり、`DEFAULT_APPROVAL_TIMEOUT_MS` を 600s 超へ引き上げる編集がここで頭打ちになる
 * (= フック timeout が CC の既定 600s を超えて未検証域に入るのを防ぐ) ためのガードとして残す。
 * 「今どこからも効いていない」ことは削除の理由にならない — 削除するとその昇格経路が無防備になる。
 */
export const MAX_APPROVAL_TIMEOUT_MS = 570_000;

/**
 * 承認待ちの下限 (ms)。1ms = 「正の有限値」の床であり運用値ではない (TDA-V9-6)。テストは自前で
 * 数十 ms を渡す。非正・非有限は `clampApprovalTimeoutMs` が既定へ倒す。
 */
export const MIN_APPROVAL_TIMEOUT_MS = 1;

/**
 * 承認待ち (ms) から agent 側フック timeout (**秒**) を導出する。
 *
 * CC の settings スキーマは秒単位の整数を取るため、切り上げてから返す。切り上げにより
 * 導出値は常に `approvalTimeoutMs + APPROVAL_HOOK_MARGIN_MS` 以上 = 順序が保たれる。
 */
export function hookTimeoutSecondsFor(approvalTimeoutMs: number): number {
  const clamped = clampApprovalTimeoutMs(approvalTimeoutMs);
  return Math.ceil((clamped + APPROVAL_HOOK_MARGIN_MS) / 1000);
}

/**
 * 承認待ち (ms) を有効域へ丸める。非有限・非正・上限超過は**安全側**へ倒す
 * (上限超過は上限へ・不正値は既定へ)。silent に無界化させない。
 *
 * **どの枝が現行 production で効くか (QA-V9R2-4・sweep 019fd74b)**: 実際に呼ばれるのは
 * `hookTimeoutSecondsFor` と `effectiveApprovalTimeoutMs` からで、引数は既定 (300s) か
 * operator 供給の `timeoutMs` に限られる。`Math.min(…, MAX_APPROVAL_TIMEOUT_MS)` は operator
 * 供給経路で毎回**実行される**が、**現行では実効値を変えない** (QA-DE-2) —
 * `effectiveApprovalTimeoutMs` が実効値を既定で頭打ちにするため。上限が実際に切り詰めるのは
 * 既定を 600s 超へ昇格させたときで、この関数はその昇格経路の上界ガードとして残っている。
 * 不正値 → 既定の枝は通常経路でも生きている (operator 供給値の fail-safe)。
 */
export function clampApprovalTimeoutMs(approvalTimeoutMs: number): number {
  if (!Number.isFinite(approvalTimeoutMs) || approvalTimeoutMs < MIN_APPROVAL_TIMEOUT_MS) {
    return DEFAULT_APPROVAL_TIMEOUT_MS;
  }
  return Math.min(approvalTimeoutMs, MAX_APPROVAL_TIMEOUT_MS);
}

/**
 * bridge が **実際に待つ**承認待ち (ms) を、要求値 (operator 供給・省略可) から決める
 * (SEC-V9-1 ≡ TDA-V9-1 ≡ QA-V9-2)。
 *
 * agent 側フック timeout は `hookTimeoutSecondsFor(DEFAULT_APPROVAL_TIMEOUT_MS)` = 既定から
 * **静的に**導出されて settings に書き込まれる (bridge の実効値を知らない)。したがって順序
 * 不変条件を要求値によらず保つには、実効値が **既定を超えない**ことが必要十分:
 *   effective ≤ DEFAULT < DEFAULT + MARGIN ≤ hook timeout。
 * 要求値は「既定より短くする」方向にのみ効く。伸ばしたければ単一出所
 * `DEFAULT_APPROVAL_TIMEOUT_MS` を変える (フック側が自動追従する唯一の経路)。
 * 不正値 (非有限・非正) は既定へ (clamp と同じ fail-safe)。
 */
export function effectiveApprovalTimeoutMs(requestedMs: number | undefined): number {
  if (requestedMs === undefined) return DEFAULT_APPROVAL_TIMEOUT_MS;
  return Math.min(clampApprovalTimeoutMs(requestedMs), DEFAULT_APPROVAL_TIMEOUT_MS);
}
