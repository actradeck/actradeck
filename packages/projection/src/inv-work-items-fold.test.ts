/**
 * INV-WORKITEMS-FOLD (ADR 0015・受入 5/6/7/8/9/12/14/15 + MAX + badge).
 *
 * work-items 純 fold の T1 契約を固定する:
 * - INV-WORKITEM-NO-STATE (受入7): work.item.updated が session 状態機械を動かさない。
 * - INV-VERIFICATION-STALE (受入8): 永久 verified boolean 非存在・passed→指紋変化→stale。
 * - run_dirty (受入9) / no-exit は非 flip (受入12) / snapshot 調停 (受入5) / dual-source claim (受入6)。
 * - fold parity (受入14): 増分 apply == 一括 reduce・決定的。terminal freeze (受入15)。MAX 超過 drop。
 */
import {
  deriveWorkItemId,
  newEventId,
  parseEvent,
  type NormalizedEvent,
} from "@actradeck/event-model";
import { describe, expect, it } from "vitest";

import { applyEvent, initialProjection } from "./index.js";
import {
  MAX_WORK_ITEMS,
  applyWorkItemsEvent,
  deriveWorkItemBadge,
  initialWorkItemsProjection,
  reduceWorkItems,
  type WorkItem,
  type WorkItemsProjection,
} from "./work-items.js";

/** 単調増加タイムスタンプ (claimed_at ≤ check 完了時刻の比較を決定的にする)。 */
function ts(n: number): string {
  const base = Date.UTC(2026, 5, 6, 0, 0, 0);
  return new Date(base + n * 1000).toISOString();
}

let clock = 0;
function ev(o: {
  readonly event_type: string;
  readonly state?: string;
  readonly timestamp?: string;
  readonly payload?: Record<string, unknown>;
  readonly session_id?: string;
}): NormalizedEvent {
  clock += 1;
  return parseEvent({
    event_id: newEventId(),
    provider: "claude_code",
    source: "hooks",
    session_id: o.session_id ?? "s1",
    event_type: o.event_type,
    ...(o.state !== undefined ? { state: o.state } : {}),
    timestamp: o.timestamp ?? ts(clock),
    payload: o.payload ?? {},
  });
}

function reduce(events: readonly NormalizedEvent[]): WorkItemsProjection {
  return reduceWorkItems("s1", events);
}

function itemById(p: WorkItemsProjection, id: string): WorkItem | undefined {
  return p.items.find((it) => it.work_item_id === id);
}

/** completed の task item を 1 つ持つ projection を返す (id 導出を fold に委ねる)。 */
function onlyTaskItem(p: WorkItemsProjection): WorkItem {
  const it = p.items.find((i) => i.id_scheme === "task");
  if (it === undefined) throw new Error("no task item");
  return it;
}

describe("INV-WORKITEM-NO-STATE (受入7): work.item.updated は session 状態機械を動かさない", () => {
  it("running.command_executing のまま state を保持・invalid transition を出さない", () => {
    let proj = initialProjection("s1");
    proj = applyEvent(
      proj,
      ev({ event_type: "command.started", state: "running.command_executing" }),
    ).projection;
    const before = proj.state;
    const res = applyEvent(
      proj,
      ev({
        event_type: "work.item.updated",
        payload: { provider_task_id: "1", status: "completed" },
      }),
    );
    expect(res.projection.state).toBe(before);
    expect(res.projection.state).toBe("running.command_executing");
    expect(res.invalidTransition).toBe(false);
    expect(res.ignoredAfterTerminal).toBe(false);
  });

  it("work.item.updated イベントに state を載せないのが契約 (fold は state に依存しない)", () => {
    const e = ev({
      event_type: "work.item.updated",
      payload: { provider_task_id: "1", status: "pending" },
    });
    expect(e.state).toBeUndefined();
  });
});

