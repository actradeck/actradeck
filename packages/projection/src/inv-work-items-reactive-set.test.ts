/**
 * INV-WORKITEM-REACTIVE-SET-COMPLETE (ADR 0015 §D4・TDA-A2-7・B1)。
 *
 * `WORK_ITEM_REACTIVE_EVENT_TYPES` (projection→backend gate の単一出所) が `applyWorkItemsEvent` の
 * switch と乖離しないことを、**全 EventType 走査**で回帰固定する: 反応する (= projection 参照が変わる)
 * event_type は必ず本集合に含まれる (`gate ⊇ reactive-set`)。将来 fold に反応 case を足して本配列の更新を
 * 忘れると、この metatest が RED になり backend gate の silent under-count drift を防ぐ。
 *
 * 手法: 全ハンドラを起動しうる rich payload を持つ合成イベントを、claim/tree_fp/pending-check を仕込んだ
 * projection へ適用し、参照が変われば「反応した」とみなす。terminal state による freeze は event_type と
 * 直交ゆえ非 terminal state で走査する (session.ended のみ event_type 起因の freeze で反応・集合に含む)。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { ALL_EVENT_TYPES, type NormalizedEvent } from "@actradeck/event-model";

import {
  applyWorkItemsEvent,
  reduceWorkItems,
  WORK_ITEM_REACTIVE_EVENT_TYPES,
  type WorkItemsProjection,
} from "./work-items.js";

const SID = "019a7bfb-9f7d-7bc3-b4a8-95fce7c4dbc4";

function ev(overrides: Partial<NormalizedEvent> & { event_type: string }): NormalizedEvent {
  return {
    event_id: `e-${overrides.event_type}-${Math.random().toString(36).slice(2)}`,
    session_id: SID,
    event_type: overrides.event_type,
    timestamp: overrides.timestamp ?? "2026-05-26T00:00:09.000Z",
    state: overrides.state ?? "running.model_wait",
    payload: overrides.payload ?? {},
    metrics: {},
  } as unknown as NormalizedEvent;
}

/** claim + tree_fp + pending check を仕込んだ projection (全ハンドラが反応しうる前提)。 */
function seededProjection(): WorkItemsProjection {
  return reduceWorkItems(SID, [
    ev({
      event_type: "turn.plan.updated",
      timestamp: "2026-05-26T00:00:01.000Z",
      state: "running.planning",
      payload: { items: [{ step: "seed step", status: "completed" }] },
    }),
    ev({
      event_type: "diff.updated",
      timestamp: "2026-05-26T00:00:02.000Z",
      payload: { diff_hash: "seed-diff-hash" },
    }),
    ev({
      event_type: "command.started",
      timestamp: "2026-05-26T00:00:03.000Z",
      payload: { check_kind: "test", request_id: "r1" },
    }),
  ]);
}

/**
 * 全ハンドラを起動しうる rich payload の合成イベント (event_type だけ差し替える)。
 *
 * ⚠️ TDA-B1-5 規律: この payload は **全反応ハンドラ (applyWorkItemsEvent の各 case) が読む field の
 *   superset** を維持しなければならない。ある case が新 field で反応するようになったのに、ここへ足し忘れると
 *   その case が本テスト内で「反応しない」ように見え、`gate ⊇ reactive-set` の走査から漏れて silent
 *   under-count drift を通してしまう。fold に新反応 field を足したら **必ず** ここへも足すこと (下の各 field
 *   は provider_task_id+observation=work.item.updated / items=turn.plan.updated /
 *   check_kind+exit_code+request_id=command.started/completed / diff_hash+head_sha=diff.updated に対応)。
 *   この宣言は下の TDA-B1R3-3 metatest が source introspection で機械検証する (宣言任せにしない)。
 */
