/**
 * Action Rail の attention 導出 (純関数・decision 019f69ef)。
 *
 * deriveAttention が「いま人が対応すべきもの」を正しい優先度・重複排除・件数で返すことを固定する。
 * 既存の attention 派生 (needs_attention / stalled_suspected / waitingKind) の再利用が壊れないための回帰。
 */
import { describe, expect, it } from "vitest";

import { deriveAttention, repoBranchLabel } from "../src/ui/action-rail.js";

import type {
  SessionApprovals,
  SessionListItem,
  PendingApproval,
} from "../src/realtime/contract.js";

function session(o: Partial<SessionListItem> = {}): SessionListItem {
  return {
    session_id: "s1",
    provider: "claude_code",
    source: "hooks",
    agent_id: undefined,
    repo: undefined,
    branch: undefined,
    cwd: undefined,
    state: undefined,
    current_action: undefined,
    last_event_at: undefined,
    needs_attention: false,
    liveness_state: "live",
    stalled_suspected: false,
    connected: true,
    ...o,
  };
}

function approval(o: Partial<PendingApproval> = {}): PendingApproval {
  return {
    request_id: "req-1",
    tool_name: "Bash",
    command: "rm -rf build",
    path: undefined,
    risk_level: "high",
    requested_at: "2026-07-16T00:00:00.000Z",
    session_id: "s1",
    trigger: undefined,
    secret_kinds: undefined,
    persistable: undefined,
    ...o,
  };
}

function group(sessionId: string, pending: readonly PendingApproval[]): SessionApprovals {
  return {
    session_id: sessionId,
    provider: "claude_code",
    cwd: undefined,
    pending_approvals: pending,
  };
}

describe("repoBranchLabel", () => {
  it("repo + branch → repo@branch", () => {
    expect(repoBranchLabel("owner/repo", "main")).toBe("owner/repo@main");
  });
  it("repo のみ → repo", () => {
    expect(repoBranchLabel("owner/repo", undefined)).toBe("owner/repo");
  });
  it("repo 欠落 → undefined (生 cwd に fallback しない)", () => {
    expect(repoBranchLabel(undefined, "main")).toBeUndefined();
    expect(repoBranchLabel(undefined, undefined)).toBeUndefined();
  });
});

describe("deriveAttention", () => {
  it("空 → total 0・approvalGroups/signals とも空", () => {
    const d = deriveAttention([], []);
    expect(d.total).toBe(0);
    expect(d.approvalGroups).toHaveLength(0);
    expect(d.signals).toHaveLength(0);
  });

  it("pending 承認は approvalGroups へ・repo@branch を list item から join", () => {
    const sessions = [session({ session_id: "s1", repo: "owner/repo", branch: "main" })];
    const approvals = [
      group("s1", [approval({ request_id: "r1" }), approval({ request_id: "r2" })]),
    ];
    const d = deriveAttention(sessions, approvals);
    expect(d.approvalGroups).toHaveLength(1);
    expect(d.approvalGroups[0]?.repoLabel).toBe("owner/repo@main");
    expect(d.signals).toHaveLength(0); // 承認を持つ session はシグナル二重表示しない
    expect(d.total).toBe(2); // pending 2 件
  });

  it("承認 session は stalled/attention でも signals へ二重計上しない (dedup)", () => {
    const sessions = [
      session({ session_id: "s1", stalled_suspected: true, needs_attention: true }),
    ];
    const approvals = [group("s1", [approval()])];
    const d = deriveAttention(sessions, approvals);
    expect(d.signals).toHaveLength(0);
    expect(d.total).toBe(1);
  });

  it("非承認シグナルを優先度順に: approval > stalled > auth > input > generic", () => {
    const sessions = [
      session({ session_id: "gen", needs_attention: true }),
      session({ session_id: "inp", state: "waiting.input" }),
      session({ session_id: "auth", state: "waiting.auth" }),
      session({ session_id: "stall", stalled_suspected: true }),
      session({ session_id: "appr", state: "waiting.approval" }),
    ];
    const d = deriveAttention(sessions, []);
    expect(d.signals.map((s) => s.kind)).toEqual([
      "approval",
      "stalled",
      "auth",
      "input",
      "attention",
    ]);
    expect(d.total).toBe(5);
  });

  it("waiting.approval は stalled_suspected より優先 (state 由来 approval が上)", () => {
    const sessions = [
      session({ session_id: "s1", state: "waiting.approval", stalled_suspected: true }),
    ];
    const d = deriveAttention(sessions, []);
    expect(d.signals).toHaveLength(1);
    expect(d.signals[0]?.kind).toBe("approval");
  });

  it("非 attention の live session はシグナルに出さない", () => {
    const sessions = [session({ session_id: "s1", state: "running.command_executing" })];
    const d = deriveAttention(sessions, []);
    expect(d.signals).toHaveLength(0);
    expect(d.total).toBe(0);
  });

  it("signal の repoLabel も allowlist フィールド由来 (生 cwd は載せない)", () => {
    const sessions = [
      session({
        session_id: "s1",
        stalled_suspected: true,
        repo: "o/r",
        branch: "dev",
        cwd: "/secret/path",
      }),
    ];
    const d = deriveAttention(sessions, []);
    expect(d.signals[0]?.repoLabel).toBe("o/r@dev");
    // cwd はどのフィールドにも載らない
    expect(JSON.stringify(d.signals)).not.toContain("/secret/path");
  });
});