describe("INV-VERIFICATION-STALE (受入8): 検証遷移・永久 verified boolean 非存在", () => {
  it("claim → 合格 check ⇒ passed(verified_tree_fp) → 指紋変化 ⇒ stale → 失敗 check ⇒ failed → reopen ⇒ unverified", () => {
    const events: NormalizedEvent[] = [];
    events.push(ev({ event_type: "diff.updated", payload: { head_sha: "h1", diff_hash: "d1" } }));
    events.push(
      ev({
        event_type: "work.item.updated",
        payload: { provider_task_id: "1", status: "completed" },
      }),
    );
    // 合格 check (exit 0) → passed。
    events.push(
      ev({
        event_type: "command.completed",
        payload: { check_kind: "test", check_match: "program", exit_code: 0, request_id: "r1" },
      }),
    );
    let p = reduce(events);
    let item = onlyTaskItem(p);
    expect(item.verification_state).toBe("passed");
    expect(item.verified_tree_fp).toBeDefined();
    expect(deriveWorkItemBadge(item)).toBe("verified");
    const passedFp = item.verified_tree_fp;

    // 指紋変化 → stale (永久 verified を作らない)。
    events.push(ev({ event_type: "diff.updated", payload: { head_sha: "h2", diff_hash: "d2" } }));
    p = reduce(events);
    item = onlyTaskItem(p);
    expect(item.verification_state).toBe("stale");
    expect(item.verified_tree_fp).toBe(passedFp); // 検証時の指紋は保持 (根拠)。
    expect(deriveWorkItemBadge(item)).toBe("changed_after_verification");

    // 失敗 check (exit 1) → failed (stale クリア)。
    events.push(
      ev({
        event_type: "command.completed",
        payload: { check_kind: "test", check_match: "program", exit_code: 1, request_id: "r2" },
      }),
    );
    p = reduce(events);
    item = onlyTaskItem(p);
    expect(item.verification_state).toBe("failed");
    expect(item.stale_at).toBeUndefined();
    expect(deriveWorkItemBadge(item)).toBe("verification_failed");

    // reopen (completed → in_progress) → claim & 検証撤回・unverified。
    events.push(
      ev({
        event_type: "work.item.updated",
        payload: { provider_task_id: "1", status: "in_progress" },
      }),
    );
    p = reduce(events);
    item = onlyTaskItem(p);
    expect(item.status).toBe("in_progress");
    expect(item.verification_state).toBe("unverified");
    expect(item.claimed_at).toBeUndefined();
    expect(item.claim_event_id).toBeUndefined();
    expect(deriveWorkItemBadge(item)).toBeUndefined(); // 非 completed はバッジ無し。
  });

  it("check は completed かつ claimed_at ≤ check 完了時刻の item のみ束縛する (session-global・§D5)", () => {
    // まだ claim していない item に合格 check が来ても検証しない。
    const p = reduce([
      ev({
        event_type: "work.item.updated",
        payload: { provider_task_id: "1", status: "in_progress" },
      }),
      ev({
        event_type: "command.completed",
        payload: { check_kind: "test", exit_code: 0, request_id: "r1" },
      }),
    ]);
    expect(onlyTaskItem(p).verification_state).toBe("unverified");
  });
});

