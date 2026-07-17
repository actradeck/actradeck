/**
 * 一覧 reducer の契約テスト: snapshot 置換 / delta upsert / purge / 表示 sort.
 * 「live は purge しない」「needs_attention 上」など KPI 表示順を赤化可能に固定。
 */
import { describe, expect, it } from "vitest";

import {
  applyListDelta,
  applySnapshotList,
  presenceCounts,
  purgeStale,
  toDisplayList,
} from "../src/realtime/list-reducer.js";

import type { SessionListItem } from "../src/realtime/contract.js";

function mk(id: string, over: Partial<SessionListItem> = {}): SessionListItem {
  return {
    session_id: id,
    provider: "claude_code",
    source: "hook",
    agent_id: undefined,
    repo: undefined,
    branch: undefined,
    cwd: undefined,
    state: undefined,
    current_action: undefined,
    last_event_at: undefined,
    needs_attention: false,
    liveness_state: "unknown",
    stalled_suspected: false,
    connected: false, // 既定は履歴扱い(purge/フィルタ対象になり得る)。在席は各テストで明示。
    ...over,
  };
}

describe("list reducer", () => {
  it("snapshot replaces the whole list", () => {
    const s1 = applySnapshotList([mk("a"), mk("b")]);
    expect([...s1.items.keys()].sort()).toEqual(["a", "b"]);
    const s2 = applySnapshotList([mk("c")]);
    expect([...s2.items.keys()]).toEqual(["c"]); // old entries gone
  });

  it("delta upserts a single session", () => {
    let s = applySnapshotList([mk("a", { current_action: "old" })]);
    s = applyListDelta(s, mk("a", { current_action: "new" }));
    expect(s.items.get("a")?.current_action).toBe("new");
    s = applyListDelta(s, mk("b"));
    expect(s.items.size).toBe(2);
  });

  it("purge drops stale non-live but never drops live", () => {
    const now = Date.parse("2026-06-04T01:00:00.000Z");
    const old = "2026-06-04T00:00:00.000Z"; // 1h old
    const s = applySnapshotList([
      mk("live", { liveness_state: "live", last_event_at: old }),
      mk("stale", { liveness_state: "stalled", last_event_at: old }),
      mk("unknown-noevent", { liveness_state: "unknown" }), // no last_event_at → keep
    ]);
    const purged = purgeStale(s, { nowMs: now, maxIdleMs: 600_000 });
    expect(purged.items.has("live")).toBe(true); // live never purged
    expect(purged.items.has("stale")).toBe(false); // dropped
    expect(purged.items.has("unknown-noevent")).toBe(true); // no evidence → kept
  });

  it("purge keeps recent non-live within window", () => {
    const now = Date.parse("2026-06-04T00:05:00.000Z");
    const recent = "2026-06-04T00:00:00.000Z"; // 5m old, within 10m window
    const s = applySnapshotList([mk("x", { liveness_state: "idle", last_event_at: recent })]);
    expect(purgeStale(s, { nowMs: now }).items.has("x")).toBe(true);
  });

  // --- INV: connected(接続在席) の purge 免除と表示フィルタ (ADR 019ea2bf) ---
  it("purge: connected=true は無活動(idle)で古くても消さない", () => {
    const now = Date.parse("2026-06-04T02:00:00.000Z");
    const old = "2026-06-04T00:00:00.000Z"; // 2h old
    const s = applySnapshotList([
      mk("live-conn", { connected: true, liveness_state: "idle", last_event_at: old }),
      mk("hist-idle", { connected: false, liveness_state: "idle", last_event_at: old }),
    ]);
    const purged = purgeStale(s, { nowMs: now, maxIdleMs: 600_000 });
    expect(purged.items.has("live-conn")).toBe(true); // 起動中(在席)は消さない。
    expect(purged.items.has("hist-idle")).toBe(false); // 履歴の古い idle は落とす。
  });

  it("display 既定: connected=true のみ表示、showHistory で全件", () => {
    const s = applySnapshotList([
      mk("a", { connected: true, last_event_at: "2026-06-04T00:01:00.000Z" }),
      mk("b", { connected: false, last_event_at: "2026-06-04T00:02:00.000Z" }),
    ]);
    expect(toDisplayList(s).map((x) => x.session_id)).toEqual(["a"]); // 既定=接続在席のみ。
    expect(
      toDisplayList(s, { showHistory: true })
        .map((x) => x.session_id)
        .sort(),
    ).toEqual(["a", "b"]); // 履歴含む全件。
  });

  // --- INV: external adapter の recency proxy (ADR 019f474e) ---
  // external(source==="external")は WS を張れず connected=false になるため、直近 active を
  // presence の代理として既定表示に含める。managed/attach(非 external)の !connected は不変で除外。
  describe("external recency proxy (ADR 019f474e)", () => {
    const NOW = Date.parse("2026-07-09T00:10:00.000Z");
    const isoAgo = (msAgo: number) => new Date(NOW - msAgo).toISOString();

    it("toDisplayList 既定: external-recent を出す / stale-external を出さない / managed-disconnect を出さない", () => {
      const s = applySnapshotList([
        mk("ext-recent", { source: "external", connected: false, last_event_at: isoAgo(30_000) }),
        mk("ext-stale", { source: "external", connected: false, last_event_at: isoAgo(300_000) }),
        mk("managed-disc", { source: "hooks", connected: false, last_event_at: isoAgo(1_000) }),
        mk("connected", { source: "hooks", connected: true, last_event_at: isoAgo(1_000) }),
      ]);
      const ids = new Set(toDisplayList(s, { nowMs: NOW }).map((x) => x.session_id));
      expect(ids.has("ext-recent")).toBe(true); // external-recent は presence 代理で出す。
      expect(ids.has("ext-stale")).toBe(false); // 閾値超過の external は出さない。
      expect(ids.has("managed-disc")).toBe(false); // 非 external の !connected は不変で除外。
      expect(ids.has("connected")).toBe(true); // 接続在席は当然出す。
    });

    it("toDisplayList 既定: terminal external (session.ended→completed) は recent でも出さない (ADR 019f4c19 wall-ended-badge)", () => {
      // 実機バグ (2026-07-10 gemini): session.ended→completed の external が last_event_at 直近ゆえ
      // 既定一覧に緑 ✓LIVE で残った。terminal は「動いているもの」でない → 既定から落とす。
      const s = applySnapshotList([
        mk("ext-ended", {
          source: "external",
          connected: false,
          state: "completed",
          last_event_at: isoAgo(30_000), // 窓内だが terminal
        }),
        mk("ext-active", {
          source: "external",
          connected: false,
          state: "running.command_executing",
          last_event_at: isoAgo(30_000), // 窓内 ∧ 非 terminal → 出る (非退行)
        }),
      ]);
      const ids = new Set(toDisplayList(s, { nowMs: NOW }).map((x) => x.session_id));
      expect(ids.has("ext-ended")).toBe(false); // terminal external は既定一覧から落ちる。
      expect(ids.has("ext-active")).toBe(true); // 活動中 external は従来通り出る。
      // showHistory=true では履歴として残る (session 一覧/replay 到達性)。
      const hist = new Set(
        toDisplayList(s, { showHistory: true, nowMs: NOW }).map((x) => x.session_id),
      );
      expect(hist.has("ext-ended")).toBe(true);
    });

    it("toDisplayList showHistory=true は全件表示 (external の recency に関わらず不変)", () => {
      const s = applySnapshotList([
        mk("ext-stale", { source: "external", connected: false, last_event_at: isoAgo(300_000) }),
        mk("managed-disc", { source: "hooks", connected: false, last_event_at: isoAgo(1_000) }),
      ]);
      const ids = toDisplayList(s, { showHistory: true, nowMs: NOW })
        .map((x) => x.session_id)
        .sort();
      expect(ids).toEqual(["ext-stale", "managed-disc"]); // 履歴含む全件。
    });

    it("purgeStale は external-recent を消さない (recency proxy 免除・purge 窓を WALL_RECENT_MS 未満に絞っても)", () => {
      // 免除を falsifiable にするため maxIdleMs(15s) < WALL_RECENT_MS(120s) の窓で検証する:
      //  - ext-within: age 60s は maxIdleMs 超過ゆえ免除が無ければ purge されるが、WALL_RECENT_MS 内
      //    (isPresentOrRecentlyActive=true)なので免除で残る (表示中の external を消さない)。
      //  - ext-beyond: age 200s は WALL_RECENT_MS も超過 → 免除対象外で通常 purge。
      const s = applySnapshotList([
        mk("ext-within", {
          source: "external",
          connected: false,
          liveness_state: "idle",
          last_event_at: isoAgo(60_000), // 60s: maxIdleMs 超・WALL_RECENT_MS 内
        }),
        mk("ext-beyond", {
          source: "external",
          connected: false,
          liveness_state: "idle",
          last_event_at: isoAgo(200_000), // 200s: WALL_RECENT_MS も超過
        }),
      ]);
      const purged = purgeStale(s, { nowMs: NOW, maxIdleMs: 15_000 });
      expect(purged.items.has("ext-within")).toBe(true); // 表示中の external は purge 窓を絞っても残す。
      expect(purged.items.has("ext-beyond")).toBe(false); // WALL_RECENT_MS 超過の external は通常 purge。
    });
  });

  it("display sort: needs_attention first, then newest last_event_at", () => {
    const s = applySnapshotList([
      mk("calm-old", { last_event_at: "2026-06-04T00:00:00.000Z" }),
      mk("calm-new", { last_event_at: "2026-06-04T00:10:00.000Z" }),
      mk("hot", { needs_attention: true, last_event_at: "2026-06-04T00:00:00.000Z" }),
    ]);
    // sort の関心のみ検証するため履歴含む全件で(connected フィルタは別テスト)。
    const order = toDisplayList(s, { showHistory: true }).map((x) => x.session_id);
    expect(order[0]).toBe("hot"); // attention wins
    expect(order[1]).toBe("calm-new"); // newer before older
    expect(order[2]).toBe("calm-old");
  });
});

