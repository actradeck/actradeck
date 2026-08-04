/**
 * INV-WORKITEMS-B2 (ADR 0015 §D2/§D7・B2)。
 *
 * CC の task 観測 → `work.item.updated` 正規化を固定する:
 *  - 専用 hook TaskCreated/TaskCompleted → status pending/completed・observation={official_hook, observed}。
 *  - PostToolUse(TaskCreate/TaskUpdate) parse → observation={official_hook, parsed}・全遷移。
 *  - live 検証済み field のみ parse (task_id / tool_response.task.id / taskId(camelCase) / tool_input.status)。
 *  - INV-WORKITEM-NO-STATE: work.item.updated は state を持たない (§D1)。
 *  - 二重ソース単一 claim (受入 6): 同一 provider_task_id を hook(observed) と PostToolUse(parsed) が観測
 *    → fold は 1 work item・claimed_at=初観測・fidelity は最高 (observed) へ昇格。
 *
 * 実 field 名の出所 (最重要契約): live 検証 2026-08-04・CC 2.1.220 (稼働 `claude --version` と一致)。
 *   隔離 CLAUDE_CONFIG_DIR/HOME + command hook で raw payload を採取 (live ~/.claude 非改変):
 *     TaskCreated/TaskCompleted hook = {session_id, transcript_path, cwd, prompt_id, hook_event_name,
 *       task_id:"1", task_subject, task_description} (agent_id 無し・status field 無し)。
 *     PostToolUse(TaskCreate) tool_input={subject,description,activeForm}・tool_response={task:{id,subject}}。
 *     PostToolUse(TaskUpdate) tool_input={taskId,status}・tool_response={success,taskId,updatedFields,
 *       statusChange:{from,to}}。観測 status = pending/in_progress/completed。
 */
import { describe, expect, it } from "vitest";

import { deriveWorkItemId } from "@actradeck/event-model";
import { reduceWorkItems } from "@actradeck/projection";

import { normalizeHook, type HookCommonInput } from "../src/normalize.js";

const SID = "019a7bfb-9f7d-7bc3-b4a8-95fce7c4dbc4";

function hook(input: Partial<HookCommonInput> & { hook_event_name: string }): HookCommonInput {
  return { session_id: SID, ...input } as HookCommonInput;
}

interface WorkItemPayload {
  kind?: string;
  provider_task_id?: string;
  status?: string;
  subject?: string;
  description?: string;
  observation?: { method?: string; fidelity?: string };
}

describe("INV-WORKITEMS-B2: 専用 hook TaskCreated/TaskCompleted → work.item.updated", () => {
  it("TaskCreated → work.item.updated status=pending, observation={official_hook, observed}, state 無し", () => {
    const evs = normalizeHook(
      hook({
        hook_event_name: "TaskCreated",
        task_id: "1",
        task_subject: "implement B2",
        task_description: "wire CC task hooks",
      }),
    );
    expect(evs).toHaveLength(1);
    const ev = evs[0]!;
    expect(ev.event_type).toBe("work.item.updated");
    // INV-WORKITEM-NO-STATE (§D1): 純観測ゆえ state を持たない。
    expect(ev.state).toBeUndefined();
    const p = ev.payload as WorkItemPayload;
    expect(p.provider_task_id).toBe("1");
    expect(p.status).toBe("pending");
    expect(p.subject).toBe("implement B2");
    expect(p.description).toBe("wire CC task hooks");
    expect(p.observation).toEqual({ method: "official_hook", fidelity: "observed" });
  });

  it("TaskCompleted → work.item.updated status=completed, observation={official_hook, observed}", () => {
    const ev = normalizeHook(
      hook({ hook_event_name: "TaskCompleted", task_id: "2", task_subject: "ship it" }),
    )[0]!;
    expect(ev.event_type).toBe("work.item.updated");
    expect(ev.state).toBeUndefined();
    const p = ev.payload as WorkItemPayload;
    expect(p.provider_task_id).toBe("2");
    expect(p.status).toBe("completed");
    expect(p.observation).toEqual({ method: "official_hook", fidelity: "observed" });
  });

  it("task_id 欠落は同定不能 → work item を作らず heartbeat 化 (落とさない)", () => {
    const evs = normalizeHook(hook({ hook_event_name: "TaskCreated", task_subject: "no id" }));
    expect(evs).toHaveLength(1);
    expect(evs[0]!.event_type).toBe("heartbeat");
  });
});

