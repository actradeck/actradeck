/**
 * headline backfill CLI: session_state の redaction 集計列を at-rest events から **ground truth** へ
 * 再導出する (コアロジックは ../audit-backfill.ts の `backfillRedactionCounts`)。
 *
 * ## なぜ必要か (実データ所見・decision 019f0405 / 019f0414)
 * session_state の running fold は ingest 時宣言値の積算で、feature ロールアウト過渡 (sidecar が by_kind を
 * 出す前 / backend が by_kind projection を持つ前に取り込んだイベント) で**歴史的に過少計上**する。一方
 * drill-down (audit 詳細の kind 別 → 個別イベント) は at-rest 実体からの再導出ゆえ ground truth。本 CLI は
 * headline を drill-down と同一走査・同一計数式で再導出し直し reconcile する。
 *
 * ## 使い方 (apps/backend から)
 *   dry-run (既定・読むだけ・差分提示):
 *     node --env-file-if-exists=../../.env --import tsx src/scripts/backfill-redaction-counts.ts
 *   1 session のみ:
 *     node ... src/scripts/backfill-redaction-counts.ts --session=<id>
 *   実適用 (live DB 更新・tx):
 *     node ... src/scripts/backfill-redaction-counts.ts --apply
 *   減少 (fold > at-rest) も適用 (既定は減少を適用しない):
 *     node ... src/scripts/backfill-redaction-counts.ts --apply --allow-decrease
 */
import { pathToFileURL } from "node:url";

import { Pool } from "pg";

import { backfillRedactionCounts } from "../audit-backfill.js";

/** CLI エントリ。 */
async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const allowDecrease = process.argv.includes("--allow-decrease");
  const sessionFlag = "--session=";
  const sessionId = process.argv.find((a) => a.startsWith(sessionFlag))?.slice(sessionFlag.length);

  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL is required (load via --env-file-if-exists=../../.env).");
    process.exitCode = 1;
    return;
  }
  const pool = new Pool({ connectionString: url });
  try {
    const result = await backfillRedactionCounts(pool, {
      apply,
      allowDecrease,
      ...(sessionId ? { sessionId } : {}),
    });
    const mode = apply ? (allowDecrease ? "APPLY (allow-decrease)" : "APPLY") : "dry-run";
    console.log(`[backfill] mode=${mode}${sessionId ? ` session=${sessionId}` : ""}`);
    console.log(`[backfill] rederived sessions: ${result.rederivedSessions}`);
    console.log(`[backfill] plan (rows to update): ${result.plan.length}`);
    console.log(
      `[backfill] orphan sessions (events w/ markers but no session_state row): ${result.orphans.length}`,
    );
    for (const o of result.orphans.slice(0, 20)) {
      console.log(
        `  [orphan] ${o.session_id}  rederived_scalar=${o.scalar}  (skipped: no session_state row)`,
      );
    }
    if (result.decreases.length > 0) {
      const note = allowDecrease ? "applied" : "NOT applied (use --allow-decrease)";
      console.log(
        `[backfill] WARNING: ${result.decreases.length} session(s) DECREASE (fold > at-rest; ${note}):`,
      );
      for (const d of result.decreases.slice(0, 20)) {
        console.log(
          `  [decrease] ${d.session_id}  scalar ${d.from.scalar}->${d.to.scalar}  byKindSum ${d.from.byKindSum}->${d.to.byKindSum}`,
        );
      }
    }
    const sorted = [...result.plan].sort((a, b) => b.to.scalar - a.to.scalar);
    for (const p of sorted.slice(0, 30)) {
      console.log(
        `  ${p.session_id}  scalar ${p.from.scalar}->${p.to.scalar}  byKindSum ${p.from.byKindSum}->${p.to.byKindSum}  detected ${p.from.detected}->${p.to.detected}`,
      );
    }
    if (result.plan.length > 30) console.log(`  ... and ${result.plan.length - 30} more`);
    const totalScalarDelta = result.plan.reduce((a, p) => a + (p.to.scalar - p.from.scalar), 0);
    const totalByKindDelta = result.plan.reduce(
      (a, p) => a + (p.to.byKindSum - p.from.byKindSum),
      0,
    );
    console.log(
      `[backfill] total scalar delta: ${totalScalarDelta >= 0 ? "+" : ""}${totalScalarDelta}`,
    );
    console.log(
      `[backfill] total by_kind delta: ${totalByKindDelta >= 0 ? "+" : ""}${totalByKindDelta}`,
    );
    if (apply) {
      console.log(`[backfill] applied. rows updated: ${result.applied}`);
    } else {
      console.log(`[backfill] dry-run only. re-run with --apply to write.`);
    }
  } finally {
    await pool.end();
  }
}

// エントリポイントとして起動された時のみ main を実行 (import 時は実行しない)。
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error("[backfill] failed:", e);
    process.exitCode = 1;
  });
}