describe("TDA-1 (fingerprint 基盤ガード・非対称): passed は tree_fp 必須・failed は基盤なしでも許可", () => {
  it("fp 未観測で合格 check (exit 0) → passed へ遷移させない (unverified 維持・verification 不動)", () => {
    // diff.updated が一度も来ていない = tree_fp undefined。合格でも基盤なしに verified を主張しない。
    const p = reduce([
      ev({
        event_type: "work.item.updated",
        payload: { provider_task_id: "1", status: "completed" },
      }),
      ev({
        event_type: "command.completed",
        payload: { check_kind: "test", check_match: "program", exit_code: 0, request_id: "r1" },
      }),
    ]);
    const item = onlyTaskItem(p);
    expect(item.verification_state).toBe("unverified");
    expect(item.verified_at).toBeUndefined();
    expect(item.verification_event_id).toBeUndefined();
    expect(item.check_kind).toBeUndefined();
  });

  it("fp 未観測でも失敗 check (exit≠0) → failed は許可 (安全方向の警報・基盤に依存しない事実)", () => {
    const p = reduce([
      ev({
        event_type: "work.item.updated",
        payload: { provider_task_id: "1", status: "completed" },
      }),
      ev({
        event_type: "command.completed",
        payload: { check_kind: "test", check_match: "program", exit_code: 1, request_id: "r1" },
      }),
    ]);
    const item = onlyTaskItem(p);
    expect(item.verification_state).toBe("failed");
    expect(item.check_exit_code).toBe(1);
    expect(deriveWorkItemBadge(item)).toBe("verification_failed");
  });

  it("fp を先に観測 → 合格 check → passed (基盤ありでは従来どおり)", () => {
    const p = reduce([
      ev({ event_type: "diff.updated", payload: { head_sha: "h1", diff_hash: "d1" } }),
      ev({
        event_type: "work.item.updated",
        payload: { provider_task_id: "1", status: "completed" },
      }),
      ev({
        event_type: "command.completed",
        payload: { check_kind: "test", check_match: "program", exit_code: 0, request_id: "r1" },
      }),
    ]);
    const item = onlyTaskItem(p);
    expect(item.verification_state).toBe("passed");
    expect(item.verified_tree_fp).toBeDefined();
  });
});

describe("QA-1 (時刻条項の falsifying): claimed_at ≤ check 完了時刻でのみ束縛する", () => {
  // この条項は **item が既に存在するが claimed_at が check 完了時刻より後** のときにのみ効く。
  //   (item が check 後に生成される単純ケースは「item 不在」経路で unverified になり条項を突かない)。
  //   ゆえに timestamp を **順不同**にする: claim を後刻 (t20) に持ちつつ stream 上は check より前に
  //   処理させ、check 完了 timestamp を早刻 (t10) にする。at-least-once の再順序化で実在する状況で、
  //   fold は stream 順ではなく **timestamp** で束縛可否を決める (toEpochMs 比較) ことを固定する。
  //   TDA-1 ガード導入後ゆえ fp を先に観測させてから並べる。
  it("claim 完了時刻 (t20) より前に完了した check (t10) は束縛しない (item 実在下で条項が効く)", () => {
    const before = reduce([
      ev({
        event_type: "diff.updated",
        timestamp: ts(1),
        payload: { head_sha: "h1", diff_hash: "d1" },
      }),
      // claim: stream 上は先・wall-clock は後 (t20)。
      ev({
        event_type: "work.item.updated",
        timestamp: ts(20),
        payload: { provider_task_id: "1", status: "completed" },
      }),
      // check: item は既に存在するが完了 timestamp (t10) < claimed_at (t20) → 束縛しない。
      ev({
        event_type: "command.completed",
        timestamp: ts(10),
        payload: { check_kind: "test", exit_code: 0, request_id: "rEarly" },
      }),
    ]);
    expect(onlyTaskItem(before).verification_state).toBe("unverified");
  });

  it("claim 完了時刻 (t10) の後に完了した check (t15) は束縛する (passed)", () => {
    const after = reduce([
      ev({
        event_type: "diff.updated",
        timestamp: ts(1),
        payload: { head_sha: "h1", diff_hash: "d1" },
      }),
      ev({
        event_type: "work.item.updated",
        timestamp: ts(10),
        payload: { provider_task_id: "1", status: "completed" },
      }),
      ev({
        event_type: "command.completed",
        timestamp: ts(15),
        payload: { check_kind: "test", exit_code: 0, request_id: "rLate" },
      }),
    ]);
    expect(onlyTaskItem(after).verification_state).toBe("passed");
  });

  // A1 sweep (QA 観察): 等号境界の明示 pin。条項は `claimed_at ≤ check 完了時刻` (work-items.ts の
  //   skip 条件は strict `>`) ゆえ、claimed_at == check 完了 timestamp は**束縛する**側。
  //   等号を除外する変異 (>= へ) を falsify する。
  it("claim 完了時刻 (t10) と同時刻に完了した check (t10) は束縛する (等号は ≤ 側・passed)", () => {
    const same = reduce([
      ev({
        event_type: "diff.updated",
        timestamp: ts(1),
        payload: { head_sha: "h1", diff_hash: "d1" },
      }),
      ev({
        event_type: "work.item.updated",
        timestamp: ts(10),
        payload: { provider_task_id: "1", status: "completed" },
      }),
      ev({
        event_type: "command.completed",
        timestamp: ts(10),
        payload: { check_kind: "test", exit_code: 0, request_id: "rSame" },
      }),
    ]);
    expect(onlyTaskItem(same).verification_state).toBe("passed");
  });
});

