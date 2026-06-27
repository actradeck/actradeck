/**
 * WS 受信フレーム境界バリデータの契約テスト.
 * 壊れた/敵対的フレームを弾き、正規フレームを型安全に通すことを赤化可能に検証。
 */
import { describe, expect, it } from "vitest";

import type { SessionDetail, SessionListItem } from "../src/realtime/contract.js";
import { parseServerFrame } from "../src/realtime/parse-frame.js";

const listItem: SessionListItem = {
  session_id: "s1",
  provider: "claude_code",
  source: "hook",
  agent_id: undefined,
  repo: "actradeck",
  branch: "main",
  cwd: "/x",
  state: "running.tool",
  current_action: "bash: ls",
  last_event_at: "2026-06-04T00:00:00.000Z",
  needs_attention: false,
  liveness_state: "live",
  stalled_suspected: false,
  connected: true,
};

const detail: SessionDetail = {
  ...listItem,
  last_event_id: "e1",
  liveness_evidence: { event: { ageMs: 100, fresh: true } },
  liveness_reason: "fresh",
  liveness_evaluated_at_ms: 1,
  invalid_transition_count: 0,
  pending_approvals: [],
};

describe("parseServerFrame", () => {
  it("rejects malformed JSON", () => {
    expect(parseServerFrame("{not json")).toBeNull();
  });

  it("rejects unknown frame type", () => {
    expect(parseServerFrame(JSON.stringify({ type: "nope" }))).toBeNull();
  });

  it("rejects missing type", () => {
    expect(parseServerFrame(JSON.stringify({ sessions: [] }))).toBeNull();
  });

  it("parses snapshot.list with valid items", () => {
    const frame = parseServerFrame(JSON.stringify({ type: "snapshot.list", sessions: [listItem] }));
    expect(frame).not.toBeNull();
    expect(frame?.type).toBe("snapshot.list");
    if (frame?.type === "snapshot.list") expect(frame.sessions[0]?.session_id).toBe("s1");
  });

  /**
   * 回帰 (REAL DATA): backend `rowToListItem` (apps/backend/src/realtime-store.ts) が
   * 実際に出す SessionListItem の wire 形を固定する。`rowToListItem` は
   * agent_id/repo/branch 等が undefined のとき値を undefined にし、JSON.stringify が
   * これらキーを落とす。結果 wire には list の必須キー + 値ありの optional のみが乗り
   * **liveness_evidence / liveness_reason / liveness_evaluated_at_ms / invalid_transition_count
   * は含まれない** (それらは SessionDetail 専用 = T1 realtime-hub.ts)。
   *
   * この最小キー snapshot.list が `parseServerFrame` を通り sessions が空でないことを固定する。
   * isListItem が detail 専用フィールドを誤って必須化すると (front↔backend ドリフト)、
   * parseServerFrame が null を返し Cockpit が「観測中の session はありません」になる回帰を
   * このテストが赤化で捕まえる (decision 019e98fc)。
   */
  it("parses snapshot.list of real rowToListItem wire shape (no SessionDetail fields)", () => {
    // backend rowToListItem の出力を JSON 往復した形を再現 (undefined キーは落ちる)。
    const realWireItem = JSON.parse(
      JSON.stringify({
        session_id: "real-1",
        provider: "claude_code",
        source: "hook",
        agent_id: undefined,
        repo: undefined,
        branch: undefined,
        cwd: "/home/user/Files/ActraDeck",
        state: "running.tool",
        current_action: "bash: ls",
        last_event_at: "2026-06-06T00:00:00.000Z",
        needs_attention: false,
        liveness_state: "live",
        stalled_suspected: false,
      }),
    ) as Record<string, unknown>;

    // wire に detail 専用フィールドが乗っていないことを明示 (前提の固定)。
    expect("liveness_evidence" in realWireItem).toBe(false);
    expect("liveness_reason" in realWireItem).toBe(false);
    expect("liveness_evaluated_at_ms" in realWireItem).toBe(false);
    expect("invalid_transition_count" in realWireItem).toBe(false);
    // undefined optional はキーごと落ちている。
    expect("agent_id" in realWireItem).toBe(false);
    expect("repo" in realWireItem).toBe(false);

    const frame = parseServerFrame(
      JSON.stringify({ type: "snapshot.list", sessions: [realWireItem] }),
    );
    expect(frame).not.toBeNull();
    expect(frame?.type).toBe("snapshot.list");
    if (frame?.type === "snapshot.list") {
      expect(frame.sessions).toHaveLength(1);
      expect(frame.sessions[0]?.session_id).toBe("real-1");
    }
  });

  /**
   * 回帰 (LIVE-FOUND-3 / ADR 019ea2bf): 新フィールド `connected`(presence)を **必須化しない**。
   * backend rollout 差や被せ漏れで connected が欠落した snapshot.list でも全黙殺せず通し、
   * 値は欠落→true(表示寄り)に正規化する(証拠なしに起動中 CC を消さない)。
   */
  it("connected 欠落の snapshot.list を黙殺せず通し、欠落は true に正規化する", () => {
    const wireNoConnected = JSON.parse(
      JSON.stringify({ ...listItem, session_id: "noc-1", connected: undefined }),
    ) as Record<string, unknown>;
    expect("connected" in wireNoConnected).toBe(false); // undefined キーは落ちている。

    const frame = parseServerFrame(
      JSON.stringify({ type: "snapshot.list", sessions: [wireNoConnected] }),
    );
    expect(frame).not.toBeNull();
    if (frame?.type === "snapshot.list") {
      expect(frame.sessions).toHaveLength(1);
      expect(frame.sessions[0]?.connected).toBe(true); // 欠落→表示寄り。
    }
  });

  it("connected=false は delta.list でそのまま保持される", () => {
    const frame = parseServerFrame(
      JSON.stringify({ type: "delta.list", session: { ...listItem, connected: false } }),
    );
    expect(frame).not.toBeNull();
    if (frame?.type === "delta.list") expect(frame.session.connected).toBe(false);
  });

  it("rejects snapshot.list item with type-violating required key (needs_attention non-boolean)", () => {
    const bad = {
      type: "snapshot.list",
      sessions: [{ ...listItem, needs_attention: "yes" }],
    };
    expect(parseServerFrame(JSON.stringify(bad))).toBeNull();
  });

  it("rejects snapshot.list whose item misses required keys", () => {
    const bad = { type: "snapshot.list", sessions: [{ session_id: "s1" }] };
    expect(parseServerFrame(JSON.stringify(bad))).toBeNull();
  });

  it("rejects snapshot.list when sessions is not an array", () => {
    expect(parseServerFrame(JSON.stringify({ type: "snapshot.list", sessions: "x" }))).toBeNull();
  });

  it("parses delta.list", () => {
    const frame = parseServerFrame(JSON.stringify({ type: "delta.list", session: listItem }));
    expect(frame?.type).toBe("delta.list");
  });

  it("parses snapshot.detail and delta.detail", () => {
    const snap = parseServerFrame(
      JSON.stringify({ type: "snapshot.detail", session_id: "s1", detail }),
    );
    expect(snap?.type).toBe("snapshot.detail");
    const d = parseServerFrame(JSON.stringify({ type: "delta.detail", session_id: "s1", detail }));
    expect(d?.type).toBe("delta.detail");
  });

  it("rejects detail missing liveness_evidence", () => {
    const bad = {
      type: "snapshot.detail",
      session_id: "s1",
      detail: {
        ...listItem,
        liveness_reason: "x",
        liveness_evaluated_at_ms: 1,
        invalid_transition_count: 0,
      },
    };
    expect(parseServerFrame(JSON.stringify(bad))).toBeNull();
  });

  // ADR 019e9999 段階②: pending_approvals 最小構造検証 (敵対/壊れフレーム耐性)。
  it("rejects detail whose pending_approvals is missing", () => {
    const { pending_approvals: _omit, ...noPending } = detail;
    const bad = { type: "snapshot.detail", session_id: "s1", detail: noPending };
    expect(parseServerFrame(JSON.stringify(bad))).toBeNull();
  });

  it("rejects detail whose pending_approvals is not an array", () => {
    const bad = {
      type: "snapshot.detail",
      session_id: "s1",
      detail: { ...detail, pending_approvals: "nope" },
    };
    expect(parseServerFrame(JSON.stringify(bad))).toBeNull();
  });

  it("rejects detail whose pending_approval entry lacks request_id:string", () => {
    const bad = {
      type: "snapshot.detail",
      session_id: "s1",
      detail: { ...detail, pending_approvals: [{ tool_name: "Bash" }] },
    };
    expect(parseServerFrame(JSON.stringify(bad))).toBeNull();
  });

  it("parses detail carrying a valid pending_approval (redacted command only)", () => {
    const withPending = {
      type: "snapshot.detail",
      session_id: "s1",
      detail: {
        ...detail,
        pending_approvals: [
          {
            request_id: "req-1",
            tool_name: "Bash",
            command: "pnpm test",
            risk_level: "medium",
            requested_at: "2026-06-05T00:00:00.000Z",
            session_id: "s1",
          },
        ],
      },
    };
    const frame = parseServerFrame(JSON.stringify(withPending));
    expect(frame?.type).toBe("snapshot.detail");
    if (frame?.type === "snapshot.detail") {
      expect(frame.detail.pending_approvals).toHaveLength(1);
      expect(frame.detail.pending_approvals[0]?.request_id).toBe("req-1");
    }
  });

  // 自動ガード 段階1 (ADR 019ecc70 D3): pending_approval に additive optional な
  // trigger / secret_kinds が乗っても寛容に透過し (parse-frame は過剰検証しない)、欠落フレームも
  // 後方互換で受理する (旧 sidecar/backend と混在し得る)。
  it("preserves additive trigger / secret_kinds on pending_approval (forward-compat)", () => {
    const withGuard = {
      type: "snapshot.detail",
      session_id: "s1",
      detail: {
        ...detail,
        pending_approvals: [
          {
            request_id: "req-g",
            tool_name: "Bash",
            command: "deploy.sh",
            risk_level: "high",
            requested_at: "2026-06-05T00:00:00.000Z",
            session_id: "s1",
            trigger: "secret",
            secret_kinds: ["github-token"],
          },
        ],
      },
    };
    const frame = parseServerFrame(JSON.stringify(withGuard));
    expect(frame?.type).toBe("snapshot.detail");
    if (frame?.type === "snapshot.detail") {
      const a = frame.detail.pending_approvals[0];
      expect(a?.request_id).toBe("req-g");
      // 構造検証は最小 (request_id) のみ。追加フィールドは破棄せず透過する。
      expect(a?.trigger).toBe("secret");
      expect(a?.secret_kinds).toEqual(["github-token"]);
    }
  });

  it("accepts pending_approval missing trigger / secret_kinds (backward-compat)", () => {
    const noGuard = {
      type: "snapshot.detail",
      session_id: "s1",
      detail: {
        ...detail,
        pending_approvals: [
          {
            request_id: "req-old",
            requested_at: "2026-06-05T00:00:00.000Z",
            session_id: "s1",
          },
        ],
      },
    };
    const frame = parseServerFrame(JSON.stringify(noGuard));
    expect(frame?.type).toBe("snapshot.detail");
    if (frame?.type === "snapshot.detail") {
      const a = frame.detail.pending_approvals[0];
      expect(a?.request_id).toBe("req-old");
      expect(a?.trigger).toBeUndefined();
      expect(a?.secret_kinds).toBeUndefined();
    }
  });

  it("parses ack and preserves optional fields", () => {
    const frame = parseServerFrame(
      JSON.stringify({
        type: "ack",
        action: "approve",
        ok: false,
        session_id: "s1",
        request_id: "r1",
        error: "x",
      }),
    );
    expect(frame?.type).toBe("ack");
    if (frame?.type === "ack") {
      expect(frame.ok).toBe(false);
      expect(frame.session_id).toBe("s1");
      expect(frame.error).toBe("x");
    }
  });

  it("rejects ack with invalid action", () => {
    expect(parseServerFrame(JSON.stringify({ type: "ack", action: "boom", ok: true }))).toBeNull();
  });

  it("rejects ack with non-boolean ok", () => {
    expect(
      parseServerFrame(JSON.stringify({ type: "ack", action: "subscribe", ok: "yes" })),
    ).toBeNull();
  });
});
