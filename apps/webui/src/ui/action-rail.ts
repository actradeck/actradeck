/**
 * Action Rail の **表示用** 派生 (純関数・状態と表示の分離)。
 *
 * 「いま人が対応すべきもの」を優先度順に導出する: pending 承認カード → stalled? →
 * waiting(auth/input) → generic needs_attention。既存の attention 派生
 * (needs_attention / stalled_suspected / waitingKind) と NO-RAW な allowlist フィールド
 * (repo/branch) **のみ** に依存し、新規の attention 判定を作らない (drift 防止・decision 019f69ef)。
 *
 * SEC: repoLabel は redacted DTO の allowlist フィールド (repo/branch) から組む。生 cwd や
 * command 本文は載せない (NO-RAW)。承認本文の表示は ApprovalCard の単一出所 (approvalPrimaryText)
 * に委譲し、本モジュールは envelope (どの session が要対応か) だけを扱う。
 */
import type { SessionApprovals, SessionListItem } from "../realtime/contract";

import { waitingKind } from "./liveness-display";

export type AttentionSignalKind = "approval" | "stalled" | "auth" | "input" | "attention";

/** 非承認の要対応シグナル 1 件 (承認カードを持たない waiting/stalled/attention の session)。 */
export interface AttentionSignal {
  readonly session_id: string;
  readonly kind: AttentionSignalKind;
  readonly provider: string;
  /** repo@branch (redacted allowlist フィールド由来)。生 cwd は載せない。 */
  readonly repoLabel: string | undefined;
}

/** repo@branch を補完した承認グループ (repo/branch は list item から join)。 */
export interface EnrichedApprovalGroup {
  readonly group: SessionApprovals;
  readonly repoLabel: string | undefined;
}

export interface DerivedAttention {
  readonly approvalGroups: readonly EnrichedApprovalGroup[];
  readonly signals: readonly AttentionSignal[];
  /** 対応すべき action の総数 (pending 承認件数 + 非承認シグナル数)。 */
  readonly total: number;
}

/**
 * repo@branch ラベル (repo 無しは undefined)。生 cwd は使わない
 * (NO-RAW: repo/branch は redacted DTO の allowlist フィールド)。
 */
export function repoBranchLabel(
  repo: string | undefined,
  branch: string | undefined,
): string | undefined {
  if (!repo) return undefined;
  return branch ? `${repo}@${branch}` : repo;
}

/** シグナル種別の表示優先度 (小さいほど上)。承認 > stalled > auth > input > generic。 */
const SIGNAL_ORDER: Record<AttentionSignalKind, number> = {
  approval: 0,
  stalled: 1,
  auth: 2,
  input: 3,
  attention: 4,
};

/**
 * 「いま人が対応すべきもの」を優先度順に導出する純関数。
 *
 * - `approvalGroups`: `/realtime/approvals` の pending 承認 (session ごと)。repo/branch を list item から join。
 * - `signals`: 承認カードを持たない要対応 session (stalled? / waiting.auth / waiting.input /
 *   waiting.approval / generic needs_attention)。承認グループに出た session は二重表示しないため除外。
 * - `total`: pending 承認件数 + signals 数 (= 対応すべき action の総数)。
 */
export function deriveAttention(
  sessions: readonly SessionListItem[],
  approvals: readonly SessionApprovals[],
): DerivedAttention {
  const byId = new Map(sessions.map((s) => [s.session_id, s] as const));
  const approvalIds = new Set(approvals.map((a) => a.session_id));

  const approvalGroups: EnrichedApprovalGroup[] = approvals.map((group) => {
    const s = byId.get(group.session_id);
    return { group, repoLabel: repoBranchLabel(s?.repo, s?.branch) };
  });

  const signals: AttentionSignal[] = [];
  for (const s of sessions) {
    if (approvalIds.has(s.session_id)) continue; // pending 承認カードで既に最上位表示
    const wk = waitingKind(s.state);
    let kind: AttentionSignalKind | null = null;
    if (wk === "approval") kind = "approval";
    else if (s.stalled_suspected) kind = "stalled";
    else if (wk === "auth") kind = "auth";
    else if (wk === "input") kind = "input";
    else if (s.needs_attention) kind = "attention";
    if (kind === null) continue;
    signals.push({
      session_id: s.session_id,
      kind,
      provider: s.provider,
      repoLabel: repoBranchLabel(s.repo, s.branch),
    });
  }
  signals.sort((a, b) => SIGNAL_ORDER[a.kind] - SIGNAL_ORDER[b.kind]);

  const pendingCount = approvalGroups.reduce((n, g) => n + g.group.pending_approvals.length, 0);
  return { approvalGroups, signals, total: pendingCount + signals.length };
}