describe("run_dirty (受入9): check の start〜completed 間に tree が動くと run_dirty=true", () => {
  it("interleave した diff.updated で run_dirty=true", () => {
    const p = reduce([
      ev({
        event_type: "work.item.updated",
        payload: { provider_task_id: "1", status: "completed" },
      }),
      ev({
        event_type: "command.started",
        payload: {
          command: "vitest",
          check_kind: "test",
          check_match: "program",
          request_id: "r1",
        },
      }),
      ev({ event_type: "diff.updated", payload: { head_sha: "h9", diff_hash: "d9" } }),
      ev({
        event_type: "command.completed",
        payload: { check_kind: "test", check_match: "program", exit_code: 0, request_id: "r1" },
      }),
    ]);
    const item = onlyTaskItem(p);
    expect(item.verification_state).toBe("passed");
    expect(item.run_dirty).toBe(true);
  });

  it("interleave が無ければ run_dirty=false", () => {
    const p = reduce([
      ev({
        event_type: "work.item.updated",
        payload: { provider_task_id: "1", status: "completed" },
      }),
      ev({ event_type: "command.started", payload: { check_kind: "test", request_id: "r1" } }),
      ev({
        event_type: "command.completed",
        payload: { check_kind: "test", exit_code: 0, request_id: "r1" },
      }),
    ]);
    expect(onlyTaskItem(p).run_dirty).toBe(false);
  });
});

describe("no-exit check (受入12): exit 抽出不能なら verification_state を動かさない", () => {
  it("exit_code 欠落の check は observed だが結果不明 → unverified 維持", () => {
    const p = reduce([
      ev({
        event_type: "work.item.updated",
        payload: { provider_task_id: "1", status: "completed" },
      }),
      ev({ event_type: "command.completed", payload: { check_kind: "test", request_id: "r1" } }),
    ]);
    expect(onlyTaskItem(p).verification_state).toBe("unverified");
  });
});

describe("snapshot 調停 (受入5): plan の absent → removed・reword は新 item + 旧 removed", () => {
  it("次 snapshot で消えた step は removed になる", () => {
    const p = reduce([
      ev({
        event_type: "turn.plan.updated",
        payload: {
          items: [
            { step: "a", status: "completed" },
            { step: "b", status: "in_progress" },
          ],
        },
      }),
      ev({
        event_type: "turn.plan.updated",
        payload: { items: [{ step: "a", status: "completed" }] },
      }),
    ]);
    const a = itemById(p, deriveId("plan", "a"));
    const b = itemById(p, deriveId("plan", "b"));
    expect(a?.status).toBe("completed");
    expect(b?.status).toBe("removed");
  });

  it("reword: 旧 step は removed・新 step は unverified の新 item (silent 再束縛しない)", () => {
    const p = reduce([
      ev({
        event_type: "turn.plan.updated",
        payload: { items: [{ step: "old wording", status: "completed" }] },
      }),
      ev({
        event_type: "turn.plan.updated",
        payload: { items: [{ step: "new wording", status: "in_progress" }] },
      }),
    ]);
    expect(itemById(p, deriveId("plan", "old wording"))?.status).toBe("removed");
    const fresh = itemById(p, deriveId("plan", "new wording"));
    expect(fresh?.status).toBe("in_progress");
    expect(fresh?.verification_state).toBe("unverified");
  });

  it("同一 snapshot 内の重複 step は 1 item へ collapse (last occurrence 勝ち)", () => {
    const p = reduce([
      ev({
        event_type: "turn.plan.updated",
        payload: {
          items: [
            { step: "dup", status: "pending" },
            { step: "dup", status: "completed" },
          ],
        },
      }),
    ]);
    expect(p.items.filter((i) => i.id_scheme === "plan")).toHaveLength(1);
    expect(itemById(p, deriveId("plan", "dup"))?.status).toBe("completed");
  });
});

