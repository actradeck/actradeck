/**
 * INV-DETAIL-CAPTURE-BADGE (backend 投影部) — ADR 019ea4ba D4 / TDA-1 (019ea49a-0f21).
 *
 * sessions.capture_mode 列 → realtime-store JOIN_SELECT → SessionListItem/SessionDetail への投影を
 * 偽 Pool で固定する (UI バッジの出所)。寛容性: 欠落 (NULL) / 未知値はキーごと落とす
 * (= undefined; UI 側で managed 既定扱い)。projection key には使わない。
 *
 * REAL DATA: 投影形は realtime-hub.SessionListItem.capture_mode (optional "managed"|"attach") の
 * wire 契約に一致させる。生 payload には触れない (backend は再 redaction しない)。
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
  capture_mode: string | null;
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
    capture_mode: null,
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

describe("INV-DETAIL-CAPTURE-BADGE: capture_mode 投影", () => {
  it('capture_mode="attach" を ListItem / Detail へ投影する', async () => {
    const store = new RealtimeStore(fakePool([row({ session_id: "s1", capture_mode: "attach" })]));
    expect((await store.listItem("s1"))?.capture_mode).toBe("attach");
    expect((await store.detail("s1"))?.capture_mode).toBe("attach");
  });

  it('capture_mode="managed" をそのまま投影する', async () => {
    const store = new RealtimeStore(fakePool([row({ session_id: "s1", capture_mode: "managed" })]));
    expect((await store.listItem("s1"))?.capture_mode).toBe("managed");
  });

  it("NULL (欠落) はキーを落とす (undefined; UI 側 managed 既定・projection key 非使用)", async () => {
    const store = new RealtimeStore(fakePool([row({ session_id: "s1", capture_mode: null })]));
    const item = await store.listItem("s1");
    expect(item).toBeDefined();
    expect(item!.capture_mode).toBeUndefined();
    // 欠落でも行自体は黙殺しない (LIVE-FOUND-3 寛容性)。
    expect(item!.session_id).toBe("s1");
  });

  it("未知値はキーを落とす (寛容; 不正値で UI を壊さない)", async () => {
    const store = new RealtimeStore(
      fakePool([row({ session_id: "s1", capture_mode: "bogus-mode" })]),
    );
    expect((await store.detail("s1"))?.capture_mode).toBeUndefined();
  });
});
