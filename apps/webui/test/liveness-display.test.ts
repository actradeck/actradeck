/**
 * INV-STALLED-UI (QA-1): liveness の **表示派生** が「停止を断定しない」原則を保つ契約。
 * frontend.md: 観測されている作業状態を表示し、UI 側で backend の合成以上に停止を断定しない。
 * heartbeat 分解 (process/event/stdout/file/model-stream) を単一シグナルに潰さず保つ。
 */
import { describe, expect, it } from "vitest";

import type { SessionDetail, SessionListItem } from "../src/realtime/contract.js";
import {
  effectiveLivenessState,
  heartbeatRows,
  LIVE_FRESH_MS,
  livenessBadge,
  needsOperator,
  waitingKind,
} from "../src/ui/liveness-display.js";

function listItem(o: Partial<SessionListItem> = {}): SessionListItem {
  return {
    session_id: "s1",
    provider: "claude_code",
    source: "hooks",
    agent_id: undefined,
    repo: undefined,
    branch: undefined,
    cwd: undefined,
    state: "running.model_wait",
    current_action: undefined,
    last_event_at: undefined,
    needs_attention: false,
    liveness_state: "live",
    stalled_suspected: false,
    connected: true,
    ...o,
  };
}

describe("livenessBadge", () => {
  it("maps live/idle/unknown to non-assertive labels", () => {
    expect(livenessBadge("live", false).label).toBe("LIVE");
    expect(livenessBadge("idle", false).label).toBe("IDLE");
    expect(livenessBadge("unknown", false).label).toBe("UNKNOWN");
    expect(livenessBadge("live", false).tone).toBe("ok");
  });

  it("offline は接続不在の事実を OFFLINE として出す (停止断定でなく接続の有無)", () => {
    // 切断/履歴セッションに UNKNOWN を出さない (ユーザー報告: 停止中が UNKNOWN は誤り)。
    expect(livenessBadge("offline", false).label).toBe("OFFLINE");
    expect(livenessBadge("offline", false).label).not.toBe("UNKNOWN");
    expect(livenessBadge("offline", false).tone).toBe("muted");
  });

  it("INV-STALLED-UI: stalled は常に suspected 表記で、UI が停止を断定しない", () => {
    // backend が suspected を立てているケース。
    expect(livenessBadge("stalled", true).label).toBe("STALLED?");
    // backend が (将来) suspected=false を出しても UI は断定形 "STALLED" を **足さない**。
    expect(livenessBadge("stalled", false).label).toBe("STALLED?");
    // 断定形 "STALLED" (末尾 ? 無し) を返さないことを明示的に固定する。
    expect(livenessBadge("stalled", false).label).not.toBe("STALLED");
    expect(livenessBadge("stalled", true).tone).toBe("warn");
  });
});