function richEvent(eventType: string): NormalizedEvent {
  return ev({
    event_type: eventType,
    timestamp: "2026-05-26T00:00:09.000Z",
    payload: {
      provider_task_id: "task-1",
      status: "completed",
      subject: "s",
      observation: { method: "provider_jsonl", fidelity: "parsed" },
      items: [{ step: "another step", status: "completed" }],
      check_kind: "test",
      check_match: "program",
      exit_code: 0,
      request_id: "r1",
      diff_hash: "different-diff-hash",
      head_sha: "HEADSHA",
    },
  });
}

describe("INV-WORKITEM-REACTIVE-SET-COMPLETE", () => {
  const reactive = new Set(WORK_ITEM_REACTIVE_EVENT_TYPES);

  it("集合は重複なし・全て有効な EventType", () => {
    expect(WORK_ITEM_REACTIVE_EVENT_TYPES.length).toBe(reactive.size);
    for (const t of WORK_ITEM_REACTIVE_EVENT_TYPES) {
      expect((ALL_EVENT_TYPES as readonly string[]).includes(t)).toBe(true);
    }
  });

  it("反応する event_type (projection 参照が変わる) は必ず reactive-set に含まれる (gate ⊇ reactive)", () => {
    const changedTypes: string[] = [];
    for (const t of ALL_EVENT_TYPES as readonly string[]) {
      const seed = seededProjection();
      const next = applyWorkItemsEvent(seed, richEvent(t));
      if (next !== seed) changedTypes.push(t);
    }
    // 反応した全 type が集合に含まれる (集合外で反応する type が 1 つでもあれば fail = drift 検出)。
    for (const t of changedTypes) {
      expect(reactive.has(t)).toBe(true);
    }
    // 逆に集合の 5 switch case + session.ended は実際に反応する (dead entry でない・over-broad でない証)。
    // (session.ended は freeze で反応。terminal state 起因の freeze は別途 backend gate が OR 合成。)
    expect(changedTypes).toEqual(expect.arrayContaining([...WORK_ITEM_REACTIVE_EVENT_TYPES]));
  });

  // TDA-B2-3: sidecar は tool 実行で work.item.updated と tool.completed を二重 emit する (§D2)。
  // 二重カウント防止は「tool.completed が work item を一切触らない」ことに依存するため、全型走査に
  // 加えて明示 negative pin を置く (tool.completed を fold に足す変更は必ずここで意図を問われる)。
  it("TDA-B2-3: tool.completed は rich payload でも projection を変えない (二重 emit の negative pin)", () => {
    const seed = seededProjection();
    expect(applyWorkItemsEvent(seed, richEvent("tool.completed"))).toBe(seed);
  });

  // TDA-B1R3-3: richEvent の superset 性を宣言 (⚠️ TDA-B1-5 コメント) 任せにせず機械検証する。
  // fold が `payloadValue/payloadString(ev.payload, "<field>")` で読む top-level field 名を
  // work-items.ts ソースから抽出し、richEvent payload キー集合がその superset であることを assert。
  // これを欠くと「fold 反応 case + 新 field + richEvent 未更新」の三重脱落 (新 field でのみ反応する
  // 新 case が本テスト内で反応せず gate ⊇ reactive 走査から漏れる) が escape する。
  it("TDA-B1R3-3: richEvent payload は fold が読む全 top-level field の superset (source introspection)", () => {
    const src = readFileSync(fileURLToPath(new URL("./work-items.ts", import.meta.url)), "utf8");
    const fields = new Set<string>();
    for (const m of src.matchAll(/payload(?:Value|String)\(ev\.payload,\s*"([^"]+)"\)/g)) {
      fields.add(m[1]!);
    }
    // 抽出が壊れて空/激減したら本 metatest 自体を RED にする (helper 改名等での vacuous 化防止)。
    expect(fields.size).toBeGreaterThanOrEqual(8);
    const richKeys = new Set(
      Object.keys(richEvent("work.item.updated").payload as Record<string, unknown>),
    );
    for (const f of fields) {
      expect(richKeys.has(f), `fold が読む field "${f}" が richEvent payload に無い`).toBe(true);
    }
  });
});