describe("INV-WORKITEMS-B2: PostToolUse(TaskCreate/TaskUpdate) parse → work.item.updated (parsed)", () => {
  it("TaskCreate: id=tool_response.task.id, status=pending, subject=tool_input.subject, fidelity=parsed", () => {
    const evs = normalizeHook(
      hook({
        hook_event_name: "PostToolUse",
        tool_name: "TaskCreate",
        tool_input: { subject: "probe subject", description: "probe desc", activeForm: "Running" },
        tool_response: { task: { id: "5", subject: "probe subject" } },
        tool_use_id: "toolu_a",
      }),
    );
    const wi = evs.find((e) => e.event_type === "work.item.updated")!;
    expect(wi).toBeDefined();
    expect(wi.state).toBeUndefined();
    const p = wi.payload as WorkItemPayload;
    expect(p.provider_task_id).toBe("5");
    expect(p.status).toBe("pending");
    expect(p.subject).toBe("probe subject");
    expect(p.description).toBe("probe desc");
    expect(p.observation).toEqual({ method: "official_hook", fidelity: "parsed" });
    // generic tool.completed も併せて emit する (tool.started↔completed 均衡・非退行)。
    expect(evs.some((e) => e.event_type === "tool.completed")).toBe(true);
  });

  it("TaskUpdate: id=tool_input.taskId(camelCase), status=tool_input.status, subject 無し, fidelity=parsed", () => {
    const evs = normalizeHook(
      hook({
        hook_event_name: "PostToolUse",
        tool_name: "TaskUpdate",
        tool_input: { taskId: "5", status: "in_progress" },
        tool_response: {
          success: true,
          taskId: "5",
          statusChange: { from: "pending", to: "in_progress" },
        },
        tool_use_id: "toolu_b",
      }),
    );
    const wi = evs.find((e) => e.event_type === "work.item.updated")!;
    const p = wi.payload as WorkItemPayload;
    expect(p.provider_task_id).toBe("5");
    expect(p.status).toBe("in_progress");
    // TaskUpdate tool_input は subject を載せない (live 検証) → 捏造しない。
    expect(p.subject).toBeUndefined();
    expect(p.observation).toEqual({ method: "official_hook", fidelity: "parsed" });
  });

  it("TaskUpdate 未知 status は closed-enum gate で 'unknown' へ (sink parse 落ちを防ぐ)", () => {
    const evs = normalizeHook(
      hook({
        hook_event_name: "PostToolUse",
        tool_name: "TaskUpdate",
        tool_input: { taskId: "9", status: "frobnicated" },
        tool_use_id: "toolu_c",
      }),
    );
    const wi = evs.find((e) => e.event_type === "work.item.updated")!;
    expect((wi.payload as WorkItemPayload).status).toBe("unknown");
  });

  it("TaskCreate で tool_response.task.id 欠落は同定不能 → work item を作らず tool.completed のみ", () => {
    const evs = normalizeHook(
      hook({
        hook_event_name: "PostToolUse",
        tool_name: "TaskCreate",
        tool_input: { subject: "s" },
        tool_response: {},
        tool_use_id: "toolu_d",
      }),
    );
    expect(evs.some((e) => e.event_type === "work.item.updated")).toBe(false);
    expect(evs.some((e) => e.event_type === "tool.completed")).toBe(true);
  });

  it("同一 task_id は hook と PostToolUse で同一 work_item_id へ写る (fold 統合の前提)", () => {
    const fromHook = normalizeHook(hook({ hook_event_name: "TaskCompleted", task_id: "7" }))[0]!
      .payload as WorkItemPayload;
    const fromPost = normalizeHook(
      hook({
        hook_event_name: "PostToolUse",
        tool_name: "TaskUpdate",
        tool_input: { taskId: "7", status: "completed" },
      }),
    ).find((e) => e.event_type === "work.item.updated")!.payload as WorkItemPayload;
    expect(fromHook.provider_task_id).toBe("7");
    expect(fromPost.provider_task_id).toBe("7");
    // fold は deriveWorkItemId("task", provider_task_id) で同一 id を導出する (§D3)。
    expect(deriveWorkItemId("task", fromHook.provider_task_id!)).toBe(
      deriveWorkItemId("task", fromPost.provider_task_id!),
    );
  });
});

