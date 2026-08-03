/**
 * INV-CODEX-PLAN-A2 (ADR 0015 evidence-based completion・P0-A slice A2)。
 *
 * 実 rollout の plan シグナルは `update_plan` function_call (response_item wrapped)。fixture は
 * 実データ形状 (payload.type="function_call", name="update_plan", arguments=JSON 文字列 →
 * {"plan":[{"step","status"}]}, status ∈ {completed,pending,in_progress}) に厳密準拠する。
 *
 * 受入 (ADR 0015 Acceptance tests):
 *  - 受入3: 実 rollout 形の update_plan → `turn.plan.updated` (typed items) で、**command.started に
 *    ならない** (generic function_call 誤ルートの構造的排除)。parse 失敗は items 欠落・それでも
 *    command.started へは落とさない。対応する function_call_output ("Plan updated" ack) は
 *    check_kind を持たず fold の検証束縛へ入らない (command.completed へ誤対応しない)。
 *  - 受入2: 同一 rollout 行を re-tail → 同一 event id。normalizer→fold で dup work item を作らない。
 *  - 受入4: managed `turn/plan/updated` の per-step status を items へ保持・legacy steps 不変。
 *  - end-to-end: normalizer 出力を reduceWorkItems (A1 fold) へ流し plan-scheme item が成立する。
 */
import { describe, expect, it } from "vitest";

import { deriveWorkItemId, type NormalizedEvent } from "@actradeck/event-model";
import { reduceWorkItems as foldWorkItems } from "@actradeck/projection";

import { normalizeCodexNotification, type CodexNormalizeContext } from "../src/normalize-codex.js";
import {
  normalizeRolloutLine,
  type CodexRolloutLine,
  type CodexRolloutNormalizeContext,
} from "../src/normalize-codex-rollout.js";

const SID = "019a7bfb-9f7d-7bc3-b4a8-95fce7c4dbc4";
const SOURCE = `rollout-2025-11-13T15-51-19-${SID}.jsonl`;

/** 実 rollout 形の wrapped update_plan 行を組む。arguments は実データ同様 JSON **文字列**。 */
function updatePlanLine(
  plan: Array<{ step: string; status: string }>,
  opts: { explanation?: string; callId?: string; rawArgs?: string } = {},
): CodexRolloutLine {
  const args =
    opts.rawArgs ??
    JSON.stringify({ ...(opts.explanation ? { explanation: opts.explanation } : {}), plan });
  return {
    type: "response_item",
    timestamp: "2025-11-13T06:52:03.098Z",
    payload: {
      type: "function_call",
      name: "update_plan",
      arguments: args,
      call_id: opts.callId ?? "call_gti7MCW0ZvekFZzDurNU7Q9t",
    },
  } as CodexRolloutLine;
}

function rolloutCtx(byteOffset: number): CodexRolloutNormalizeContext {
  return { sessionId: SID, byteOffset, sourcePath: SOURCE };
}

describe("受入3: rollout update_plan → turn.plan.updated (NOT command.started)", () => {
  it("real-shaped update_plan emits one turn.plan.updated with typed items, never command.started", () => {
    const line = updatePlanLine(
      [
        { step: "Locate Discovery scan implementation", status: "in_progress" },
        { step: "Compare Quick vs DeepScan logic", status: "pending" },
        { step: "Write findings", status: "completed" },
      ],
      { explanation: "Investigate zero counts" },
    );
    const evs = normalizeRolloutLine(line, rolloutCtx(1000));

    expect(evs.length).toBe(1);
    const ev = evs[0]!;
    expect(ev.event_type).toBe("turn.plan.updated");
    expect(ev.state).toBe("running.planning");
    // 構造的排除: どの候補も command.started にならない。
    expect(evs.some((e) => e.event_type === "command.started")).toBe(false);

    const payload = ev.payload as {
      plan?: string;
      steps?: string[];
      items?: Array<{ step: string; status: string }>;
    };
    expect(payload.plan).toBe("Investigate zero counts"); // legacy `plan` = explanation。
    expect(payload.steps).toEqual([
      "Locate Discovery scan implementation",
      "Compare Quick vs DeepScan logic",
      "Write findings",
    ]);
    expect(payload.items).toEqual([
      { step: "Locate Discovery scan implementation", status: "in_progress" },
      { step: "Compare Quick vs DeepScan logic", status: "pending" },
      { step: "Write findings", status: "completed" },
    ]);
  });

  it("unknown status value gates to 'unknown' (closed-enum・forward-compat)", () => {
    const line = updatePlanLine([{ step: "s1", status: "blocked" }]);
    const ev = normalizeRolloutLine(line, rolloutCtx(0))[0]!;
    const items = (ev.payload as { items?: Array<{ status: string }> }).items;
    expect(items?.[0]?.status).toBe("unknown");
  });

  it("parse-fail arguments → items absent, still turn.plan.updated (never command.started)", () => {
    const line = updatePlanLine([], { rawArgs: "this is not json {" });
    const evs = normalizeRolloutLine(line, rolloutCtx(0));
    expect(evs.length).toBe(1);
    expect(evs[0]!.event_type).toBe("turn.plan.updated");
    expect((evs[0]!.payload as { items?: unknown }).items).toBeUndefined();
    expect(evs.some((e) => e.event_type === "command.started")).toBe(false);
  });

  it("update_plan 'Plan updated' ack (function_call_output) carries no check_kind → no verification binding", () => {
    // 実データの update_plan 応答は output="Plan updated" (JSON でない・metadata/exit_code 無し)。
    //   現行の function_call_output 写像で command.completed になるが check_kind を持たないため、
    //   A1 fold (applyCommandCompleted) は check_kind undefined で skip し work item を一切触らない。
    const ackLine: CodexRolloutLine = {
      type: "response_item",
      timestamp: "2025-11-13T06:52:04.000Z",
      payload: { type: "function_call_output", call_id: "call_x", output: "Plan updated" },
    } as CodexRolloutLine;
    const evs = normalizeRolloutLine(ackLine, rolloutCtx(2000));
    // command.completed になっても check_kind を持たない。
    for (const e of evs) {
      expect((e.payload as { check_kind?: unknown }).check_kind).toBeUndefined();
    }
    // fold へ流しても work item ゼロ (検証束縛へ誤対応しない)。
    const proj = foldWorkItems(SID, evs as NormalizedEvent[]);
    expect(proj.items.length).toBe(0);
  });
});

