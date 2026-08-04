/**
 * INV-WORKITEMS-FOLD-PARITY (webui 側・ADR 0015 §D4/§D8・受入14).
 *
 * webui の client-side fold (`foldWorkItems` = ReplayEventDTO → replayDtoToEvent → projection
 * `reduceWorkItems`) が、同一イベント列に対する projection の `reduceWorkItems` と **完全一致**する
 * ことを pin する。
 *
 * ⚠️ **本テストが守る層 (正確な scope・裁定 R1 QA-B3-1 で訂正)**: ここは wire (ReplayEventsPage JSON) を
 *    **手作り** (`wireDto`) して `parseReplayEvent` → DTO → fold を通す。ゆえに本テストが load-bearing な
 *    のは **wire→DTO→fold** 経路 (`parseReplayEvent` / `parseWorkItemFields` / `replayDtoToEvent` の
 *    `dtoPayload`) が fold 入力フィールドを 1 つでも落とす回帰に対してのみ (該当時この等式が破れ RED)。
 *    **backend の `EVENT_COLUMNS` SQL carriage 層 (DB→EventRow→DTO) は本テストの走査外**であり、それは
 *    実 PG round-trip テスト `apps/backend/test/inv-work-items-wiring.test.ts` の "carriage round-trip"
 *    (ingest → `ReplayStore.eventsPage` → DTO fold parity + 非 home CASE gate) が守る。両テストの合成で
 *    「観測イベント → panel の work_items」全経路が回帰固定される (本番で panel が silent-empty になる退行を
 *    構造的に検出する)。
 *
 * 併せて deriveWorkItemBadge 単一出所 (webui で 4 状態を再実装しない) と plan_items の NO-RAW
 * 再射影 (余剰フィールドを wire parse で落とす) を固定する。
 */
import { deriveWorkItemBadge, reduceWorkItems, type WorkItem } from "@actradeck/projection";
import { newEventId, parseEvent, type NormalizedEvent } from "@actradeck/event-model";
import { describe, expect, it } from "vitest";

import { parseReplayEventsPage } from "../src/replay/parse-replay.js";
import { badgeDisplay, foldWorkItems } from "../src/ui/work-items-fold.js";

import type { ReplayEventDTO } from "../src/realtime/contract.js";

const SID = "s1";

interface WI {
  provider_task_id?: string;
  status?: string;
  subject?: string;
  method?: string;
  fidelity?: string;
  check_kind?: string;
  check_match?: string;
  exit_code?: number;
  request_id?: string;
  head_sha?: string;
  diff_hash?: string;
  plan_items?: { step: string; status: string }[];
}

interface Spec {
  readonly event_type: string;
  readonly ts: string;
  readonly state?: string;
  readonly wi: WI;
}

function ts(n: number): string {
  return new Date(Date.UTC(2026, 7, 4, 0, 0, 0) + n * 1000).toISOString();
}

/** canonical NormalizedEvent の payload (fold が読む形)。 */
function canonicalPayload(wi: WI): Record<string, unknown> {
  return {
    ...(wi.provider_task_id !== undefined ? { provider_task_id: wi.provider_task_id } : {}),
    ...(wi.status !== undefined ? { status: wi.status } : {}),
    ...(wi.subject !== undefined ? { subject: wi.subject } : {}),
    ...(wi.method !== undefined || wi.fidelity !== undefined
      ? {
          observation: {
            ...(wi.method !== undefined ? { method: wi.method } : {}),
            ...(wi.fidelity !== undefined ? { fidelity: wi.fidelity } : {}),
          },
        }
      : {}),
    ...(wi.check_kind !== undefined ? { check_kind: wi.check_kind } : {}),
    ...(wi.check_match !== undefined ? { check_match: wi.check_match } : {}),
    ...(wi.exit_code !== undefined ? { exit_code: wi.exit_code } : {}),
    ...(wi.request_id !== undefined ? { request_id: wi.request_id } : {}),
    ...(wi.head_sha !== undefined ? { head_sha: wi.head_sha } : {}),
    ...(wi.diff_hash !== undefined ? { diff_hash: wi.diff_hash } : {}),
    ...(wi.plan_items !== undefined ? { items: wi.plan_items } : {}),
  };
}

