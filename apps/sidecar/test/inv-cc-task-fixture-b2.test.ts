/**
 * INV-CC-TASK-FIXTURE-B2 (ADR 0015 §D2・SEC-B2-3 = QA fixture・裁定 019fca13 unblock 3)。
 *
 * 契約: normalizeHook が **実 CC 2.1.220 の生 payload** の field 名を正しく読むことを固定する
 *   (field 名 drift 検出)。fixture は live probe (隔離 HOME/CLAUDE_CONFIG_DIR で実 claude を起動し
 *   1 task を作成→in_progress→完了) で採取した生 payload を **サニタイズ**したもの:
 *     session_id / cwd / transcript_path / prompt_id / tool_use_id を固定ダミーへ置換 (実 secret / 実パス
 *     を fixture に含めない)。id / status / field 構造 (task_id・taskId camelCase・tool_response.task.id・
 *     tool_input.status) は **生のまま** 保持し、これらを normalizeHook が正しく読むかを検証する。
 *
 * RED-on-break: normalizeHook が field 名を取り違える (drift) と、当該チャネルの provider_task_id が
 *   undefined になり work item が emit されない / 別値になるため本 assert が赤化する。
 *
 * live 観測の核心 (裁定 019fca13 unblock 1): 同一 task に対し 4 チャネルの id 値が**全て "1" で一致**
 *   (TaskCreated hook task_id / PostToolUse(TaskCreate) tool_response.task.id /
 *    PostToolUse(TaskUpdate) tool_input.taskId / TaskCompleted hook task_id)。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { deriveWorkItemId } from "@actradeck/event-model";
import { reduceWorkItems } from "@actradeck/projection";

import { normalizeHook, type HookCommonInput } from "../src/normalize.js";

interface Fixture {
  readonly _meta: Record<string, string>;
  readonly events: Array<Record<string, unknown>>;
}

const fixturePath = fileURLToPath(
  new URL("./fixtures/cc-2.1.220-task-hooks.json", import.meta.url),
);
const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as Fixture;

interface WorkItemPayload {
  provider_task_id?: string;
  status?: string;
  subject?: string;
  observation?: { method?: string; fidelity?: string };
}

/** fixture の n 番目の event (0-index) を normalizeHook へ流し work.item.updated payload を得る。 */
function wiPayloadOf(ev: Record<string, unknown>): WorkItemPayload | undefined {
  const out = normalizeHook(ev as unknown as HookCommonInput);
  const wi = out.find((e) => e.event_type === "work.item.updated");
  return wi?.payload as WorkItemPayload | undefined;
}

function byHook(name: string, tool?: string): Record<string, unknown> {
  const e = fixture.events.find(
    (x) => x.hook_event_name === name && (tool === undefined || x.tool_name === tool),
  );
  if (e === undefined) throw new Error(`fixture missing ${name}${tool ? "/" + tool : ""}`);
  return e;
}

describe("INV-CC-TASK-FIXTURE-B2: 実 CC 2.1.220 payload の field 名を normalizeHook が読む (drift 検出)", () => {
  it("fixture は sanitize 済み (実 secret / 実パスを含まない・at-rest fixture 契約)", () => {
    const raw = readFileSync(fixturePath, "utf8");
    // needle はフラグメント結合で構成し、本ソース自体に実パス literal を焼き込まない
    // (canonical repo の leak-coupling gate 回避・ADR 019f6d64)。
    const homeNeedle = ["", "home", "owner"].join("/"); // 実 HOME prefix
    const tmpNeedle = ["", "tmp", "claude"].join("/"); // scratch prefix
    expect(raw).not.toContain(homeNeedle);
    expect(raw).not.toContain(tmpNeedle);
    expect(raw).not.toMatch(/ghp_|sk-ant-|AKIA[0-9A-Z]{16}/);
    // 実 tool_use_id (toolu_01…) を残さない (固定ダミーへ置換済)。
    expect(raw).not.toMatch(/toolu_01[0-9A-Za-z]/);
  });

  it("TaskCreated hook: provider_task_id=task_id('1'), status=pending, subject=task_subject, observed", () => {
    const p = wiPayloadOf(byHook("TaskCreated"))!;
    expect(p.provider_task_id).toBe("1"); // ← field 名 drift (task_id→他) なら undefined で RED。
    expect(p.status).toBe("pending");
    expect(p.subject).toBe("probe alpha task");
    expect(p.observation).toEqual({ method: "official_hook", fidelity: "observed" });
  });

  it("PostToolUse(TaskCreate): provider_task_id=tool_response.task.id('1'), status=pending, subject=tool_input.subject, parsed", () => {
    const p = wiPayloadOf(byHook("PostToolUse", "TaskCreate"))!;
    expect(p.provider_task_id).toBe("1"); // ← tool_response.task.id パス drift なら RED。
    expect(p.status).toBe("pending");
    expect(p.subject).toBe("probe alpha task");
    expect(p.observation).toEqual({ method: "official_hook", fidelity: "parsed" });
  });

  it("PostToolUse(TaskUpdate): provider_task_id=tool_input.taskId('1' camelCase), status=tool_input.status, parsed", () => {
    // fixture は in_progress→completed の 2 つの PostToolUse(TaskUpdate) を含む。両方読める。
    const updates = fixture.events.filter(
      (x) => x.hook_event_name === "PostToolUse" && x.tool_name === "TaskUpdate",
    );
    expect(updates.length).toBeGreaterThanOrEqual(2);
    const statuses = updates.map((u) => {
      const p = wiPayloadOf(u)!;
      expect(p.provider_task_id).toBe("1"); // ← taskId(camel) drift なら RED。
      expect(p.observation).toEqual({ method: "official_hook", fidelity: "parsed" });
      return p.status;
    });
    expect(statuses).toContain("in_progress");
    expect(statuses).toContain("completed");
  });

  it("TaskCompleted hook: provider_task_id=task_id('1'), status=completed, observed", () => {
    const p = wiPayloadOf(byHook("TaskCompleted"))!;
    expect(p.provider_task_id).toBe("1");
    expect(p.status).toBe("completed");
    expect(p.observation).toEqual({ method: "official_hook", fidelity: "observed" });
  });

  it("4 チャネルの id 値が一致 → 同一 work_item_id (live 観測の焼き直しでなく fixture 由来で pin)", () => {
    const ids = [
      byHook("TaskCreated"),
      byHook("PostToolUse", "TaskCreate"),
      byHook("TaskCompleted"),
    ].map((e) => wiPayloadOf(e)!.provider_task_id!);
    // TaskUpdate も追加。
    const updateId = wiPayloadOf(
      fixture.events.find(
        (x) => x.hook_event_name === "PostToolUse" && x.tool_name === "TaskUpdate",
      )!,
    )!.provider_task_id!;
    ids.push(updateId);
    const workItemIds = new Set(ids.map((id) => deriveWorkItemId("task", id)));
    expect(workItemIds.size).toBe(1); // ← 1 チャネルでも id が食い違えば >1 で RED。
  });

  it("fixture 全体を fold → 単一 completed work item に収束 (受入 6・end-to-end・実 payload)", () => {
    const evs = fixture.events
      .flatMap((e) => normalizeHook(e as unknown as HookCommonInput))
      .filter((e) => e.event_type === "work.item.updated")
      .map((e, i) => ({ ...e, timestamp: `2026-08-04T00:00:${String(i).padStart(2, "0")}.000Z` }));
    const proj = reduceWorkItems("00000000-0000-4000-8000-000000000000", evs);
    expect(proj.items).toHaveLength(1);
    expect(proj.items[0]!.status).toBe("completed");
  });
});