describe("INV-WORKITEMS-B2: create 二重ソース単一 work item (受入 6・create 段・TDA-B2-2 unblock)", () => {
  /**
   * 中核契約 (裁定 019fca13 unblock 1): create 段で同一 task が **専用 hook (TaskCreated・observed) と
   * PostToolUse(TaskCreate・parsed) の二重ソース**で観測されても、fold は 1 pending work item へ畳む
   * (2 pending へ**永久分裂しない**)。これは create-path の id **値**一致
   * (TaskCreated hook `task_id` === PostToolUse(TaskCreate) `tool_response.task.id`) に依存する。
   *
   * **live 検証 (REAL DATA・CC 2.1.220・2026-08-04・隔離 HOME/CLAUDE_CONFIG_DIR で実 claude 起動・
   *   1 task を作成→in_progress→完了)**: 同一 task に対し 4 チャネルの id 値が**全て "1" で一致**した:
   *     (a) TaskCreated hook `task_id` = "1"
   *     (b) PostToolUse(TaskCreate) `tool_response.task.id` = "1"
   *     (c) PostToolUse(TaskUpdate) `tool_input.taskId` = "1"
   *     (d) TaskCompleted hook `task_id` = "1"
   *   ゆえ deriveWorkItemId("task", "1") が全チャネルで同一 → create 段の二重ソースは 1 work item に畳む。
   *   既存 dual-source test (下) は **完了収束** (TaskUpdate↔TaskCompleted) のみ pin していたため、
   *   create 段 (TaskCreate tool_response.task.id ↔ TaskCreated hook task_id) の等価は本 describe で pin する
   *   (inv-redaction-workitem は意図的に別 id "1"/"2" を流すため create 一致を pin しない)。
   */
  function at(ev: ReturnType<typeof normalizeHook>[number], iso: string) {
    return { ...ev, timestamp: iso };
  }

  /** live 観測形の TaskCreated hook (observed・status pending・task_id を宣言)。 */
  function createdHook(taskId: string) {
    return normalizeHook(
      hook({
        hook_event_name: "TaskCreated",
        task_id: taskId,
        task_subject: "probe alpha task",
      }),
    ).find((e) => e.event_type === "work.item.updated")!;
  }

  /** live 観測形の PostToolUse(TaskCreate) (parsed・生成 id は tool_response.task.id・status pending)。 */
  function createTool(createdId: string) {
    return normalizeHook(
      hook({
        hook_event_name: "PostToolUse",
        tool_name: "TaskCreate",
        tool_input: { subject: "probe alpha task", description: "probe alpha task" },
        tool_response: { task: { id: createdId, subject: "probe alpha task" } },
      }),
    ).find((e) => e.event_type === "work.item.updated")!;
  }

  it("id 値一致 (live 観測 '1'): create の二重ソースが同一 provider_task_id を出す", () => {
    const observed = createdHook("1").payload as WorkItemPayload;
    const parsed = createTool("1").payload as WorkItemPayload;
    // 別 field 経路 (hook task_id vs tool_response.task.id) だが同一値 (live 検証)。
    expect(observed.provider_task_id).toBe("1");
    expect(parsed.provider_task_id).toBe("1");
    expect(deriveWorkItemId("task", observed.provider_task_id!)).toBe(
      deriveWorkItemId("task", parsed.provider_task_id!),
    );
  });

  it("observed 先着 → parsed 後着: create 二重ソースは 1 pending work item へ畳む (分裂しない)", () => {
    const observed = createdHook("1");
    const parsed = createTool("1");
    const proj = reduceWorkItems(SID, [
      at(observed, "2026-08-04T00:00:01.000Z"),
      at(parsed, "2026-08-04T00:00:02.000Z"),
    ]);
    expect(proj.items).toHaveLength(1); // ← 別 id なら 2 に分裂し RED (受入 6 破綻)。
    expect(proj.items[0]!.status).toBe("pending");
    expect(proj.items[0]!.claimed_at).toBeUndefined(); // pending ゆえ未 claim。
  });

  it("parsed 先着 → observed 後着 (逆順) でも 1 pending work item へ畳む", () => {
    const parsed = createTool("1");
    const observed = createdHook("1");
    const proj = reduceWorkItems(SID, [
      at(parsed, "2026-08-04T00:00:01.000Z"),
      at(observed, "2026-08-04T00:00:02.000Z"),
    ]);
    expect(proj.items).toHaveLength(1);
    expect(proj.items[0]!.status).toBe("pending");
  });

  it("create→update→complete 全ライフサイクルが単一 work item に収束 (4 チャネル id 一致・live)", () => {
    // (a) TaskCreated hook → (b) PostToolUse(TaskCreate) → (c) PostToolUse(TaskUpdate completed)
    //   → (d) TaskCompleted hook。live で 4 チャネル id="1" ゆえ全て同一 work item。
    const createdH = createdHook("1");
    const createT = createTool("1");
    const updateT = normalizeHook(
      hook({
        hook_event_name: "PostToolUse",
        tool_name: "TaskUpdate",
        tool_input: { taskId: "1", status: "completed" },
      }),
    ).find((e) => e.event_type === "work.item.updated")!;
    const completedH = normalizeHook(hook({ hook_event_name: "TaskCompleted", task_id: "1" }))[0]!;

    const proj = reduceWorkItems(SID, [
      at(createdH, "2026-08-04T00:00:01.000Z"),
      at(createT, "2026-08-04T00:00:02.000Z"),
      at(updateT, "2026-08-04T00:00:03.000Z"),
      at(completedH, "2026-08-04T00:00:04.000Z"),
    ]);
    expect(proj.items).toHaveLength(1);
    const item = proj.items[0]!;
    expect(item.status).toBe("completed");
    // 単一 claim: 初 completed 観測 (t3) で claim・fidelity は最高 (observed) へ昇格。
    expect(item.claimed_at).toBe("2026-08-04T00:00:03.000Z");
    expect(item.claim_fidelity).toBe("observed");
  });
});

