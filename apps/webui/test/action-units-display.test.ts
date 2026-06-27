/**
 * 行文法の表示派生 (action-units-display) の不変条件 (設計裁定 019eb981).
 *
 *  - 解決済み承認は「承認待ち」と読めない表現にする (pending のみ警告トーン)。
 *  - exit 0 は静か (neutral)、非 0 は danger。
 *  - 経過/時刻フォーマットの決定性。
 */
import { describe, expect, it } from "vitest";

import {
  actionResult,
  actionVerb,
  commandOutcomeBadge,
  formatClock,
  formatElapsed,
  isUnresolvedAttention,
} from "../src/ui/action-units-display.js";
import { foldActionUnits } from "../src/ui/action-units.js";

import type { ReplayEventDTO } from "../src/realtime/contract.js";

let seq = 0;
function ev(o: Partial<ReplayEventDTO> = {}): ReplayEventDTO {
  seq += 1;
  return {
    event_id: `e${seq}`,
    provider: "claude_code",
    source: "hooks",
    session_id: "s1",
    event_type: "command.started",
    kind: "command",
    timestamp: "2026-06-12T01:02:03.000Z",
    state: undefined,
    cwd: undefined,
    summary: undefined,
    display_text: "x",
    subject: undefined,
    request_id: undefined,
    tool_name: undefined,
    command: undefined,
    path: undefined,
    risk_level: undefined,
    decision: undefined,
    auto_allowed: undefined,
    exit_code: undefined,
    elapsed_ms: undefined,
    ...o,
  };
}

function approvalUnit(decision: string | undefined, opts: { resolved: boolean }) {
  const rid = "s1:apr-Z";
  const events: ReplayEventDTO[] = [
    ev({
      event_type: "tool.permission.requested",
      kind: "approval",
      request_id: rid,
      command: "deploy",
    }),
  ];
  if (opts.resolved) {
    events.push(
      ev({ event_type: "tool.permission.resolved", kind: "approval", request_id: rid, decision }),
    );
  }
  return foldActionUnits(events)[0]!;
}

describe("行文法トーン: 承認チェーン", () => {
  it("解決済み承認 (allow) は『承認待ち』にならず過去形・success トーン", () => {
    const unit = approvalUnit("allow", { resolved: true });
    const verb = actionVerb(unit, "ja");
    expect(verb.tone).toBe("success");
    expect(verb.label).not.toContain("承認待ち");
    expect(verb.label).toContain("許可");
    expect(isUnresolvedAttention(unit)).toBe(false);
  });

  it("解決済み承認 (deny) は danger トーン・『承認待ち』にならない", () => {
    const unit = approvalUnit("deny", { resolved: true });
    const verb = actionVerb(unit, "ja");
    expect(verb.tone).toBe("danger");
    expect(verb.label).not.toContain("承認待ち");
    expect(verb.label).toContain("拒否");
  });

  it("未解決の requested のみ『承認待ち』warn トーン (介入対象)", () => {
    const unit = approvalUnit(undefined, { resolved: false });
    const verb = actionVerb(unit, "ja");
    expect(verb.tone).toBe("warn");
    expect(verb.label).toContain("承認待ち");
    expect(isUnresolvedAttention(unit)).toBe(true);
  });

  it("en でも解決済みは Awaiting approval にならない", () => {
    const unit = approvalUnit("allow", { resolved: true });
    const verb = actionVerb(unit, "en");
    expect(verb.label).not.toContain("Awaiting");
    expect(verb.label.toLowerCase()).toContain("allowed");
  });
});

describe("行文法トーン: 結果 (exit code)", () => {
  it("exit 0 は neutral (静か)", () => {
    const unit = foldActionUnits([ev({ event_type: "command.completed", exit_code: 0 })])[0]!;
    const r = actionResult(unit, "ja");
    expect(r?.tone).toBe("neutral");
    expect(r?.label).toContain("0");
  });

  it("非ゼロ exit は danger", () => {
    const unit = foldActionUnits([ev({ event_type: "command.completed", exit_code: 2 })])[0]!;
    const r = actionResult(unit, "ja");
    expect(r?.tone).toBe("danger");
    expect(r?.label).toContain("2");
  });

  it("exit code 無しは結果チップ無し", () => {
    const unit = foldActionUnits([
      ev({ event_type: "diff.updated", kind: "file", path: "/a" }),
    ])[0]!;
    expect(actionResult(unit, "ja")).toBeUndefined();
  });
});

describe("commandOutcomeBadge: command 相関ユニットの成功/失敗/実行中", () => {
  const TU = "tu:toolu_01DISPLAYOUTCOMEABCDEF";

  it("succeeded → success トーン", () => {
    const unit = foldActionUnits([
      ev({ event_type: "command.started", command: "go", request_id: TU }),
      ev({ event_type: "command.completed", request_id: TU }),
    ])[0]!;
    const b = commandOutcomeBadge(unit, "ja");
    expect(b?.tone).toBe("success");
    expect(b?.label).toBe("成功");
    expect(commandOutcomeBadge(unit, "en")?.label).toBe("succeeded");
  });

  it("failed → danger トーン", () => {
    const unit = foldActionUnits([
      ev({ event_type: "command.started", command: "go", request_id: TU }),
      ev({ event_type: "tool.failed", kind: "error", request_id: TU }),
    ])[0]!;
    const b = commandOutcomeBadge(unit, "ja");
    expect(b?.tone).toBe("danger");
    expect(b?.label).toBe("失敗");
  });

  it("running → info トーン (停止を断定しない)", () => {
    const unit = foldActionUnits([
      ev({ event_type: "command.started", command: "go", request_id: TU }),
    ])[0]!;
    const b = commandOutcomeBadge(unit, "ja");
    expect(b?.tone).toBe("info");
    expect(b?.label).toBe("実行中");
  });

  it("非 command ユニット (承認/単独) はバッジ無し", () => {
    const approval = foldActionUnits([
      ev({
        event_type: "tool.permission.requested",
        kind: "approval",
        request_id: "s1:apr-X",
        command: "deploy",
      }),
    ])[0]!;
    expect(commandOutcomeBadge(approval, "ja")).toBeUndefined();
    // request_id 無しの command.completed は単独ユニット → commandOutcome undefined。
    const standalone = foldActionUnits([ev({ event_type: "command.completed", exit_code: 0 })])[0]!;
    expect(commandOutcomeBadge(standalone, "ja")).toBeUndefined();
  });
});

describe("フォーマッタ (決定性)", () => {
  it("formatElapsed: ms / s 切替", () => {
    expect(formatElapsed(0)).toBe("0ms");
    expect(formatElapsed(950)).toBe("950ms");
    expect(formatElapsed(1500)).toBe("1.5s");
    expect(formatElapsed(13000)).toBe("13s");
    expect(formatElapsed(undefined)).toBeUndefined();
    expect(formatElapsed(-5)).toBeUndefined();
  });

  it("formatClock: ISO の時刻部を取り出す", () => {
    expect(formatClock("2026-06-12T01:02:03.000Z")).toBe("01:02:03");
    // non-ISO は素通し (壊さない)。
    expect(formatClock("weird")).toBe("weird");
  });
});
