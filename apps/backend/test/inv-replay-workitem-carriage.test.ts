/**
 * INV-REPLAY-WORKITEM-CARRIAGE (ADR 0015 §D4/§D8・純ユニット・PG 不要).
 *
 * `rowToReplayEvent` の work-items carriage 写像を固定する (webui client-side fold の入力源):
 *  - work.item.updated / command.* / diff.updated の carriage フィールドが DTO へ載る。
 *  - **NO-RAW**: plan_items は {step, status} だけへ再射影し、余剰フィールド (secret 様) を落とす。
 *  - work_item_subject / plan step は post-floor 有界化 (boundTurnSummary・redact→bound 順)。
 *  - carriage フィールドが無い row では当該キーを **落とす** (additive optional・wire 非搬送)。
 *
 * SQL 側の event_type ゲート (work.item.updated 限定投影) と claimed_unverified_count 集約は実 PG の
 * inv-work-items-wiring.test.ts で固定する (本純テストは JS 側の写像/再射影/有界化を担う)。
 */
import { describe, expect, it } from "vitest";

import { rowToReplayEvent } from "../src/replay-store.js";

// EventRow は非 export の内部型ゆえ、必要フィールドを持つ最小 row を any で組む (mapper の入力形)。
type Row = Parameters<typeof rowToReplayEvent>[0];

function row(o: Partial<Row> & { event_type: string }): Row {
  const base: Record<string, unknown> = {
    event_id: "00000000-0000-7000-8000-000000000001",
    provider: "claude_code",
    source: "hooks",
    session_id: "s1",
    event_type: o.event_type,
    state: null,
    timestamp: new Date("2026-08-04T00:00:01.000Z"),
    cwd: null,
    summary: null,
    request_id: null,
    tool_name: null,
    command: null,
    path: null,
    server: null,
    tool: null,
    query: null,
    reason: null,
    error: null,
    prompt_summary: null,
    response_summary: null,
    risk_level: null,
    decision: null,
    auto_allowed: null,
    exit_code: null,
    elapsed_ms: null,
    provider_task_id: null,
    work_item_status: null,
    work_item_subject: null,
    observation_method: null,
    observation_fidelity: null,
    check_kind: null,
    check_match: null,
    head_sha: null,
    diff_hash: null,
    plan_items: null,
  };
  return { ...base, ...o } as Row;
}

describe("rowToReplayEvent work-items carriage", () => {
  it("work.item.updated: provider_task_id / status / subject / observation を載せる", () => {
    const dto = rowToReplayEvent(
      row({
        event_type: "work.item.updated",
        provider_task_id: "1",
        work_item_status: "completed",
        work_item_subject: "wire up parser",
        observation_method: "official_hook",
        observation_fidelity: "observed",
      }),
    );
    expect(dto.provider_task_id).toBe("1");
    expect(dto.work_item_status).toBe("completed");
    expect(dto.work_item_subject).toBe("wire up parser");
    expect(dto.observation_method).toBe("official_hook");
    expect(dto.observation_fidelity).toBe("observed");
  });

  it("command.completed: check_kind / check_match を載せる", () => {
    const dto = rowToReplayEvent(
      row({ event_type: "command.completed", check_kind: "test", check_match: "program" }),
    );
    expect(dto.check_kind).toBe("test");
    expect(dto.check_match).toBe("program");
  });

  it("diff.updated: head_sha / diff_hash を載せる", () => {
    const dto = rowToReplayEvent(
      row({ event_type: "diff.updated", head_sha: "abc123", diff_hash: "def456" }),
    );
    expect(dto.head_sha).toBe("abc123");
    expect(dto.diff_hash).toBe("def456");
  });

  it("NO-RAW: plan_items は {step,status} だけへ再射影し余剰 (secret 様) を落とす", () => {
    const dto = rowToReplayEvent(
      row({
        event_type: "turn.plan.updated",
        plan_items: [
          { step: "ship it", status: "completed", secret: "AKIAIOSFODNN7EXAMPLE", note: "x" },
          { step: "test it", status: "in_progress" },
          { status: "pending" }, // step 非文字列は skip。
        ],
      }),
    );
    expect(dto.plan_items).toEqual([
      { step: "ship it", status: "completed" },
      { step: "test it", status: "in_progress" },
    ]);
    expect(JSON.stringify(dto.plan_items)).not.toContain("AKIA");
    expect(JSON.stringify(dto.plan_items)).not.toContain("note");
  });

  it("work_item_subject / plan step は post-floor 有界化 (boundTurnSummary)", () => {
    const long = "x".repeat(500);
    const dto = rowToReplayEvent(
      row({ event_type: "work.item.updated", provider_task_id: "1", work_item_subject: long }),
    );
    expect(dto.work_item_subject!.length).toBeLessThan(long.length);
    const planDto = rowToReplayEvent(
      row({ event_type: "turn.plan.updated", plan_items: [{ step: long, status: "pending" }] }),
    );
    expect(planDto.plan_items![0]!.step.length).toBeLessThan(long.length);
  });

  it("carriage フィールドが無い row は当該キーを落とす (additive optional・wire 非搬送)", () => {
    const dto = rowToReplayEvent(row({ event_type: "heartbeat" }));
    expect("provider_task_id" in dto).toBe(false);
    expect("work_item_status" in dto).toBe(false);
    expect("plan_items" in dto).toBe(false);
    expect("check_kind" in dto).toBe(false);
    expect("head_sha" in dto).toBe(false);
  });

  it("plan_items が非配列なら plan_items キーを落とす", () => {
    const dto = rowToReplayEvent(row({ event_type: "turn.plan.updated", plan_items: "oops" }));
    expect("plan_items" in dto).toBe(false);
  });
});