/** ReplayEventDTO wire 形 (backend allow-list carriage の等価物)。 */
function wireDto(id: string, s: Spec): Record<string, unknown> {
  const wi = s.wi;
  return {
    event_id: id,
    provider: "claude_code",
    source: "hooks",
    session_id: SID,
    event_type: s.event_type,
    kind: "other",
    timestamp: s.ts,
    display_text: "x",
    ...(s.state !== undefined ? { state: s.state } : {}),
    ...(wi.provider_task_id !== undefined ? { provider_task_id: wi.provider_task_id } : {}),
    ...(wi.status !== undefined ? { work_item_status: wi.status } : {}),
    ...(wi.subject !== undefined ? { work_item_subject: wi.subject } : {}),
    ...(wi.method !== undefined ? { observation_method: wi.method } : {}),
    ...(wi.fidelity !== undefined ? { observation_fidelity: wi.fidelity } : {}),
    ...(wi.check_kind !== undefined ? { check_kind: wi.check_kind } : {}),
    ...(wi.check_match !== undefined ? { check_match: wi.check_match } : {}),
    ...(wi.exit_code !== undefined ? { exit_code: wi.exit_code } : {}),
    ...(wi.request_id !== undefined ? { request_id: wi.request_id } : {}),
    ...(wi.head_sha !== undefined ? { head_sha: wi.head_sha } : {}),
    ...(wi.diff_hash !== undefined ? { diff_hash: wi.diff_hash } : {}),
    ...(wi.plan_items !== undefined ? { plan_items: wi.plan_items } : {}),
  };
}

function canonicalEvent(id: string, s: Spec): NormalizedEvent {
  return parseEvent({
    event_id: id,
    provider: "claude_code",
    source: "hooks",
    session_id: SID,
    event_type: s.event_type,
    ...(s.state !== undefined ? { state: s.state } : {}),
    timestamp: s.ts,
    payload: canonicalPayload(s.wi),
  });
}

/** wire → parseReplayEventsPage → DTO 列 (本番の webui 経路と同一)。 */
function dtosFromWire(specs: readonly Spec[], ids: readonly string[]): readonly ReplayEventDTO[] {
  const page = parseReplayEventsPage({
    session_id: SID,
    order: "timestamp_event_id_asc",
    events: specs.map((s, i) => wireDto(ids[i]!, s)),
    limit: 200,
    has_more: false,
  });
  if (page === null) throw new Error("wire page failed to parse");
  return page.events;
}

// 4 badge 全状態 + plan + run_dirty + reopen を貫く代表列 (projection の parity 列と同型)。
const SPECS: readonly Spec[] = [
  { event_type: "diff.updated", ts: ts(1), wi: { head_sha: "h1", diff_hash: "d1" } },
  {
    event_type: "work.item.updated",
    ts: ts(2),
    wi: {
      provider_task_id: "1",
      status: "completed",
      subject: "wire up parser",
      method: "official_hook",
      fidelity: "observed",
    },
  },
  {
    event_type: "turn.plan.updated",
    ts: ts(3),
    wi: { plan_items: [{ step: "ship it", status: "in_progress" }] },
  },
  {
    event_type: "command.started",
    ts: ts(4),
    wi: { check_kind: "test", check_match: "program", request_id: "r1" },
  },
  { event_type: "diff.updated", ts: ts(5), wi: { head_sha: "h2", diff_hash: "d2" } },
  {
    event_type: "command.completed",
    ts: ts(6),
    wi: { check_kind: "test", check_match: "program", exit_code: 0, request_id: "r1" },
  },
];

describe("INV-WORKITEMS-FOLD-PARITY (webui client fold == projection reduceWorkItems)", () => {
  const ids = SPECS.map(() => newEventId());

  it("同一イベント列で webui fold (wire→DTO→fold) == projection reduce", () => {
    const canonical = SPECS.map((s, i) => canonicalEvent(ids[i]!, s));
    const dtos = dtosFromWire(SPECS, ids);
    expect(foldWorkItems(SID, dtos)).toEqual(reduceWorkItems(SID, canonical));
  });

  it("foldWorkItems は決定的 (同一入力で 2 回一致)", () => {
    const dtos = dtosFromWire(SPECS, ids);
    expect(foldWorkItems(SID, dtos)).toEqual(foldWorkItems(SID, dtos));
  });

  it("carriage 由来の item が実データを畳む (panel が本番で常に空にならない回帰ガード)", () => {
    const dtos = dtosFromWire(SPECS, ids);
    const proj = foldWorkItems(SID, dtos);
    // task item (completed) + plan item (in_progress) の 2 件を観測する。
    expect(proj.items.length).toBe(2);
    const task = proj.items.find((i) => i.id_scheme === "task");
    expect(task?.status).toBe("completed");
    expect(task?.subject).toBe("wire up parser"); // subject carriage 貫通。
    expect(task?.claim_method).toBe("official_hook"); // observation carriage 貫通。
    expect(task?.claim_fidelity).toBe("observed");
  });
});