/**
 * INV(headline KPI): Live / Running を **presence 母集合(connected!==false)** の単一述語で数え、
 * `toDisplayList` の表示集合(showHistory トグルで全件へ膨らむ)から切り離す。終端イベント未達で
 * running.* に固着した履歴(connected:false)を「現在稼働(Running)」に数えない — 「Running 94」の核心。
 * mutation で赤: presenceCounts の `if (s.connected === false) continue;` を外すと、固着履歴テストの
 * running が 1→91 に膨らみ RED。
 */
describe("presenceCounts (KPI: Live/Running を presence 母集合で・トグル非依存・固着履歴を除外)", () => {
  it("Live=connected!==false, Running=その中の running.* を数える", () => {
    const s = applySnapshotList([
      mk("live-run", { connected: true, state: "running.model_streaming" }),
      mk("live-idle", { connected: true, state: "idle" }),
      mk("live-run2", { connected: true, state: "running.command_executing" }),
    ]);
    expect(presenceCounts(s.items.values())).toEqual({ live: 3, running: 2 });
  });

  it("connected===undefined は在席寄り(LIVE-FOUND-3 寛容性)で Live/Running に数える", () => {
    const s = applySnapshotList([mk("u", { connected: undefined, state: "running.tool" })]);
    expect(presenceCounts(s.items.values())).toEqual({ live: 1, running: 1 });
  });

  it("固着した履歴 running (connected:false, running.model_wait) を Live/Running どちらにも数えない [Running 94 の核心]", () => {
    const s = applySnapshotList([
      mk("live", { connected: true, state: "running.model_streaming" }),
      // 終端イベント未達で running に固着した過去 session を 90 件 (connected:false=非在席)。
      ...Array.from({ length: 90 }, (_, i) =>
        mk(`stale-${i}`, { connected: false, state: "running.model_wait" }),
      ),
    ]);
    const c = presenceCounts(s.items.values());
    // presence は live 1 件のみ。running も 1 (固着履歴 90 は数えない)。旧バグなら running=91 だった。
    expect(c).toEqual({ live: 1, running: 1 });
    expect(c.running).not.toBe(91);
  });

  it("running は必ず live の部分集合 (同一 presence 述語)", () => {
    const s = applySnapshotList([
      mk("a", { connected: true, state: "running.tool" }),
      mk("b", { connected: true, state: "waiting.approval" }),
      mk("c", { connected: false, state: "running.tool" }), // 履歴 running は除外
    ]);
    const c = presenceCounts(s.items.values());
    expect(c.running).toBeLessThanOrEqual(c.live);
    expect(c).toEqual({ live: 2, running: 1 });
  });

  it("稼働中の external-recent (source:external, connected:false, running.*) は Live/Running に数えない (QA-2・意図)", () => {
    // external adapter は presence を構造的に持てず connected:false。recency proxy で Wall/既定リストには
    // *稼働中* 表示され得るが、headline Running には数えない (Live も external を数えない=整合)。
    const s = applySnapshotList([
      mk("ext", { source: "external", connected: false, state: "running.model_streaming" }),
    ]);
    expect(presenceCounts(s.items.values())).toEqual({ live: 0, running: 0 });
  });
});