describe("受入2: re-tail 同一 event id + fold で dup item なし", () => {
  it("re-tailing same rollout line at same offset re-emits identical event id", () => {
    const line = updatePlanLine([{ step: "s1", status: "pending" }]);
    const first = normalizeRolloutLine(line, rolloutCtx(4096))[0]!;
    const second = normalizeRolloutLine(line, rolloutCtx(4096))[0]!;
    expect(second.event_id).toBe(first.event_id);
  });

  it("two snapshots on stable step text → one item per step (status flips, no duplicates)", () => {
    const s1 = normalizeRolloutLine(
      updatePlanLine([
        { step: "step A", status: "pending" },
        { step: "step B", status: "pending" },
      ]),
      rolloutCtx(100),
    );
    const s2 = normalizeRolloutLine(
      updatePlanLine([
        { step: "step A", status: "completed" },
        { step: "step B", status: "in_progress" },
      ]),
      rolloutCtx(200),
    );
    const proj = foldWorkItems(SID, [...s1, ...s2] as NormalizedEvent[]);
    // 2 distinct steps → 2 items (dup なし)。status は最新 snapshot 勝ち。
    expect(proj.items.length).toBe(2);
    const byId = new Map(proj.items.map((it) => [it.work_item_id, it]));
    expect(byId.get(deriveWorkItemId("plan", "step A"))?.status).toBe("completed");
    expect(byId.get(deriveWorkItemId("plan", "step B"))?.status).toBe("in_progress");
  });

  it("feeding the identical snapshot twice (re-tail without dedup) is idempotent in the fold", () => {
    const snap = normalizeRolloutLine(
      updatePlanLine([{ step: "only", status: "completed" }]),
      rolloutCtx(300),
    );
    const once = foldWorkItems(SID, snap as NormalizedEvent[]);
    const twice = foldWorkItems(SID, [...snap, ...snap] as NormalizedEvent[]);
    expect(once.items.length).toBe(1);
    expect(twice.items.length).toBe(1); // 同一 content-hash id → collapse (no dup)。
    expect(twice.items[0]!.status).toBe("completed");
  });
});

describe("受入4: managed turn/plan/updated は per-step status を items へ保持・legacy steps 不変", () => {
  const CTX: CodexNormalizeContext = { sessionId: "T-managed", providerSessionId: "T-managed" };

  it("preserves per-step status in items; legacy steps unchanged", () => {
    const evs = normalizeCodexNotification(
      {
        method: "turn/plan/updated",
        params: {
          threadId: "T1",
          turnId: "turn_1",
          explanation: "do X then Y",
          plan: [
            { step: "step a", status: "completed" },
            { step: "step b", status: "in_progress" },
          ],
        },
      },
      CTX,
    );
    expect(evs.length).toBe(1);
    const payload = evs[0]!.payload as {
      plan?: string;
      steps?: string[];
      items?: Array<{ step: string; status: string }>;
    };
    // legacy steps は step 文字列のみで不変。
    expect(payload.steps).toEqual(["step a", "step b"]);
    // items が per-step status を保持 (gap (a) 修正)。
    expect(payload.items).toEqual([
      { step: "step a", status: "completed" },
      { step: "step b", status: "in_progress" },
    ]);
  });

  it("managed + rollout の plan id は同一 step text で一致 (content-hash・provider 非依存)", () => {
    const managed = normalizeCodexNotification(
      {
        method: "turn/plan/updated",
        params: { threadId: "T1", plan: [{ step: "shared step", status: "completed" }] },
      },
      CTX,
    );
    const mProj = foldWorkItems("T1", managed as NormalizedEvent[]);
    expect(mProj.items[0]!.work_item_id).toBe(deriveWorkItemId("plan", "shared step"));
    expect(mProj.items[0]!.status).toBe("completed");
  });
});