describe("effectiveLivenessState: 表示時の鮮度補正 (凍結 live を now 基準で降格)", () => {
  const NOW = Date.parse("2026-06-24T00:10:00.000Z");
  const isoAgo = (msAgo: number) => new Date(NOW - msAgo).toISOString();

  it("接続中 + 鮮度窓内 (≤60s) の last_event_at は live を維持 (境界含む)", () => {
    expect(
      effectiveLivenessState(
        listItem({ liveness_state: "live", connected: true, last_event_at: isoAgo(10_000) }),
        NOW,
      ),
    ).toBe("live");
    expect(
      effectiveLivenessState(
        listItem({ liveness_state: "live", connected: true, last_event_at: isoAgo(LIVE_FRESH_MS) }),
        NOW,
      ),
    ).toBe("live");
  });

  it("接続中でも鮮度切れ (>60s) の凍結 live は idle へ降格 (停止は断定しない)", () => {
    expect(
      effectiveLivenessState(
        listItem({
          liveness_state: "live",
          connected: true,
          last_event_at: isoAgo(LIVE_FRESH_MS + 1),
        }),
        NOW,
      ),
    ).toBe("idle");
    expect(
      effectiveLivenessState(
        listItem({ liveness_state: "live", connected: true, last_event_at: isoAgo(19 * 3600_000) }),
        NOW,
      ),
    ).toBe("idle");
  });

  it("切断(履歴)は接続の有無を最優先し offline へ (UNKNOWN にしない・ユーザー報告の核心)", () => {
    // 凍結された古い liveness_state に関わらず、!connected は offline で固定。
    for (const frozen of ["live", "idle", "stalled", "unknown"] as const) {
      expect(
        effectiveLivenessState(
          listItem({
            liveness_state: frozen,
            connected: false,
            last_event_at: isoAgo(19 * 3600_000),
          }),
          NOW,
        ),
      ).toBe("offline");
    }
    // 切断なら age が新しくても live/unknown にしない。
    expect(
      effectiveLivenessState(
        listItem({ liveness_state: "live", connected: false, last_event_at: isoAgo(1_000) }),
        NOW,
      ),
    ).toBe("offline");
  });

  it("last_event_at 欠落の live は fresh とみなさない (接続中→idle)", () => {
    expect(
      effectiveLivenessState(
        listItem({ liveness_state: "live", connected: true, last_event_at: undefined }),
        NOW,
      ),
    ).toBe("idle");
  });

  it("接続中で live 以外 (idle/stalled/unknown) は鮮度に関わらず据え置く", () => {
    for (const s of ["idle", "stalled", "unknown"] as const) {
      expect(
        effectiveLivenessState(
          listItem({ liveness_state: s, connected: true, last_event_at: isoAgo(99) }),
          NOW,
        ),
      ).toBe(s);
    }
  });

  it("回帰: 履歴(切断)の凍結 live は badge で LIVE を出さず OFFLINE になる", () => {
    const hist = listItem({
      liveness_state: "live",
      connected: false,
      last_event_at: isoAgo(19 * 3600_000),
    });
    const label = livenessBadge(effectiveLivenessState(hist, NOW), hist.stalled_suspected).label;
    expect(label).not.toBe("LIVE");
    expect(label).toBe("OFFLINE");
  });
});

describe("waitingKind / needsOperator (介入要否の KPI)", () => {
  it("detects approval/auth/input waiting from state", () => {
    expect(waitingKind("waiting.approval")).toBe("approval");
    expect(waitingKind("waiting.auth")).toBe("auth");
    expect(waitingKind("waiting.input")).toBe("input");
    expect(waitingKind("running.model_wait")).toBeNull();
    expect(waitingKind(undefined)).toBeNull();
  });

  it("needsOperator is true on needs_attention or any waiting state", () => {
    expect(needsOperator(listItem({ needs_attention: true }))).toBe(true);
    expect(needsOperator(listItem({ state: "waiting.approval" }))).toBe(true);
    expect(
      needsOperator(listItem({ needs_attention: false, state: "running.command_executing" })),
    ).toBe(false);
  });
});

describe("heartbeatRows: evidence を分解保持する (単一シグナルに潰さない)", () => {
  function detail(evidence: SessionDetail["liveness_evidence"]): SessionDetail {
    return {
      ...listItem(),
      last_event_id: undefined,
      liveness_evidence: evidence,
      liveness_reason: "",
      liveness_evaluated_at_ms: 0,
      invalid_transition_count: 0,
      pending_approvals: [],
    };
  }

  it("returns all five heartbeat kinds in display order, missing ones as observed:false", () => {
    const rows = heartbeatRows(detail({ process: { ageMs: 10, fresh: true, alive: true } }));
    expect(rows.map((r) => r.kind)).toEqual(["process", "event", "stdout", "file", "model-stream"]);
    const process = rows.find((r) => r.kind === "process")!;
    expect(process.observed).toBe(true);
    expect(process.extra).toBe("alive");
    // 欠損シグナルは観測なし (ageMs=null) として **分解保持** し、勝手に埋めない。
    const missing = rows.filter((r) => r.kind !== "process");
    expect(missing.every((r) => r.observed === false && r.ageMs === null && r.fresh === null)).toBe(
      true,
    );
  });

  it("reflects process not-alive without collapsing other signals", () => {
    const rows = heartbeatRows(
      detail({
        process: { ageMs: 99, fresh: false, alive: false },
        event: { ageMs: 5, fresh: true },
      }),
    );
    expect(rows.find((r) => r.kind === "process")!.extra).toBe("not alive");
    expect(rows.find((r) => r.kind === "event")!.observed).toBe(true);
  });
});