describe("dual-source claim (受入6): 冪等・claimed_at は初観測・fidelity 昇格", () => {
  it("PostToolUse(parsed) + TaskCompleted hook(observed) → 1 claim・claimed_at 初観測・fidelity=observed", () => {
    const t1 = ts(10);
    const t2 = ts(20);
    const p = reduce([
      ev({
        event_type: "work.item.updated",
        timestamp: t1,
        payload: {
          provider_task_id: "1",
          status: "completed",
          observation: { method: "official_hook", fidelity: "parsed" },
        },
      }),
      ev({
        event_type: "work.item.updated",
        timestamp: t2,
        payload: {
          provider_task_id: "1",
          status: "completed",
          observation: { method: "official_hook", fidelity: "observed" },
        },
      }),
    ]);
    expect(p.items.filter((i) => i.id_scheme === "task")).toHaveLength(1);
    const item = onlyTaskItem(p);
    expect(item.claimed_at).toBe(t1); // 初観測。
    expect(item.claim_fidelity).toBe("observed"); // 最高 fidelity へ昇格。
  });

  it("逆順 (observed 先 → parsed 後) でも fidelity は最高 (observed) を保つ", () => {
    const p = reduce([
      ev({
        event_type: "work.item.updated",
        payload: {
          provider_task_id: "1",
          status: "completed",
          observation: { method: "official_hook", fidelity: "observed" },
        },
      }),
      ev({
        event_type: "work.item.updated",
        payload: {
          provider_task_id: "1",
          status: "completed",
          observation: { method: "official_hook", fidelity: "parsed" },
        },
      }),
    ]);
    expect(onlyTaskItem(p).claim_fidelity).toBe("observed");
  });
});

describe("fold parity (受入14): 増分 apply == 一括 reduce・決定的", () => {
  const events: NormalizedEvent[] = [
    ev({ event_type: "diff.updated", payload: { head_sha: "h1", diff_hash: "d1" } }),
    ev({
      event_type: "work.item.updated",
      payload: {
        provider_task_id: "1",
        status: "completed",
        observation: { method: "official_hook", fidelity: "observed" },
      },
    }),
    ev({
      event_type: "turn.plan.updated",
      payload: { items: [{ step: "x", status: "in_progress" }] },
    }),
    ev({
      event_type: "command.completed",
      payload: { check_kind: "test", exit_code: 0, request_id: "r1" },
    }),
    ev({ event_type: "diff.updated", payload: { head_sha: "h2", diff_hash: "d2" } }),
  ];

  it("一括 reduce == 逐次 apply 累積", () => {
    let inc = initialWorkItemsProjection("s1");
    for (const e of events) inc = applyWorkItemsEvent(inc, e);
    expect(reduceWorkItems("s1", events)).toEqual(inc);
  });

  it("同一入力で 2 回 reduce → 完全一致 (決定的)", () => {
    expect(reduceWorkItems("s1", events)).toEqual(reduceWorkItems("s1", events));
  });
});