describe("INV-WORKITEMS-B2: 二重ソース単一 claim (受入 6・fold end-to-end)", () => {
  /** normalizeHook の 1 イベントに決定的 timestamp を差す (claimed_at=初観測を検証するため)。 */
  function at(ev: ReturnType<typeof normalizeHook>[number], iso: string) {
    return { ...ev, timestamp: iso };
  }

  it("PostToolUse(TaskUpdate→completed, parsed) 先行 → TaskCompleted hook(observed) は 1 claim へ畳み fidelity 昇格", () => {
    const parsed = normalizeHook(
      hook({
        hook_event_name: "PostToolUse",
        tool_name: "TaskUpdate",
        tool_input: { taskId: "1", status: "completed" },
      }),
    ).find((e) => e.event_type === "work.item.updated")!;
    const observed = normalizeHook(hook({ hook_event_name: "TaskCompleted", task_id: "1" }))[0]!;

    const t1 = "2026-08-04T00:00:01.000Z";
    const t2 = "2026-08-04T00:00:02.000Z";
    const proj = reduceWorkItems(SID, [at(parsed, t1), at(observed, t2)]);

    expect(proj.items).toHaveLength(1);
    const item = proj.items[0]!;
    expect(item.status).toBe("completed");
    // 単一 claim: claimed_at は初観測 (t1)。
    expect(item.claimed_at).toBe(t1);
    // fidelity は最高観測 (parsed→observed) へ昇格。
    expect(item.claim_fidelity).toBe("observed");
    expect(item.claim_method).toBe("official_hook");
  });

  it("TaskCompleted hook(observed) 先行 → PostToolUse(parsed) 後続でも 1 claim・fidelity は下がらない", () => {
    const observed = normalizeHook(hook({ hook_event_name: "TaskCompleted", task_id: "1" }))[0]!;
    const parsed = normalizeHook(
      hook({
        hook_event_name: "PostToolUse",
        tool_name: "TaskUpdate",
        tool_input: { taskId: "1", status: "completed" },
      }),
    ).find((e) => e.event_type === "work.item.updated")!;

    const t1 = "2026-08-04T00:00:01.000Z";
    const t2 = "2026-08-04T00:00:02.000Z";
    const proj = reduceWorkItems(SID, [at(observed, t1), at(parsed, t2)]);

    expect(proj.items).toHaveLength(1);
    const item = proj.items[0]!;
    expect(item.claimed_at).toBe(t1);
    expect(item.claim_fidelity).toBe("observed"); // parsed へは downgrade しない。
  });
});
