/**
 * INV-ACTION-UNIT-CORRELATION (設計裁定 019eb981).
 *
 * foldActionUnits の不変条件を、**実 DB で観測したイベント形** (note 019eb984) に忠実な
 * フィクスチャで固定する:
 *  - 相関は request_id 実観測一致のみ (permission.requested↔resolved を畳む)。
 *  - request_id を共有しないイベント (command.started/completed・tool・file・diff) は独立行。
 *  - resolved 無しの requested は未解決 (pending) のまま (承認待ちと読ませる対象)。
 *  - requested 無しの resolved (orphan_resolved) も実在 → 独立扱いで保持。
 *  - cross-session 混入なし (request_id が同一でも session_id が違えば別ユニット)。
 *  - 決定的・順序安定 (入力到達順を保つ)。
 */
import { describe, expect, it } from "vitest";

import { foldActionUnits, type ActionUnit } from "../src/ui/action-units.js";

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
    timestamp: `2026-06-12T00:00:${String(seq).padStart(2, "0")}.000Z`,
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

/** 実観測の request_id 形 (`<session_id>:apr-<id>`)。 */
function reqId(session: string, id: string): string {
  return `${session}:apr-${id}`;
}

describe("INV-ACTION-UNIT-CORRELATION: foldActionUnits", () => {
  it("permission.requested↔resolved を request_id 一致で 1 ユニットへ畳む (resolved)", () => {
    const rid = reqId("s1", "A");
    const units = foldActionUnits([
      ev({
        event_id: "req1",
        event_type: "tool.permission.requested",
        kind: "approval",
        request_id: rid,
        command: "rm -rf /tmp/x",
        risk_level: "high",
        auto_allowed: false,
      }),
      ev({
        event_id: "res1",
        event_type: "tool.permission.resolved",
        kind: "approval",
        request_id: rid,
        decision: "allow",
      }),
    ]);

    expect(units).toHaveLength(1);
    const u = units[0]!;
    expect(u.kind).toBe("approval");
    expect(u.approval?.status).toBe("resolved");
    expect(u.approval?.decision).toBe("allow");
    expect(u.approval?.riskLevel).toBe("high");
    expect(u.approval?.autoAllowed).toBe(false);
    // 対象は requested 由来 (command 全文・切詰めない)。
    expect(u.target).toBe("rm -rf /tmp/x");
    expect(u.events).toHaveLength(2);
  });

  it("resolved 無しの requested は pending (未解決) のまま", () => {
    const rid = reqId("s1", "B");
    const units = foldActionUnits([
      ev({
        event_id: "req1",
        event_type: "tool.permission.requested",
        kind: "approval",
        request_id: rid,
        command: "git push",
      }),
    ]);
    expect(units).toHaveLength(1);
    expect(units[0]!.approval?.status).toBe("pending");
    expect(units[0]!.approval?.decision).toBeUndefined();
  });

  it("requested 無しの resolved は orphan_resolved (実在ケース・捏造で対象を埋めない)", () => {
    const rid = reqId("s1", "C");
    const units = foldActionUnits([
      ev({
        event_id: "res1",
        event_type: "tool.permission.resolved",
        kind: "approval",
        request_id: rid,
        decision: "deny",
      }),
    ]);
    expect(units).toHaveLength(1);
    expect(units[0]!.approval?.status).toBe("orphan_resolved");
    expect(units[0]!.approval?.decision).toBe("deny");
    // requested が無いので対象は不明 (捏造しない)。
    expect(units[0]!.target).toBeUndefined();
  });

  it("request_id を共有しないイベントは独立行のまま (因果の捏造禁止)", () => {
    // 旧イベント (sidecar 55a5abf 以前): command.* は request_id を持たない。後方互換を pin。
    const units = foldActionUnits([
      ev({ event_id: "c1", event_type: "command.started", kind: "command", command: "ls" }),
      ev({ event_id: "c2", event_type: "command.completed", kind: "command", exit_code: 0 }),
      ev({ event_id: "d1", event_type: "diff.updated", kind: "file", path: "/a.ts" }),
    ]);
    // 3 つの独立ユニット (畳まれない)。
    expect(units).toHaveLength(3);
    expect(units.map((u) => u.id)).toEqual(["ev:c1", "ev:c2", "ev:d1"]);
    expect(units.every((u) => u.approval === undefined)).toBe(true);
  });

  it("INV-ACTION-UNIT-CORRELATION: ゲートは event_type 判定 — tu: request_id を持つ command.* は承認ユニット化しない", () => {
    // sidecar 55a5abf 以降: command.started/completed は `tu:<tool_use_id>` request_id を持つ
    // (INV-REQUEST-ID-NAMESPACE)。ゲートを「request_id の有無」へ緩めるリファクタが入ると
    // command が承認チェーンへ誤吸収される。本ケースはその緩和 mutation で赤化する
    // (QA-1, decision 019ebc01)。command 相関スライス以降: 2 件は 1 つの command ユニットへ畳む
    // が、それは **command Map (event_type=command.*)** であり承認ユニットではない (approval 不在)。
    const tu = "tu:toolu_01ABCDEFGHJKMNPQRSTVW";
    const units = foldActionUnits([
      ev({
        event_id: "c1",
        event_type: "command.started",
        kind: "command",
        command: "npm test",
        request_id: tu,
      }),
      ev({
        event_id: "c2",
        event_type: "command.completed",
        kind: "command",
        exit_code: 0,
        request_id: tu,
      }),
    ]);
    // command 相関ユニット 1 件。承認ユニット化しない (approval は不在)。
    expect(units).toHaveLength(1);
    expect(units.map((u) => u.id)).toEqual([`cmd:${tu}`]);
    expect(units.every((u) => u.approval === undefined)).toBe(true);
    expect(units[0]!.commandOutcome).toBe("succeeded");
  });

  it("INV-ACTION-UNIT-CORRELATION: 承認キーと同一文字列の request_id を command が持っても namespace を跨いで畳まれない", () => {
    // 敵対的フィクスチャ: 承認ペアの request_id と byte 同一の request_id を command.completed
    // に与える。event_type ゲートが正しければ承認ユニットは permission.* の 2 イベントのみで
    // 構成され、command は **別 Map (command 相関ユニット)** に残る (承認へ混入しない)。
    const rid = "s1:apr-collide";
    const units = foldActionUnits([
      ev({
        event_id: "p1",
        event_type: "tool.permission.requested",
        kind: "approval",
        request_id: rid,
        command: "rm -rf build",
      }),
      ev({
        event_id: "c1",
        event_type: "command.completed",
        kind: "command",
        exit_code: 0,
        request_id: rid,
      }),
      ev({
        event_id: "p2",
        event_type: "tool.permission.resolved",
        kind: "approval",
        request_id: rid,
        decision: "allow",
      }),
    ]);
    // 承認ユニット (permission.* のみ) と command 相関ユニット (command.* のみ) の 2 件。
    expect(units).toHaveLength(2);
    const approval = units.find((u) => u.approval !== undefined);
    expect(approval).toBeDefined();
    // 承認ユニットの構成イベントは permission.* のみ (command は混入しない)。
    expect(approval!.events.map((e) => e.event_id).sort()).toEqual(["p1", "p2"]);
    expect(approval!.commandOutcome).toBeUndefined();
    // command は cmd: ユニットへ畳まれ承認へ吸収されない (namespace 構造分離)。
    const command = units.find((u) => u.id === `cmd:${rid}`);
    expect(command).toBeDefined();
    expect(command!.approval).toBeUndefined();
    expect(command!.events.map((e) => e.event_id)).toEqual(["c1"]);
    expect(command!.commandOutcome).toBe("succeeded");
  });

  it("cross-session 混入なし: 同一 request_id でも session_id が違えば別ユニット", () => {
    // 防御的フィクスチャ: request_id 文字列だけ衝突させ session_id を変える。
    const rid = "shared:apr-X";
    const units = foldActionUnits([
      ev({
        event_id: "a-req",
        session_id: "sessA",
        event_type: "tool.permission.requested",
        kind: "approval",
        request_id: rid,
        command: "cmd-A",
      }),
      ev({
        event_id: "b-res",
        session_id: "sessB",
        event_type: "tool.permission.resolved",
        kind: "approval",
        request_id: rid,
        decision: "allow",
      }),
    ]);
    // session 跨ぎで畳まない → 2 ユニット。
    expect(units).toHaveLength(2);
    expect(units[0]!.sessionId).toBe("sessA");
    expect(units[0]!.approval?.status).toBe("pending");
    expect(units[1]!.sessionId).toBe("sessB");
    expect(units[1]!.approval?.status).toBe("orphan_resolved");
  });

  it("並行する別 request_id の承認を取り違えず分離する", () => {
    const ridA = reqId("s1", "P1");
    const ridB = reqId("s1", "P2");
    const units = foldActionUnits([
      ev({
        event_type: "tool.permission.requested",
        kind: "approval",
        request_id: ridA,
        command: "A",
      }),
      ev({
        event_type: "tool.permission.requested",
        kind: "approval",
        request_id: ridB,
        command: "B",
      }),
      ev({
        event_type: "tool.permission.resolved",
        kind: "approval",
        request_id: ridB,
        decision: "allow",
      }),
      ev({
        event_type: "tool.permission.resolved",
        kind: "approval",
        request_id: ridA,
        decision: "deny",
      }),
    ]);
    expect(units).toHaveLength(2);
    const byTarget = new Map(units.map((u) => [u.target, u]));
    expect(byTarget.get("A")?.approval?.decision).toBe("deny");
    expect(byTarget.get("B")?.approval?.decision).toBe("allow");
  });

  it("決定的・順序安定: 出力順は承認グループ先頭の到達順を保つ", () => {
    const ridA = reqId("s1", "O1");
    const input: ReplayEventDTO[] = [
      ev({ event_id: "1", event_type: "command.started", kind: "command", command: "first" }),
      ev({
        event_id: "2",
        event_type: "tool.permission.requested",
        kind: "approval",
        request_id: ridA,
        command: "appr",
      }),
      ev({ event_id: "3", event_type: "file.change.applied", kind: "file", path: "/x.ts" }),
      ev({
        event_id: "4",
        event_type: "tool.permission.resolved",
        kind: "approval",
        request_id: ridA,
        decision: "allow",
      }),
      ev({ event_id: "5", event_type: "command.completed", kind: "command", exit_code: 0 }),
    ];
    const a = foldActionUnits(input);
    const b = foldActionUnits(input);
    expect(a.map((u) => u.id)).toEqual(b.map((u) => u.id));
    // 承認ユニットは requested (event 2) の位置に固定。resolved (event 4) は同ユニットへ吸収。
    expect(a.map((u) => u.id)).toEqual(["ev:1", `apr:${ridA}`, "ev:3", "ev:5"]);
  });

  it("時刻範囲: 承認ユニットは構成イベントの最初〜最後を持つ", () => {
    const rid = reqId("s1", "T");
    const units = foldActionUnits([
      ev({
        event_type: "tool.permission.requested",
        kind: "approval",
        request_id: rid,
        timestamp: "2026-06-12T00:00:01.000Z",
        command: "c",
      }),
      ev({
        event_type: "tool.permission.resolved",
        kind: "approval",
        request_id: rid,
        timestamp: "2026-06-12T00:00:09.000Z",
        decision: "allow",
      }),
    ]);
    expect(units[0]!.startTime).toBe("2026-06-12T00:00:01.000Z");
    expect(units[0]!.endTime).toBe("2026-06-12T00:00:09.000Z");
  });

  it("command.started ユニットは stdout pull の anchor (commandEventId) を持つ", () => {
    const units = foldActionUnits([
      ev({ event_id: "cs", event_type: "command.started", kind: "command", command: "make" }),
    ]);
    expect(units[0]!.commandEventId).toBe("cs");
  });

  it("空入力は空配列 (例外なし)", () => {
    const units: ActionUnit[] = foldActionUnits([]);
    expect(units).toEqual([]);
  });
});

