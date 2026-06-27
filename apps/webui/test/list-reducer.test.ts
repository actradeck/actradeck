/**
 * 一覧 reducer の契約テスト: snapshot 置換 / delta upsert / purge / 表示 sort.
 * 「live は purge しない」「needs_attention 上」など KPI 表示順を赤化可能に固定。
 */
import { describe, expect, it } from "vitest";

import {
  applyListDelta,
  applySnapshotList,
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
