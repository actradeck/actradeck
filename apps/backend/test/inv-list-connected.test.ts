/**
 * INV-LIST-CONNECTED — DTO の connected(接続在席)充填契約 (ADR 019ea2bf).
 *
 * RealtimeStore は registry を知らない純 DB。server が注入する isLive 述語で各 DTO に
 * connected を被せる。本テストは偽 Pool + 偽 isLive で「isLive ⇔ connected」を赤化可能に固定。
 *
 * 二層モデルの直交も固定: connected=true(在席) ∧ liveness_state="idle"(無活動) が両立する
 * (起動中だが手が止まっている CC を消さない)。
 */
import { describe, expect, it } from "vitest";

import { RealtimeStore } from "../src/realtime-store.js";
import type { Pool } from "pg";

interface FakeRow {
  session_id: string;
  provider: string;
  source: string;
  agent_id: string | null;
  repo: string | null;
  branch: string | null;
  cwd: string | null;
  state: string | null;
  current_action: string | null;
  last_event_id: string | null;
  last_event_at: Date | null;
  needs_attention: boolean;
  liveness: Record<string, unknown> | null;
  pending_approvals: unknown;
}

function row(over: Partial<FakeRow> & { session_id: string }): FakeRow {
  return {
    provider: "claude_code",
    source: "hooks",
    agent_id: null,
    repo: null,
    branch: null,
    cwd: null,
    state: "running.model_wait",
    current_action: null,
    last_event_id: "e1",
    last_event_at: new Date("2026-06-07T00:00:00.000Z"),
    needs_attention: false,
    liveness: { state: "idle", stalled_suspected: false },
    pending_approvals: [],
    ...over,
  };
}

/** WHERE 句の $1 でフィルタ、無ければ全件返す偽 Pool。 */
function fakePool(rows: FakeRow[]): Pool {
  return {
    query: async (_sql: string, params?: unknown[]) => {
      if (params && params.length > 0 && typeof params[0] === "string") {
        return { rows: rows.filter((r) => r.session_id === params[0]) };
      }
      return { rows };
    },
  } as unknown as Pool;
}

describe("INV-LIST-CONNECTED", () => {
  it("listSnapshot: isLive=true の行は connected=true、false は connected=false", async () => {
    const store = new RealtimeStore(
      fakePool([row({ session_id: "live1" }), row({ session_id: "hist1" })]),
    );
    const liveSet = new Set(["live1"]);
    const items = await store.listSnapshot(500, (sid) => liveSet.has(sid));
    const byId = new Map(items.map((i) => [i.session_id, i]));
    expect(byId.get("live1")?.connected).toBe(true);
    expect(byId.get("hist1")?.connected).toBe(false);
  });

  it("listItem: connected が isLive を反映する", async () => {
    const store = new RealtimeStore(fakePool([row({ session_id: "s1" })]));
    expect((await store.listItem("s1", () => true))?.connected).toBe(true);
    expect((await store.listItem("s1", () => false))?.connected).toBe(false);
  });

  it("detail: connected が isLive を反映する(SessionDetail も二層を持つ)", async () => {
    const store = new RealtimeStore(fakePool([row({ session_id: "s1" })]));
    expect((await store.detail("s1", () => true))?.connected).toBe(true);
    expect((await store.detail("s1", () => false))?.connected).toBe(false);
  });

  it("既定 isLive(未注入)では connected=false(presence 不明=履歴扱い)", async () => {
    const store = new RealtimeStore(fakePool([row({ session_id: "s1" })]));
    const items = await store.listSnapshot(); // 述語未注入。
    expect(items[0]?.connected).toBe(false);
  });

  it("二層直交: connected=true ∧ liveness_state='idle' が両立(無活動でも在席)", async () => {
    const store = new RealtimeStore(
      fakePool([row({ session_id: "s1", liveness: { state: "idle", stalled_suspected: false } })]),
    );
    const item = (await store.listItem("s1", () => true))!;
    expect(item.connected).toBe(true); // 在席(membership)。
    expect(item.liveness_state).toBe("idle"); // 鮮度(status)= 無活動。
  });
});
