/**
 * 現在作業ビュー / git-risk 派生の純関数契約 — ADR 019ea4ba 段階1 (INV-DETAIL-*).
 *
 * 純ロジック層 (current-action-display.ts) を node 環境で直接食わせる (jsdom 不要・REAL DATA:
 * backend replay-contract.ReplayEventDTO の wire 形をそのまま使う)。
 *
 * 検証する不変条件 (falsifiable・写像を変えると赤):
 *  - INV-DETAIL-CURRENT-ACTION-MAP: 各 T1 running.* / waiting.* state が規定の中央ビュー種別へ写る。
 *    未知 state は安全に idle へ fallback。
 *  - INV-DETAIL-TIMELINE-ORDER: timeline 行射影が入力 events の昇順を保つ (並べ替えない)。
 *  - INV-DETAIL-CAPTURE-BADGE (純ロジック部): non-managed capture のみ provenance バッジ、
 *    managed/欠落は非表示。render 側は session-detail.test.tsx で固定。
 */
import { describe, expect, it } from "vitest";

import {
  currentActionSnapshot,
  currentActionView,
  deriveSessionFacts,
  isNonManagedCapture,
  normalizeCaptureMode,
  toTimelineRow,
  type CurrentActionView,
} from "../src/ui/current-action-display.js";

import type { ReplayEventDTO } from "../src/realtime/contract.js";

