/**
 * INV-CODEX-APPROVAL-RESOLVED — codex managed 承認の `tool.permission.resolved` 対称 emit
 * (P4.5 / TDA-1 / ADR 019f2476).
 *
 * gap: codex managed 承認は従来 `tool.permission.requested` のみ emit し、解決時は JSON-RPC Response
 *   だけを返して `tool.permission.resolved` を出さなかった (claude は hook-receiver.ts:363-379 で emit)。
 *   結果 ①projection foldPendingApprovals が resolved でのみ pending を除去するため codex カードが
 *   session.ended まで stale ②監査トレイルに codex の決定が記録されない。
 *
 * 本 INV は `CodexApprovalBridge` の `emitResolved` seam を実 `ApprovalBridge` で駆動し、
 *  - operator allow / deny → resolved emit (matching request_id + decision)、
 *  - child-exit deny (cancelInFlight) → resolved(deny) emit、
 *  - timeout → finish(undefined) → resolved(deny)、
 *  - NO-RAW: resolved payload は kind/request_id/decision(enum) のみ (raw command/secret 非再掲)、
 *  - 二重 emit なし (inFlight 排他)、
 * を固定する。projection への影響は **hand-rolled stub でなく実 `@actradeck/projection` の reduceEvents**
 * (provider 非依存 foldPendingApprovals) で検証し、pending カードの clear を assert する。
 */
import type { ApprovalDecision, NormalizedEvent } from "@actradeck/event-model";
import { reduceEvents } from "@actradeck/projection";
import { describe, expect, it, vi } from "vitest";

import { ApprovalBridge } from "../src/approval-bridge.js";
import { CodexApprovalBridge, type CodexApprovalCard } from "../src/approval-bridge-codex.js";
import { buildEvent } from "../src/event-factory.js";

const SESSION = "sess_test";
const THREAD_ID = "T-thread-1";

/** promise chain (.then(finish)) を確実に解決させる。 */
async function flush(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
}

/**
 * codex-runner.ts の emitCard builder を忠実に写した requested NormalizedEvent。
 * (実配線経路の統合被覆は inv-codex-runner.test.ts の startManagedCodex 経由テストが担う。)
 */
function buildRequestedEvent(card: CodexApprovalCard, requestId: string): NormalizedEvent {
  return buildEvent({
    session_id: SESSION,
    provider: "codex",
    source: "app_server",
    thread_id: THREAD_ID,
    event_type: "tool.permission.requested",
    state: "waiting.approval",
    summary: card.summary,
    payload: { kind: "tool.permission.requested", request_id: requestId, ...card.payload },
  });
}

/** codex-runner.ts の emitResolved builder を忠実に写した resolved NormalizedEvent。 */
function buildResolvedEvent(
  requestId: string,
  decision: ApprovalDecision | "deny",
): NormalizedEvent {
  const allowed = decision === "allow" || decision === "allow_for_session";
  return buildEvent({
    session_id: SESSION,
    provider: "codex",
    source: "app_server",
    thread_id: THREAD_ID,
    event_type: "tool.permission.resolved",
    state: allowed ? "running.tool_preparing" : "running.model_wait",
    summary: `承認 ${allowed ? "許可" : "拒否"}`,
    payload: { kind: "tool.permission.resolved", request_id: requestId, decision },
  });
}

/**
 * 実 ApprovalBridge + CodexApprovalBridge の harness。emitCard/emitResolved を捕捉し、
 * さらに **実 NormalizedEvent** を積んで projection reduceEvents へ流せるようにする。
 */
function makeHarness(timeoutMs = 50) {
  const bridge = new ApprovalBridge({ timeoutMs });
  const cards: Array<{ card: CodexApprovalCard; requestId: string }> = [];
  const resolved: Array<{ requestId: string; decision: ApprovalDecision | "deny" }> = [];
  const events: NormalizedEvent[] = [];
  const codex = new CodexApprovalBridge({
    bridge,
    sessionId: () => SESSION,
    emitCard: (card, requestId) => {
      cards.push({ card, requestId });
      events.push(buildRequestedEvent(card, requestId));
    },
    emitResolved: (requestId, decision) => {
      resolved.push({ requestId, decision });
      events.push(buildResolvedEvent(requestId, decision));
    },
    sendResponse: () => {},
  });
  return { bridge, codex, cards, resolved, events };
}

/** projection (実 foldPendingApprovals・provider 非依存) を通した pending の request_id 集合。 */
function pendingRequestIds(events: readonly NormalizedEvent[]): string[] {
  return reduceEvents(SESSION, events).pending_approvals.map((p) => p.request_id);
}

const cmdParams = (command: string) => ({
  itemId: "i1",
  threadId: "T1",
  turnId: "turn_1",
  startedAtMs: 1,
  command,
});