describe("terminal freeze (受入15): session.ended 後のイベントは frozen 行を mutate しない", () => {
  it("session.ended で凍結し、以後の work.item/diff/command を無視する", () => {
    const beforeEnd = reduce([
      ev({
        event_type: "work.item.updated",
        payload: { provider_task_id: "1", status: "completed" },
      }),
    ]);
    const frozen = reduce([
      ev({
        event_type: "work.item.updated",
        payload: { provider_task_id: "1", status: "completed" },
      }),
      ev({ event_type: "session.ended", state: "completed", payload: { reason: "done" } }),
      ev({
        event_type: "work.item.updated",
        payload: { provider_task_id: "2", status: "completed" },
      }),
      ev({ event_type: "diff.updated", payload: { head_sha: "hx", diff_hash: "dx" } }),
    ]);
    expect(frozen.frozen).toBe(true);
    // end-of-run 真実を保存: item は 1 つ (pt=2 は無視)・claimed_unverified のまま。
    expect(frozen.items).toHaveLength(1);
    expect(onlyTaskItem(frozen).verification_state).toBe("unverified");
    expect(frozen.items.map((i) => i.status)).toEqual(beforeEnd.items.map((i) => i.status));
  });

  it("terminal state を帯びるイベントでも凍結する", () => {
    const p = reduce([
      ev({
        event_type: "work.item.updated",
        payload: { provider_task_id: "1", status: "completed" },
      }),
      ev({ event_type: "turn.completed", state: "completed", payload: {} }),
      ev({
        event_type: "work.item.updated",
        payload: { provider_task_id: "2", status: "completed" },
      }),
    ]);
    expect(p.frozen).toBe(true);
    expect(p.items).toHaveLength(1);
  });
});

describe("MAX_WORK_ITEMS: 超過は drop + count (observable)", () => {
  it("201 distinct item → items 200・dropped_count 1", () => {
    const events: NormalizedEvent[] = [];
    for (let i = 0; i < MAX_WORK_ITEMS + 1; i++) {
      events.push(
        ev({
          event_type: "work.item.updated",
          payload: { provider_task_id: String(i), status: "pending" },
        }),
      );
    }
    const p = reduce(events);
    expect(p.items).toHaveLength(MAX_WORK_ITEMS);
    expect(p.dropped_count).toBe(1);
  });

  it("既存 item の更新は上限に数えない", () => {
    const events: NormalizedEvent[] = [];
    for (let i = 0; i < MAX_WORK_ITEMS; i++) {
      events.push(
        ev({
          event_type: "work.item.updated",
          payload: { provider_task_id: String(i), status: "pending" },
        }),
      );
    }
    events.push(
      ev({
        event_type: "work.item.updated",
        payload: { provider_task_id: "0", status: "completed" },
      }),
    );
    const p = reduce(events);
    expect(p.items).toHaveLength(MAX_WORK_ITEMS);
    expect(p.dropped_count).toBe(0);
  });
});

describe("deriveWorkItemBadge (§D8): 4 状態 + 非 completed は undefined", () => {
  const base: WorkItem = {
    session_id: "s1",
    work_item_id: "task:x",
    id_scheme: "task",
    subject: undefined,
    status: "completed",
    ordinal: undefined,
    created_at: undefined,
    created_event_id: undefined,
    claimed_at: undefined,
    claim_event_id: undefined,
    claim_method: undefined,
    claim_fidelity: undefined,
    verification_state: "unverified",
    verified_at: undefined,
    verification_event_id: undefined,
    check_kind: undefined,
    check_match: undefined,
    check_exit_code: undefined,
    verified_tree_fp: undefined,
    run_dirty: false,
    stale_at: undefined,
    stale_event_id: undefined,
    updated_at: "t",
  };

  it("completed × 各 verification_state", () => {
    expect(deriveWorkItemBadge({ ...base, verification_state: "unverified" })).toBe("self_claimed");
    expect(deriveWorkItemBadge({ ...base, verification_state: "passed" })).toBe("verified");
    expect(deriveWorkItemBadge({ ...base, verification_state: "failed" })).toBe(
      "verification_failed",
    );
    expect(deriveWorkItemBadge({ ...base, verification_state: "stale" })).toBe(
      "changed_after_verification",
    );
    expect(deriveWorkItemBadge({ ...base, verification_state: "waived" })).toBeUndefined();
  });

  it("非 completed はバッジ無し", () => {
    for (const status of ["pending", "in_progress", "cancelled", "removed", "unknown"] as const) {
      expect(
        deriveWorkItemBadge({ ...base, status, verification_state: "passed" }),
      ).toBeUndefined();
    }
  });
});