function ev(o: Partial<ReplayEventDTO> = {}): ReplayEventDTO {
  return {
    event_id: "e1",
    provider: "claude_code",
    source: "hooks",
    session_id: "s1",
    event_type: "command.started",
    kind: "command",
    timestamp: "2026-06-05T00:00:00.000Z",
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

describe("INV-DETAIL-CURRENT-ACTION-MAP: State→中央ビュー写像", () => {
  // 各 T1 state が **規定の** ビュー種別へ写ること (写像を変えると赤)。
  const cases: ReadonlyArray<readonly [string, CurrentActionView]> = [
    ["running.model_wait", "model_stream"],
    ["running.model_streaming", "model_stream"],
    ["running.planning", "model_stream"],
    ["running.tool_preparing", "command"],
    ["running.command_executing", "command"],
    ["running.testing", "command"],
    ["running.file_editing", "file_edit"],
    ["running.mcp_tool_calling", "mcp"],
    ["running.web_searching", "web"],
    ["waiting.approval", "waiting"],
    ["waiting.user_input", "waiting"],
    ["waiting.auth", "waiting"],
  ];

  for (const [state, expected] of cases) {
    it(`${state} → ${expected}`, () => {
      expect(currentActionView(state)).toBe(expected);
    });
  }

  it("未知 state / terminal / idle 系は idle へ安全 fallback", () => {
    for (const s of [
      undefined,
      "created",
      "starting",
      "compacting",
      "idle",
      "stalled",
      "completed",
      "failed",
      "interrupted",
      "disconnected",
      "running.bogus_unknown",
    ]) {
      expect(currentActionView(s)).toBe("idle");
    }
  });

  it("写像が混線していない (model_stream と command は別種別)", () => {
    // mutation で command_executing→model_stream にすると赤になる結合確認。
    expect(currentActionView("running.command_executing")).not.toBe(
      currentActionView("running.model_streaming"),
    );
  });
});

describe("currentActionSnapshot: state + events から現在作業を組む", () => {
  it("command ビューは最新 command 行の command/cwd/elapsed/exit を拾う", () => {
    const events = [
      ev({ event_id: "e1", kind: "command", command: "echo old", cwd: "/a" }),
      ev({
        event_id: "e2",
        kind: "command",
        command: "pnpm test",
        cwd: "/repo",
        elapsed_ms: 1234,
        exit_code: 0,
      }),
    ];
    const snap = currentActionSnapshot(
      { state: "running.command_executing", current_action: "x", cwd: "/fallback" },
      events,
    );
    expect(snap.view).toBe("command");
    expect(snap.primaryText).toBe("pnpm test"); // 最新(末尾)を採用
    expect(snap.cwd).toBe("/repo");
    expect(snap.elapsedMs).toBe(1234);
    expect(snap.exitCode).toBe(0);
  });

  it("該当イベントが無ければ current_action / state へ fallback (架空状態を出さない)", () => {
    const snap = currentActionSnapshot(
      { state: "running.mcp_tool_calling", current_action: "calling X", cwd: undefined },
      [],
    );
    expect(snap.view).toBe("mcp");
    expect(snap.primaryText).toBe("calling X");
  });

  // QA-2 (ADR 019eeac6・INV-CURRENT-ACTION-I18N): 該当イベントが無いとき primaryText は
  // localizedCurrentAction 分岐 (kind+subject 由来) を採り、viewer locale で述語を組む。
  // legacy current_action (summary) ではなく kind+subject から組み立てた値になることを ja/en で pin。
  it("該当イベントが無ければ kind+subject から locale 別述語を組む (ja)", () => {
    const snap = currentActionSnapshot(
      {
        state: "running.command_executing",
        current_action: "コマンド実行: 旧サマリ", // legacy (使われないことを確認)
        current_action_kind: "command",
        current_action_subject: "npm test",
        cwd: undefined,
      },
      [],
      "ja",
    );
    expect(snap.primaryText).toBe("コマンド実行: npm test");
  });

  it("該当イベントが無ければ kind+subject から locale 別述語を組む (en)", () => {
    const snap = currentActionSnapshot(
      {
        state: "running.command_executing",
        current_action: "コマンド実行: 旧サマリ", // legacy 日本語が英語 viewer に漏れないこと
        current_action_kind: "command",
        current_action_subject: "npm test",
        cwd: undefined,
      },
      [],
      "en",
    );
    expect(snap.primaryText).toBe("Run command: npm test");
    expect(snap.primaryText).not.toContain("旧サマリ");
  });
});

describe("INV-DETAIL-TIMELINE-ORDER: 行射影が昇順を保つ", () => {
  it("toTimelineRow の map は events 配列の順序を変えない", () => {
    const events = [
      ev({ event_id: "a", timestamp: "2026-06-05T00:00:01.000Z" }),
      ev({ event_id: "b", timestamp: "2026-06-05T00:00:02.000Z" }),
      ev({ event_id: "c", timestamp: "2026-06-05T00:00:03.000Z" }),
    ];
    const rows = events.map(toTimelineRow);
    expect(rows.map((r) => r.eventId)).toEqual(["a", "b", "c"]);
    // timestamp も単調非減少 (入力順を尊重し並べ替えていない)。
    const ts = rows.map((r) => Date.parse(r.timestamp));
    for (let i = 1; i < ts.length; i++) expect(ts[i]).toBeGreaterThanOrEqual(ts[i - 1]!);
  });

  it("行射影は ReplayEventDTO の許可フィールドのみを写す (本文チャネルを足さない)", () => {
    const row = toTimelineRow(
      ev({ command: "ls", risk_level: "high", decision: "allow", exit_code: 2, elapsed_ms: 50 }),
    );
    expect(row).toMatchObject({
      command: "ls",
      riskLevel: "high",
      decision: "allow",
      exitCode: 2,
      elapsedMs: 50,
    });
    // stdout 本文 / diff 本文相当のキーは存在しない (段階2)。
    expect(Object.keys(row)).not.toContain("output");
    expect(Object.keys(row)).not.toContain("diff");
  });
});

describe("INV-DETAIL-CAPTURE-BADGE (純ロジック): non-managed capture provenance", () => {
  it("attach/codex_rollout は non-managed、managed/欠落/未知は非表示", () => {
    expect(isNonManagedCapture("attach")).toBe(true);
    expect(isNonManagedCapture("codex_rollout")).toBe(true);
    expect(isNonManagedCapture("managed")).toBe(false);
    expect(isNonManagedCapture(undefined)).toBe(false);
    expect(isNonManagedCapture("bogus")).toBe(false);
  });

  it("normalizeCaptureMode は欠落/未知を managed 既定へ寄せる", () => {
    expect(normalizeCaptureMode("attach")).toBe("attach");
    expect(normalizeCaptureMode("codex_rollout")).toBe("codex_rollout");
    expect(normalizeCaptureMode("managed")).toBe("managed");
    expect(normalizeCaptureMode(undefined)).toBe("managed");
    expect(normalizeCaptureMode("xxx")).toBe("managed");
  });
});

describe("deriveSessionFacts: timeline events から right ペイン facts を導出", () => {
  it("最高 risk / mcp / web / file 変更 / 失敗 / capture_mode を集約", () => {
    const events = [
      ev({ event_id: "1", kind: "command", risk_level: "low", exit_code: 0 }),
      ev({ event_id: "2", kind: "file", risk_level: "high", path: "/a.ts" }),
      ev({ event_id: "3", kind: "file", path: "/a.ts" }), // 同一 path は1扱い
      ev({ event_id: "4", kind: "mcp" }),
      ev({ event_id: "5", kind: "web" }),
      ev({ event_id: "6", kind: "command", exit_code: 2 }),
    ];
    const facts = deriveSessionFacts({ capture_mode: "attach" }, events);
    expect(facts.highestRisk).toBe("high");
    expect(facts.mcp).toBe(true);
    expect(facts.web).toBe(true);
    expect(facts.fileChanges).toBe(true);
    expect(facts.changedPathCount).toBe(1);
    expect(facts.hadCommandFailure).toBe(true);
    expect(facts.captureMode).toBe("attach");
  });

  it("空 events / managed では控えめ既定 (none / false / managed)", () => {
    const facts = deriveSessionFacts({ capture_mode: undefined }, []);
    expect(facts.highestRisk).toBe("none");
    expect(facts.mcp).toBe(false);
    expect(facts.web).toBe(false);
    expect(facts.fileChanges).toBe(false);
    expect(facts.changedPathCount).toBe(0);
    expect(facts.hadCommandFailure).toBe(false);
    expect(facts.captureMode).toBe("managed");
  });

  // QA-1 carryover (task 019ea4d6-b847): highestRisk は「観測された最高 risk」であり、
  //   後発の低 risk イベントで下方修正されてはならない (右ペインの最高リスク表示が誤って
  //   下がると supervisor が危険を見落とす)。集約は Math.max(riskRank) でなければならず、
  //   last-wins (最後の risk_level を採用) に変える mutation で **この test が赤くなる** こと。
  it("最高 risk は後発の低 risk で下方修正されない (high の後に low が来ても high を保つ)", () => {
    // high → low の順に並べる: last-wins mutation だと最後の low を採用して "low" になり赤化する。
    const events = [
      ev({ event_id: "1", kind: "command", risk_level: "high" }),
      ev({ event_id: "2", kind: "command", risk_level: "low" }),
    ];
    const facts = deriveSessionFacts({ capture_mode: undefined }, events);
    expect(facts.highestRisk).toBe("high");
  });

  it("最高 risk は medium の後に high が来れば high へ上がる (単調・上方は反映)", () => {
    const events = [
      ev({ event_id: "1", kind: "file", risk_level: "medium" }),
      ev({ event_id: "2", kind: "command", risk_level: "high" }),
    ];
    expect(deriveSessionFacts({ capture_mode: undefined }, events).highestRisk).toBe("high");
  });
});
