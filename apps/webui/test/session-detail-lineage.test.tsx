/**
 * SessionDetailView の run lineage メタ描画契約 (ADR 0014 Phase 3c・decision 019fd250)。
 *
 *  - lineage 素材が 1 つも無ければセクション自体を描かない (attach 大半 = 何も主張しない・
 *    over-claim 防止 TDA-3。「連結不明」を常設ラベルにしない)。
 *  - continued-from は resolved / linked-unknown を data-kind で区別し、short id を表示。
 *  - continuation は resolveContinuation の resolved 値 1 つのみ (stored と derived を並記しない)。
 *  - run 系譜チェーンは 2 run 以上のとき短縮 id 連結 + 自 run をマーク。
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { SessionDetailView } from "../src/ui/SessionDetail.js";

import type { SessionDetail } from "../src/realtime/contract.js";

function detail(over: Partial<SessionDetail> = {}): SessionDetail {
  return {
    session_id: "sess-child0000001",
    provider: "codex",
    source: "app_server",
    agent_id: undefined,
    repo: undefined,
    branch: undefined,
    cwd: undefined,
    state: "suspended",
    current_action: undefined,
    last_event_at: "2026-08-05T00:00:00.000Z",
    needs_attention: false,
    liveness_state: "unknown",
    stalled_suspected: false,
    connected: false,
    last_event_id: "e1",
    liveness_evidence: {},
    liveness_reason: "",
    liveness_evaluated_at_ms: 0,
    invalid_transition_count: 0,
    pending_approvals: [],
    ...over,
  };
}

describe("SessionDetailView run lineage メタ (Phase 3c)", () => {
  it("lineage 素材が無ければセクションを描かない (何も主張しない)", () => {
    const html = renderToStaticMarkup(
      createElement(SessionDetailView, {
        detail: detail({ state: "running.command_executing" }),
        loading: false,
      }),
    );
    expect(html).not.toContain('data-testid="detail-lineage"');
  });

  it("resolved な continued-from + 各軸を描画する (short id / enum 値)", () => {
    const html = renderToStaticMarkup(
      createElement(SessionDetailView, {
        detail: detail({
          provider_session_id: "conv-1",
          start_kind: "resume",
          resumed_from_session_id: "sess-parent000001",
          resumed_from_observed: true,
          end_kind: "unloaded",
          recoverability: "resumable",
          last_turn_outcome: "completed",
          lineage_runs: [
            { session_id: "sess-parent000001", start_kind: "fresh" },
            { session_id: "sess-child0000001", start_kind: "resume" },
          ],
        }),
        loading: false,
      }),
    );
    expect(html).toContain('data-testid="detail-lineage"');
    expect(html).toContain('data-testid="lineage-start-kind"');
    expect(html).toContain("resume");
    expect(html).toContain('data-kind="resolved"');
    // short id (12 桁) で表示。
    expect(html).toContain("sess-parent0");
    expect(html).toContain('data-testid="lineage-end-kind"');
    expect(html).toContain("unloaded");
    // continuation は resolved 値 1 つ (stored=resumable)。
    expect(html).toMatch(/data-testid="lineage-continuation"[^>]*>resumable</);
    expect(html).toMatch(/data-testid="lineage-last-turn"[^>]*>completed</);
    // 系譜チェーン: 自 run をマークして連結 (short id = 12 桁)。
    expect(html).toContain('data-testid="lineage-runs"');
    expect(html).toContain("sess-parent0 → [sess-child00]");
  });

  it("未観測の宣言参照は linked-unknown を明示 (観測済みと偽らない)", () => {
    const html = renderToStaticMarkup(
      createElement(SessionDetailView, {
        detail: detail({
          start_kind: "resume",
          resumed_from_session_id: "sess-unseen00001",
          resumed_from_observed: false,
        }),
        loading: false,
      }),
    );
    expect(html).toContain('data-kind="linked-unknown"');
    // 既定 locale (ja) の文言で「宣言参照・未観測」を明示する。
    expect(html).toContain("連結不明（宣言参照・未観測）");
  });

  it("self-loop (resumed_from == 自 id) はエッジを描かない", () => {
    const html = renderToStaticMarkup(
      createElement(SessionDetailView, {
        detail: detail({
          start_kind: "resume",
          resumed_from_session_id: "sess-child0000001",
          resumed_from_observed: false,
        }),
        loading: false,
      }),
    );
    expect(html).not.toContain('data-testid="lineage-continued-from"');
    // start_kind はあるのでセクション自体は出る。
    expect(html).toContain('data-testid="detail-lineage"');
  });

  it("TDA-4 実例: stored=not_resumable が derived('failed')=unknown に勝って表示される", () => {
    const html = renderToStaticMarkup(
      createElement(SessionDetailView, {
        detail: detail({
          state: "failed",
          end_kind: "failed",
          recoverability: "not_resumable",
        }),
        loading: false,
      }),
    );
    expect(html).toMatch(/data-testid="lineage-continuation"[^>]*>not_resumable</);
    expect(html).not.toMatch(/data-testid="lineage-continuation"[^>]*>unknown</);
  });
});