describe("INV-CODEX-APPROVAL-RESOLVED: operator decision → resolved emit + projection clears card", () => {
  it("allow → resolved(allow) emitted (matching request_id) + projection removes pending", async () => {
    const h = makeHarness();
    h.codex.handleServerRequest(
      1,
      "item/commandExecution/requestApproval",
      cmdParams("rm -rf /tmp/x"),
    );
    const { requestId } = h.cards[0]!;
    // 解決前: projection は当該カードを pending に持つ。
    expect(pendingRequestIds(h.events)).toContain(requestId);

    expect(h.bridge.resolve(requestId, "allow")).toBe(true);
    await flush();

    // resolved emit: matching request_id + decision。mutation: finish() の emitResolved 撤去 → 空 (赤)。
    expect(h.resolved).toEqual([{ requestId, decision: "allow" }]);
    // projection (実 reduceEvents) が pending から除去。
    expect(pendingRequestIds(h.events)).toEqual([]);
  });

  it("deny → resolved(deny) emitted + projection removes pending", async () => {
    const h = makeHarness();
    h.codex.handleServerRequest(2, "item/commandExecution/requestApproval", cmdParams("curl evil"));
    const { requestId } = h.cards[0]!;
    expect(pendingRequestIds(h.events)).toContain(requestId);

    expect(h.bridge.resolve(requestId, "deny")).toBe(true);
    await flush();

    expect(h.resolved).toEqual([{ requestId, decision: "deny" }]);
    expect(pendingRequestIds(h.events)).toEqual([]);
  });

  it("cancel → resolved(cancel) emitted (claude 語彙 pass-through) + projection removes pending", async () => {
    const h = makeHarness();
    h.codex.handleServerRequest(3, "item/commandExecution/requestApproval", cmdParams("x"));
    const { requestId } = h.cards[0]!;
    expect(h.bridge.resolve(requestId, "cancel")).toBe(true);
    await flush();
    expect(h.resolved).toEqual([{ requestId, decision: "cancel" }]);
    expect(pendingRequestIds(h.events)).toEqual([]);
  });
});

describe("INV-CODEX-APPROVAL-RESOLVED: child-exit deny (cancelInFlight)", () => {
  it("in-flight approval → cancelInFlight emits resolved(deny) + projection clears card", () => {
    const h = makeHarness();
    h.codex.handleServerRequest(4, "item/commandExecution/requestApproval", cmdParams("rm -rf /"));
    const { requestId } = h.cards[0]!;
    expect(h.codex.inFlightCount).toBe(1);
    expect(pendingRequestIds(h.events)).toContain(requestId);

    // child exit → cancelInFlight。mutation: cancelInFlight の emitResolved 撤去 → resolved 不在 (赤)。
    h.codex.cancelInFlight();

    expect(h.resolved).toEqual([{ requestId, decision: "deny" }]);
    expect(pendingRequestIds(h.events)).toEqual([]);
    expect(h.codex.inFlightCount).toBe(0);
  });
});

describe("INV-CODEX-APPROVAL-RESOLVED: timeout → deny", () => {
  it("30s bridge timeout → finish(undefined) → resolved(deny) emitted", async () => {
    vi.useFakeTimers();
    try {
      const h = makeHarness(50);
      h.codex.handleServerRequest(
        5,
        "item/commandExecution/requestApproval",
        cmdParams("dangerous"),
      );
      await vi.advanceTimersByTimeAsync(60);
      await Promise.resolve();
      await Promise.resolve();
      expect(h.resolved.length).toBe(1);
      expect(h.resolved[0]!.decision).toBe("deny");
      expect(pendingRequestIds(h.events)).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("INV-CODEX-APPROVAL-RESOLVED: NO-RAW", () => {
  // github-token 形 (redactor の \bghp_[A-Za-z0-9_]{20,255}\b にマッチ)。擬似値・本物でない。
  const SECRET = "ghp_0123456789abcdefghijABCDEFGHIJ012345";

  it("secret を含む command の承認でも resolved payload は kind/request_id/decision のみ (raw 非漏洩)", async () => {
    const h = makeHarness();
    h.codex.handleServerRequest(
      6,
      "item/commandExecution/requestApproval",
      cmdParams(`echo ${SECRET} | cat`),
    );
    const { requestId } = h.cards[0]!;
    h.bridge.resolve(requestId, "allow");
    await flush();

    const resolvedEv = h.events.find((e) => e.event_type === "tool.permission.resolved")!;
    // 構造的 NO-RAW: resolved payload は 3 フィールドのみ (command/cwd/secret を一切載せない)。
    expect(resolvedEv.payload).toEqual({
      kind: "tool.permission.resolved",
      request_id: requestId,
      decision: "allow",
    });
    const serialized = JSON.stringify(resolvedEv);
    expect(serialized).not.toContain(SECRET);
    expect(serialized).not.toContain("ghp_");
    expect(serialized).not.toContain("echo"); // raw command 断片も含まない
  });
});

describe("INV-CODEX-APPROVAL-RESOLVED: 二重 emit なし (inFlight 排他)", () => {
  it("正常解決の後に racing child exit → 当該 request_id の resolved は 1 回だけ", async () => {
    const h = makeHarness();
    h.codex.handleServerRequest(7, "item/commandExecution/requestApproval", cmdParams("x"));
    const { requestId } = h.cards[0]!;
    h.bridge.resolve(requestId, "allow");
    await flush(); // finish 実行 → resolved(allow) emit、inFlight 掃除。
    h.codex.cancelInFlight(); // 解決後の child exit: inFlight は空ゆえ再 emit しない。

    const forId = h.resolved.filter((r) => r.requestId === requestId);
    expect(forId.length).toBe(1);
    expect(forId[0]!.decision).toBe("allow");
  });

  it("deferred finish microtask の前に child exit → resolved は 1 回だけ (cancelInFlight が競合に勝つ)", async () => {
    const h = makeHarness();
    h.codex.handleServerRequest(8, "item/commandExecution/requestApproval", cmdParams("x"));
    const { requestId } = h.cards[0]!;
    h.bridge.resolve(requestId, "allow"); // .then(finish) を microtask に予約 (まだ走らない)。
    h.codex.cancelInFlight(); // 同期実行: inFlight を先掃除し resolved(deny) を emit。
    await flush(); // 予約された finish が走るが inFlight 掃除済 → early-return (二重 emit なし)。

    const forId = h.resolved.filter((r) => r.requestId === requestId);
    expect(forId.length).toBe(1);
    expect(forId[0]!.decision).toBe("deny"); // cancelInFlight が競合に勝った。
  });
});
