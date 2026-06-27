/**
 * headline backfill コア (decision 019f0405 / 019f0414)。session_state の redaction 集計 3 列
 * (secret_redaction_count / secret_redaction_count_by_kind / secret_detected) を **at-rest events から
 * ground truth として再導出**し reconcile する純ロジック。CLI ラッパは scripts/backfill-redaction-counts.ts。
 *
 * 走査・計数は drill-down (AuditStore.redactionOccurrences) と**同一の `markerCountExpr` + 同一の
 * `to_jsonb(events.*)::text` ドメイン**に帰着する (AuditStore.rederiveRedactionCounts)。これにより
 * headline == drill-down == ground truth をコード構造で保証する。
 *
 * ## 安全性
 * - **append-only 維持**: events は不可触 (再導出は read-only)。
 * - **additive 投影列のみ**: 3 列のみ UPDATE。state / liveness / pending_approvals / current_action* 不触。
 * - **既存行のみ更新**: session_state 行が無い session には INSERT しない (orphan は報告のみ)。
 * - **冪等**: 値が現状と一致する session は plan から除外 → 全 backfill 後の再実行は 0 行更新。
 * - **secret_detected は単調 (monotonic)**: `cur.secret_detected || scalar > 0`。一度立った検出フラグを
 *   backfill が **false へ降格しない** (projection fold の OR 意味論と一致・セキュリティ信号の安全側)。
 * - **減少は opt-in (`allowDecrease`)**: at-rest が現 fold より小さい session (= 宣言ありマーカーなしの
 *   crafted/legacy。実データでは 0 件) は既定では plan から除外し報告のみ。明示 opt-in 時のみ適用する
 *   (無警告のカウント降格を防ぐ・TDA-1)。
 * - **NO-RAW**: 件数 (非負整数) と closed-enum kind のみ (rederiveRedactionCounts が gate 済)。
 */
import { Pool } from "pg";

import { AuditStore, type RederivedRedactionCounts } from "./audit-store.js";

interface CurrentRow {
  secret_redaction_count: number;
  secret_redaction_count_by_kind: Record<string, number>;
  secret_detected: boolean;
}

/** by_kind を canonical (key ソート) JSON 化して等値比較する。 */
function canonicalByKind(bk: Record<string, number>): string {
  const keys = Object.keys(bk).sort();
  return JSON.stringify(keys.map((k) => [k, bk[k]]));
}

function sumValues(bk: Record<string, number>): number {
  return Object.values(bk).reduce((a, b) => a + b, 0);
}

export interface BackfillPlanEntry {
  readonly session_id: string;
  readonly from: { scalar: number; byKindSum: number; detected: boolean };
  readonly to: {
    scalar: number;
    byKind: Record<string, number>;
    byKindSum: number;
    detected: boolean;
  };
}

export interface BackfillResult {
  /** events を持つ (= 再導出対象の) session 数。 */
  readonly rederivedSessions: number;
  /** 適用予定の計画 (冪等: 一致は含めない / 減少は allowDecrease 時のみ含む)。 */
  readonly plan: readonly BackfillPlanEntry[];
  /** events にマーカーがあるが session_state 行が無い session (更新せず報告のみ)。 */
  readonly orphans: readonly RederivedRedactionCounts[];
  /** fold > at-rest で減少する session (allowDecrease=false では plan 除外・報告のみ)。 */
  readonly decreases: readonly BackfillPlanEntry[];
  /** apply 時に実際に UPDATE された行数 (dry-run は 0)。 */
  readonly applied: number;
}

export interface BackfillOptions {
  /** true で実 UPDATE (既定 false = dry-run・write しない)。 */
  readonly apply?: boolean;
  /** 指定時はその 1 session のみ (テスト / 部分 backfill)。 */
  readonly sessionId?: string;
  /** true で減少 (fold > at-rest) も適用する (既定 false = 減少は報告のみで適用しない)。 */
  readonly allowDecrease?: boolean;
}

/**
 * session_state の redaction 集計を at-rest から再導出して reconcile する。`apply=false` (既定) は
 * 計画のみ算出 (write しない)。`apply=true` は plan の各 session の 3 列を単一 tx で targeted UPDATE。
 * **read-only な再導出 (AuditStore) + 既存行のみの targeted UPDATE** で append-only を維持する。
 */