/**
 * INV-COMMAND-UNIT-FOLD (decision 019eb981 後続スライス・branch feat/command-unit-fold).
 *
 * command.started ↔ command.completed / tool.failed を `tu:<tool_use_id>` 相関キーで 1 アクション
 * 単位へ畳む契約を固定する:
 *  - outcome はイベント由来のみ (completed=succeeded / tool.failed=failed / started のみ=running)。
 *  - elapsedMs は started と終端の両方観測時のみ算出 (片方欠落で捏造しない)・DTO 値優先。
 *  - exit_code は存在時のみ (0 を捏造しない)。
 *  - 承認 namespace と構造分離 (同一文字列 request_id でも別ユニット)・cross-session 非混入。
 */
describe("INV-COMMAND-UNIT-FOLD: foldActionUnits (command 相関)", () => {
  const TU = "tu:toolu_01CMDFOLDABCDEFGHJKMN";

  it("(a) started+completed → 1 ユニット・succeeded・elapsed 算出・events=2", () => {
    const units = foldActionUnits([
      ev({
        event_id: "cs",
        event_type: "command.started",
        kind: "command",
        command: "pnpm test",
        request_id: TU,
        timestamp: "2026-06-12T00:00:01.000Z",
      }),
      ev({
        event_id: "cc",
        event_type: "command.completed",
        kind: "command",
        request_id: TU,
        timestamp: "2026-06-12T00:00:04.500Z",
      }),
    ]);
    expect(units).toHaveLength(1);
    const u = units[0]!;
    expect(u.id).toBe(`cmd:${TU}`);
    expect(u.kind).toBe("command");
    expect(u.commandOutcome).toBe("succeeded");
    expect(u.target).toBe("pnpm test");
    expect(u.targetKind).toBe("command");
    // started+completed の両方を観測 → timestamp 差で elapsed 算出 (3500ms)。
    expect(u.elapsedMs).toBe(3500);
    expect(u.events).toHaveLength(2);
    // stdout pull anchor は started の event_id。
    expect(u.commandEventId).toBe("cs");
    // exit_code は実在しない → undefined (0 を捏造しない)。
    expect(u.exitCode).toBeUndefined();
  });

  it("(a') DTO elapsed_ms があれば timestamp 差より優先 (実観測値)", () => {
    const units = foldActionUnits([
      ev({
        event_id: "cs",
        event_type: "command.started",
        kind: "command",
        command: "make",
        request_id: TU,
        timestamp: "2026-06-12T00:00:01.000Z",
      }),
      ev({
        event_id: "cc",
        event_type: "command.completed",
        kind: "command",
        request_id: TU,
        elapsed_ms: 1234,
        timestamp: "2026-06-12T00:00:09.000Z",
      }),
    ]);
    expect(units[0]!.elapsedMs).toBe(1234);
  });

  it("(b) started+tool.failed → failed・exit_code 実在時のみ反映", () => {
    const units = foldActionUnits([
      ev({
        event_id: "cs",
        event_type: "command.started",
        kind: "command",
        command: "cargo build",
        request_id: TU,
        timestamp: "2026-06-12T00:00:01.000Z",
      }),
      ev({
        event_id: "tf",
        event_type: "tool.failed",
        kind: "error",
        request_id: TU,
        exit_code: 1,
        timestamp: "2026-06-12T00:00:02.000Z",
      }),
    ]);
    expect(units).toHaveLength(1);
    const u = units[0]!;
    expect(u.commandOutcome).toBe("failed");
    expect(u.exitCode).toBe(1);
    expect(u.elapsedMs).toBe(1000);
    expect(u.events).toHaveLength(2);
  });

  it("(c) started のみ → running・elapsedMs undefined (片方欠落で捏造しない)", () => {
    const units = foldActionUnits([
      ev({
        event_id: "cs",
        event_type: "command.started",
        kind: "command",
        command: "long-running",
        request_id: TU,
        timestamp: "2026-06-12T00:00:01.000Z",
      }),
    ]);
    expect(units).toHaveLength(1);
    const u = units[0]!;
    expect(u.commandOutcome).toBe("running");
    // 終端イベント (completed/failed) を観測していない → elapsed/exit は捏造しない。
    expect(u.elapsedMs).toBeUndefined();
    expect(u.exitCode).toBeUndefined();
    expect(u.commandEventId).toBe("cs");
  });

  it("(d) completed 単独 (started 欠落・orphan) → 単独 command ユニット・succeeded", () => {
    const units = foldActionUnits([
      ev({
        event_id: "cc",
        event_type: "command.completed",
        kind: "command",
        command: "echo done",
        request_id: TU,
        exit_code: 0,
        timestamp: "2026-06-12T00:00:01.000Z",
      }),
    ]);
    expect(units).toHaveLength(1);
    const u = units[0]!;
    expect(u.id).toBe(`cmd:${TU}`);
    expect(u.commandOutcome).toBe("succeeded");
    // started 欠落 → elapsed は両端そろわず undefined。exit_code は実在するので 0。
    expect(u.elapsedMs).toBeUndefined();
    expect(u.exitCode).toBe(0);
    // started が無い → stdout anchor も無い (捏造しない)。
    expect(u.commandEventId).toBeUndefined();
  });

  it("(e) 承認 requested と command.started が同一文字列 request_id でも別ユニット (namespace 構造分離)", () => {
    // 敵対的: 承認キーと byte 同一の request_id を command 群へも与える。event_type ゲートで
    // 別 Map に振り分けられるため、承認ユニット (permission.*) と command ユニット (command.*)
    // が独立に存在し、互いに吸収しない。
    const rid = "s1:apr-shared-collide";
    const units = foldActionUnits([
      ev({
        event_id: "req",
        event_type: "tool.permission.requested",
        kind: "approval",
        request_id: rid,
        command: "rm -rf x",
        risk_level: "high",
      }),
      ev({
        event_id: "cs",
        event_type: "command.started",
        kind: "command",
        command: "rm -rf x",
        request_id: rid,
      }),
      ev({
        event_id: "res",
        event_type: "tool.permission.resolved",
        kind: "approval",
        request_id: rid,
        decision: "allow",
      }),
      ev({
        event_id: "cc",
        event_type: "command.completed",
        kind: "command",
        request_id: rid,
      }),
    ]);
    expect(units).toHaveLength(2);
    const approval = units.find((u) => u.id === `apr:${rid}`);
    const command = units.find((u) => u.id === `cmd:${rid}`);
    expect(approval).toBeDefined();
    expect(command).toBeDefined();
    // 承認ユニットは permission.* のみ・command ユニットは command.* のみ (混入なし)。
    expect(approval!.events.map((e) => e.event_id)).toEqual(["req", "res"]);
    expect(command!.events.map((e) => e.event_id)).toEqual(["cs", "cc"]);
    expect(approval!.commandOutcome).toBeUndefined();
    expect(command!.approval).toBeUndefined();
    expect(command!.commandOutcome).toBe("succeeded");
  });

  it("(f) cross-session 非混入: 同一 request_id・別 session_id の command は別ユニット", () => {
    const units = foldActionUnits([
      ev({
        event_id: "a-cs",
        session_id: "sessA",
        event_type: "command.started",
        kind: "command",
        command: "cmd-A",
        request_id: TU,
      }),
      ev({
        event_id: "b-cc",
        session_id: "sessB",
        event_type: "command.completed",
        kind: "command",
        request_id: TU,
      }),
    ]);
    // session_id をキーに含むため畳まれない → 2 ユニット。
    expect(units).toHaveLength(2);
    expect(units[0]!.sessionId).toBe("sessA");
    expect(units[0]!.commandOutcome).toBe("running");
    expect(units[1]!.sessionId).toBe("sessB");
    expect(units[1]!.commandOutcome).toBe("succeeded");
  });

  it("順序安定: command ユニットは started 到達位置に固定される", () => {
    const units = foldActionUnits([
      ev({ event_id: "x", event_type: "diff.updated", kind: "file", path: "/a.ts" }),
      ev({
        event_id: "cs",
        event_type: "command.started",
        kind: "command",
        command: "go",
        request_id: TU,
      }),
      ev({ event_id: "y", event_type: "diff.updated", kind: "file", path: "/b.ts" }),
      ev({
        event_id: "cc",
        event_type: "command.completed",
        kind: "command",
        request_id: TU,
      }),
    ]);
    // command ユニットは started (event index 1) の位置・completed は同ユニットへ吸収。
    expect(units.map((u) => u.id)).toEqual(["ev:x", `cmd:${TU}`, "ev:y"]);
  });
});