describe("deriveWorkItemBadge 単一出所 (webui で 4 状態を再実装しない)", () => {
  function badgeOf(specs: readonly Spec[]): {
    item: WorkItem;
    fold: ReturnType<typeof deriveWorkItemBadge>;
    display: ReturnType<typeof badgeDisplay>;
  } {
    const ids = specs.map(() => newEventId());
    const proj = foldWorkItems(SID, dtosFromWire(specs, ids));
    const item = proj.items.find((i) => i.id_scheme === "task")!;
    return { item, fold: deriveWorkItemBadge(item), display: badgeDisplay(item) };
  }

  it("self_claimed: completed + unverified", () => {
    const { item, fold, display } = badgeOf([
      {
        event_type: "work.item.updated",
        ts: ts(1),
        wi: { provider_task_id: "1", status: "completed" },
      },
    ]);
    expect(fold).toBe("self_claimed");
    expect(display?.badge).toBe("self_claimed"); // display は deriveWorkItemBadge を単一出所に使う。
    expect(display?.badge).toBe(deriveWorkItemBadge(item)); // QA-B3-3: 単一出所等価 (4 状態で固定)。
    expect(display?.labelKey).toBe("workitem.badge.self_claimed");
  });

  it("verified / verification_failed / changed_after_verification を fold 経路で導出", () => {
    const verified = badgeOf([
      { event_type: "diff.updated", ts: ts(1), wi: { head_sha: "h1", diff_hash: "d1" } },
      {
        event_type: "work.item.updated",
        ts: ts(2),
        wi: { provider_task_id: "1", status: "completed" },
      },
      {
        event_type: "command.completed",
        ts: ts(3),
        wi: { check_kind: "test", exit_code: 0, request_id: "r1" },
      },
    ]);
    expect(verified.fold).toBe("verified");
    expect(verified.display?.badge).toBe("verified");
    expect(verified.display?.badge).toBe(deriveWorkItemBadge(verified.item)); // QA-B3-3: 単一出所等価。

    const stale = badgeOf([
      { event_type: "diff.updated", ts: ts(1), wi: { head_sha: "h1", diff_hash: "d1" } },
      {
        event_type: "work.item.updated",
        ts: ts(2),
        wi: { provider_task_id: "1", status: "completed" },
      },
      {
        event_type: "command.completed",
        ts: ts(3),
        wi: { check_kind: "test", exit_code: 0, request_id: "r1" },
      },
      { event_type: "diff.updated", ts: ts(4), wi: { head_sha: "h2", diff_hash: "d2" } },
    ]);
    expect(stale.fold).toBe("changed_after_verification");
    // QA-B3-3: stale (changed_after_verification) も display?.badge == deriveWorkItemBadge(item)。
    expect(stale.display?.badge).toBe("changed_after_verification");
    expect(stale.display?.badge).toBe(deriveWorkItemBadge(stale.item));

    const failed = badgeOf([
      {
        event_type: "work.item.updated",
        ts: ts(1),
        wi: { provider_task_id: "1", status: "completed" },
      },
      {
        event_type: "command.completed",
        ts: ts(2),
        wi: { check_kind: "test", exit_code: 1, request_id: "r1" },
      },
    ]);
    expect(failed.fold).toBe("verification_failed");
    // QA-B3-3: failed (verification_failed) も display?.badge == deriveWorkItemBadge(item)。
    expect(failed.display?.badge).toBe("verification_failed");
    expect(failed.display?.badge).toBe(deriveWorkItemBadge(failed.item));
  });

  it("非 completed はバッジ無し (badgeDisplay undefined)", () => {
    const { display } = badgeOf([
      {
        event_type: "work.item.updated",
        ts: ts(1),
        wi: { provider_task_id: "1", status: "in_progress" },
      },
    ]);
    expect(display).toBeUndefined();
  });
});

describe("NO-RAW: plan_items は wire parse で {step,status} だけへ再射影 (余剰 raw を落とす)", () => {
  it("plan item の余剰フィールド (secret 様) が DTO に載らない", () => {
    const page = parseReplayEventsPage({
      session_id: SID,
      order: "timestamp_event_id_asc",
      events: [
        {
          event_id: newEventId(),
          provider: "claude_code",
          source: "hooks",
          session_id: SID,
          event_type: "turn.plan.updated",
          kind: "other",
          timestamp: ts(1),
          display_text: "x",
          plan_items: [{ step: "do it", status: "completed", secret: "AKIAIOSFODNN7EXAMPLE" }],
        },
      ],
      limit: 200,
      has_more: false,
    });
    expect(page).not.toBeNull();
    const dto = page!.events[0]!;
    expect(dto.plan_items).toEqual([{ step: "do it", status: "completed" }]);
    expect(JSON.stringify(dto.plan_items)).not.toContain("AKIA");
  });
});