export async function backfillRedactionCounts(
  pool: Pool,
  opts: BackfillOptions = {},
): Promise<BackfillResult> {
  const apply = opts.apply ?? false;
  const allowDecrease = opts.allowDecrease ?? false;
  const store = new AuditStore(pool);
  const rederived = await store.rederiveRedactionCounts(
    opts.sessionId ? { sessionId: opts.sessionId } : undefined,
  );

  // 現状の session_state 値を 1 往復で取得 (再導出対象の session に限定)。
  const ids = rederived.map((r) => r.session_id);
  const currentById = new Map<string, CurrentRow>();
  if (ids.length > 0) {
    const { rows } = await pool.query<{
      session_id: string;
      secret_redaction_count: number | null;
      secret_redaction_count_by_kind: unknown;
      secret_detected: boolean | null;
    }>(
      `SELECT session_id, secret_redaction_count, secret_redaction_count_by_kind, secret_detected
         FROM session_state
        WHERE session_id = ANY($1::text[])`,
      [ids],
    );
    for (const r of rows) {
      const bk =
        r.secret_redaction_count_by_kind &&
        typeof r.secret_redaction_count_by_kind === "object" &&
        !Array.isArray(r.secret_redaction_count_by_kind)
          ? (r.secret_redaction_count_by_kind as Record<string, number>)
          : {};
      currentById.set(r.session_id, {
        secret_redaction_count:
          typeof r.secret_redaction_count === "number" ? r.secret_redaction_count : 0,
        secret_redaction_count_by_kind: bk,
        secret_detected: r.secret_detected === true,
      });
    }
  }

  const plan: BackfillPlanEntry[] = [];
  const orphans: RederivedRedactionCounts[] = [];
  const decreases: BackfillPlanEntry[] = [];
  for (const r of rederived) {
    const cur = currentById.get(r.session_id);
    if (cur === undefined) {
      if (r.scalar > 0) orphans.push(r); // events にマーカーあるが session_state 行なし。
      continue; // 既存行のみ更新 (INSERT しない)。
    }
    // secret_detected は単調: 一度立ったら降格しない (fold の OR 意味論と一致・安全側)。
    const toDetected = cur.secret_detected || r.scalar > 0;
    const fromByKindSum = sumValues(cur.secret_redaction_count_by_kind);
    const toByKindSum = sumValues(r.byKind);
    const entry: BackfillPlanEntry = {
      session_id: r.session_id,
      from: {
        scalar: cur.secret_redaction_count,
        byKindSum: fromByKindSum,
        detected: cur.secret_detected,
      },
      to: { scalar: r.scalar, byKind: r.byKind, byKindSum: toByKindSum, detected: toDetected },
    };
    const changed =
      cur.secret_redaction_count !== r.scalar ||
      cur.secret_detected !== toDetected ||
      canonicalByKind(cur.secret_redaction_count_by_kind) !== canonicalByKind(r.byKind);
    if (!changed) continue; // 冪等: 一致は skip。
    const decreasing = r.scalar < cur.secret_redaction_count || toByKindSum < fromByKindSum;
    if (decreasing) {
      decreases.push(entry);
      if (!allowDecrease) continue; // 既定: 減少は適用しない (無警告のカウント降格を防ぐ)。
    }
    plan.push(entry);
  }

  if (!apply || plan.length === 0) {
    return { rederivedSessions: rederived.length, plan, orphans, decreases, applied: 0 };
  }

  // 適用: 単一 tx で 3 列のみ targeted UPDATE。
  const client = await pool.connect();
  let applied = 0;
  try {
    await client.query("BEGIN");
    for (const p of plan) {
      const res = await client.query(
        `UPDATE session_state
            SET secret_redaction_count = $2,
                secret_redaction_count_by_kind = $3::jsonb,
                secret_detected = $4,
                updated_at = now()
          WHERE session_id = $1`,
        [p.session_id, p.to.scalar, JSON.stringify(p.to.byKind), p.to.detected],
      );
      applied += res.rowCount ?? 0;
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
  return { rederivedSessions: rederived.length, plan, orphans, decreases, applied };
}