describe("QA-4 (エッジ 3 ケース pin)", () => {
  it("空 plan snapshot (items:[]) は既存 plan item を全て removed 化する", () => {
    const p = reduce([
      ev({
        event_type: "turn.plan.updated",
        payload: {
          items: [
            { step: "a", status: "in_progress" },
            { step: "b", status: "pending" },
          ],
        },
      }),
      ev({ event_type: "turn.plan.updated", payload: { items: [] } }),
    ]);
    expect(p.items).toHaveLength(2);
    expect(p.items.every((i) => i.status === "removed")).toBe(true);
  });

  it("legacy steps-only (items 無し) は work item を生成せず skip する", () => {
    const p = reduce([
      ev({ event_type: "turn.plan.updated", payload: { plan: "do things", steps: ["a", "b"] } }),
    ]);
    expect(p.items).toHaveLength(0);
  });

  it("同一 event の二重適用は 1 item・claimed_at 安定 (冪等)", () => {
    const claim = ev({
      event_type: "work.item.updated",
      timestamp: ts(10),
      payload: { provider_task_id: "1", status: "completed" },
    });
    // 同一イベント (同 event_id・同 timestamp) を 2 回畳む。
    const p = reduceWorkItems("s1", [claim, claim]);
    expect(p.items).toHaveLength(1);
    expect(onlyTaskItem(p).claimed_at).toBe(ts(10));
  });
});

describe("TDA-3 (removed 意味論 pin): removed は claim/verification を保持 (撤回しない)", () => {
  it("completed+passed の plan item が snapshot から消えた → status=removed・verification_state=passed 保持", () => {
    const p = reduce([
      // fp を観測 (TDA-1 ガード) → plan item を completed 化 → 合格 check で passed。
      ev({ event_type: "diff.updated", payload: { head_sha: "h1", diff_hash: "d1" } }),
      ev({
        event_type: "turn.plan.updated",
        payload: { items: [{ step: "ship it", status: "completed" }] },
      }),
      ev({
        event_type: "command.completed",
        payload: { check_kind: "test", exit_code: 0, request_id: "r1" },
      }),
      // 次 snapshot から消える (絶えて listing されなくなった)。
      ev({
        event_type: "turn.plan.updated",
        payload: { items: [{ step: "other", status: "pending" }] },
      }),
    ]);
    const gone = itemById(p, deriveId("plan", "ship it"));
    expect(gone?.status).toBe("removed");
    // 撤回しない: 「消える前は passed だった」歴史を保持 (badge は status gate で非表示)。
    expect(gone?.verification_state).toBe("passed");
    expect(gone?.claimed_at).toBeDefined();
    expect(gone?.verified_tree_fp).toBeDefined();
    expect(deriveWorkItemBadge(gone!)).toBeUndefined(); // 全消費者は status gate 必須。
  });

  it("removed→再出現時は既存行を更新 claimed_at を継承 (新規作成しない)", () => {
    const claimTs = ts(5);
    const p = reduce([
      ev({
        event_type: "turn.plan.updated",
        timestamp: claimTs,
        payload: { items: [{ step: "x", status: "completed" }] },
      }),
      ev({ event_type: "turn.plan.updated", timestamp: ts(10), payload: { items: [] } }), // removed
      ev({
        event_type: "turn.plan.updated",
        timestamp: ts(15),
        payload: { items: [{ step: "x", status: "completed" }] },
      }), // 再出現
    ]);
    expect(p.items.filter((i) => i.id_scheme === "plan")).toHaveLength(1);
    const it = itemById(p, deriveId("plan", "x"))!;
    expect(it.status).toBe("completed");
    expect(it.claimed_at).toBe(claimTs); // 初 claim を継承。
  });
});

// テスト内で id を導出する (fold と同一の event-model 正準関数を使い、id 形の仮定を避ける)。
function deriveId(scheme: "task" | "plan", text: string): string {
  return deriveWorkItemId(scheme, text);
}
