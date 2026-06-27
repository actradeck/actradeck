/**
 * INV-CODEX-APPROVAL-MAP + INV-CODEX-REQID — Codex 承認双方向写像 (ADR 019ea31b (d)).
 *
 * 検証:
 *  - inbound: ServerRequest → UI 承認カード (tool.permission.requested) を emit。
 *  - outbound: UI 4 値 ApprovalDecision → codex JSON-RPC Response (decision enum)。
 *    item-namespaced (accept/acceptForSession/decline/cancel) と legacy ReviewDecision
 *    (approved/approved_for_session/denied/abort) の両系統。
 *  - permissions allow 系は MVP で送出されない (deny=空 grant のみ)。
 *  - advanced 変種 (acceptWithExecpolicyAmendment 等) は送出されない (4 値のみ)。
 *  - REQID: JSON-RPC id ↔ bridge request_id が 1:1。foreign / 未知 id の Response は無視。
 *  - timeout → 安全側 deny (decline / denied)。
 */
import { describe, expect, it, vi } from "vitest";

import { ApprovalBridge } from "../src/approval-bridge.js";
import {
  CodexApprovalBridge,
  buildApprovalResultBody,
  isCodexApprovalRequest,
  mapDecisionToItemNamespaced,
  mapDecisionToPermissionsResponse,
  mapDecisionToReviewDecision,
} from "../src/approval-bridge-codex.js";
import type { CodexApprovalCard } from "../src/approval-bridge-codex.js";
import type { CodexRequestId } from "../src/codex-jsonrpc.js";

describe("INV-CODEX-APPROVAL-MAP: outbound decision mapping", () => {
  it("item-namespaced (command/file): 4 値 → accept/acceptForSession/decline/cancel", () => {
    expect(mapDecisionToItemNamespaced("allow")).toEqual({ decision: "accept" });
    expect(mapDecisionToItemNamespaced("allow_for_session")).toEqual({
      decision: "acceptForSession",
    });
    expect(mapDecisionToItemNamespaced("deny")).toEqual({ decision: "decline" });
    expect(mapDecisionToItemNamespaced("cancel")).toEqual({ decision: "cancel" });
    // timeout/drain (undefined) → 安全側 decline。
    expect(mapDecisionToItemNamespaced(undefined)).toEqual({ decision: "decline" });
  });

  it("legacy ReviewDecision: 4 値 → approved/approved_for_session/denied/abort", () => {
    expect(mapDecisionToReviewDecision("allow")).toEqual({ decision: "approved" });
    expect(mapDecisionToReviewDecision("allow_for_session")).toEqual({
      decision: "approved_for_session",
    });
    expect(mapDecisionToReviewDecision("deny")).toEqual({ decision: "denied" });
    expect(mapDecisionToReviewDecision("cancel")).toEqual({ decision: "abort" });
    expect(mapDecisionToReviewDecision(undefined)).toEqual({ decision: "denied" });
  });

  it("permissions: MVP は deny(空 grant) のみ honor — allow 系 (profile grant) を送出しない", () => {
    // どの decision でも空 grant (= 追加権限なし = deny 相当)。
    for (const d of ["allow", "allow_for_session", "deny", "cancel", undefined] as const) {
      const body = buildApprovalResultBody("permissions", d);
      expect(body).toEqual({ permissions: {}, scope: "turn" });
      // profile grant (allow 系) が漏れていないこと。
      expect(Object.keys(body.permissions as object)).toEqual([]);
    }
    expect(mapDecisionToPermissionsResponse()).toEqual({ permissions: {}, scope: "turn" });
  });

  it("advanced 変種 (acceptWithExecpolicyAmendment / applyNetworkPolicyAmendment) を送出しない", () => {
    // 全 4 値の出力 decision が単純 string enum のみ (object 変種を含まない)。
    for (const kind of ["command", "file", "legacy-exec", "legacy-patch"] as const) {
      for (const d of ["allow", "allow_for_session", "deny", "cancel"] as const) {
        const body = buildApprovalResultBody(kind, d) as { decision: unknown };
        expect(typeof body.decision).toBe("string");
        expect(body.decision).not.toMatch(/Amendment/i);
      }
    }
  });

  it("isCodexApprovalRequest: 承認 method のみ true (legacy alias 含む)", () => {
    for (const m of [
      "item/commandExecution/requestApproval",
      "item/fileChange/requestApproval",
      "item/permissions/requestApproval",
      "execCommandApproval",
      "applyPatchApproval",
    ]) {
      expect(isCodexApprovalRequest(m)).toBe(true);
    }
    for (const m of ["turn/started", "item/started", "thread/closed", "unknown"]) {
      expect(isCodexApprovalRequest(m)).toBe(false);
    }
  });
});

/** promise chain (.then(finish)) を確実に解決させる。 */
async function flush(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
}

/** テスト用 harness: CodexApprovalBridge を実 ApprovalBridge で駆動し emit/response を捕捉する。 */
function makeHarness(timeoutMs = 50) {
  const bridge = new ApprovalBridge({ timeoutMs });
  const cards: Array<{ card: CodexApprovalCard; requestId: string }> = [];
  const responses: Array<{ id: CodexRequestId; result: Record<string, unknown> }> = [];
  const codex = new CodexApprovalBridge({
    bridge,
    sessionId: () => "sess_test",
    emitCard: (card, requestId) => cards.push({ card, requestId }),
    sendResponse: (id, result) => responses.push({ id, result }),
  });
  return { bridge, codex, cards, responses };
}

describe("INV-CODEX-APPROVAL-MAP: inbound → card → resolve → codex Response", () => {
  it("command requestApproval: emits high card, allow → accept Response (1:1 id)", async () => {
    const h = makeHarness();
    const handled = h.codex.handleServerRequest(42, "item/commandExecution/requestApproval", {
      itemId: "i1",
      threadId: "T1",
      turnId: "turn_1",
      startedAtMs: 1,
      command: "rm -rf /tmp/x",
      cwd: "/repo",
      reason: "cleanup",
    });
    expect(handled).toBe(true);
    expect(h.cards.length).toBe(1);
    const { requestId, card } = h.cards[0]!;
    expect(card.payload.risk_level).toBe("high");
    expect(card.payload.command).toBe("rm -rf /tmp/x");

    // UI が approve (allow) → bridge.resolve → codex Response。
    expect(h.bridge.resolve(requestId, "allow")).toBe(true);
    await flush();
    expect(h.responses.length).toBe(1);
    expect(h.responses[0]!.id).toBe(42);
    expect(h.responses[0]!.result).toEqual({ decision: "accept" });
  });

  it("file requestApproval: emits medium card, cancel → cancel Response", async () => {
    const h = makeHarness();
    h.codex.handleServerRequest("abc", "item/fileChange/requestApproval", {
      itemId: "i2",
      threadId: "T1",
      turnId: "turn_1",
      startedAtMs: 1,
      grantRoot: "/repo",
      reason: "extra write",
    });
    expect(h.cards[0]!.card.payload.risk_level).toBe("medium");
    h.bridge.resolve(h.cards[0]!.requestId, "cancel");
    await flush();
    expect(h.responses[0]!.id).toBe("abc");
    expect(h.responses[0]!.result).toEqual({ decision: "cancel" });
  });

  it("legacy execCommandApproval: deny → denied (ReviewDecision)", async () => {
    const h = makeHarness();
    h.codex.handleServerRequest(7, "execCommandApproval", {
      callId: "call1",
      conversationId: "T1",
      command: ["git", "push", "--force"],
      cwd: "/repo",
      parsedCmd: [],
    });
    expect(h.cards[0]!.card.payload.command).toBe("git push --force");
    h.bridge.resolve(h.cards[0]!.requestId, "deny");
    await flush();
    expect(h.responses[0]!.result).toEqual({ decision: "denied" });
  });

  it("permissions requestApproval: allow → 空 grant のみ (MVP deny)", async () => {
    const h = makeHarness();
    h.codex.handleServerRequest(9, "item/permissions/requestApproval", {
      itemId: "i3",
      threadId: "T1",
      turnId: "turn_1",
      startedAtMs: 1,
      cwd: "/repo",
      permissions: { some: "profile" },
    });
    h.bridge.resolve(h.cards[0]!.requestId, "allow");
    await flush();
    // allow でも空 grant (profile grant を送出しない)。
    expect(h.responses[0]!.result).toEqual({ permissions: {}, scope: "turn" });
  });

  it("timeout → 安全側 deny (decline) Response", async () => {
    vi.useFakeTimers();
    try {
      const h = makeHarness(50);
      h.codex.handleServerRequest(11, "item/commandExecution/requestApproval", {
        itemId: "i1",
        threadId: "T1",
        turnId: "turn_1",
        startedAtMs: 1,
        command: "dangerous",
      });
      await vi.advanceTimersByTimeAsync(60);
      // microtask flush
      await Promise.resolve();
      await Promise.resolve();
      expect(h.responses.length).toBe(1);
      expect(h.responses[0]!.result).toEqual({ decision: "decline" });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("INV-CODEX-AUTOGUARD (ADR 019ecc70 段階2): codex 承認の secret-in-input 検出", () => {
  // github-token 形 (redactor の \bghp_[A-Za-z0-9_]{20,255}\b にマッチ)。擬似値・本物でない。
  //   裸トークンを使う (KEY=VALUE 形にすると credential-assignment が先に値を潰し kind が変わるため)。
  const SECRET = "ghp_0123456789abcdefghijABCDEFGHIJ012345";
  const SECRET_CMD = `echo ${SECRET} | cat`;

  it("command に secret → trigger=both + secret_kinds=[github-token]・NO-RAW (kind 名のみ)", () => {
    const h = makeHarness();
    h.codex.handleServerRequest(1, "item/commandExecution/requestApproval", {
      itemId: "i1",
      threadId: "T1",
      turnId: "turn_1",
      startedAtMs: 1,
      command: SECRET_CMD,
    });
    expect(h.cards.length).toBe(1);
    const payload = h.cards[0]!.card.payload;
    expect(payload.trigger).toBe("both"); // destructive(常時) + secret 検出
    expect(payload.secret_kinds).toContain("github-token");
    // NO-RAW: secret_kinds は kind 名のみ・raw token を含まない。
    expect(JSON.stringify(payload.secret_kinds)).not.toContain(SECRET);
    expect(JSON.stringify(payload.secret_kinds)).not.toContain("ghp_");
  });

  it("command に secret 無し → trigger=destructive・secret_kinds 無し (非退行)", () => {
    const h = makeHarness();
    h.codex.handleServerRequest(2, "item/commandExecution/requestApproval", {
      itemId: "i1",
      threadId: "T1",
      turnId: "turn_1",
      startedAtMs: 1,
      command: "ls -la /tmp",
    });
    const payload = h.cards[0]!.card.payload;
    expect(payload.trigger).toBe("destructive");
    expect(payload.secret_kinds).toBeUndefined();
  });

  it("legacy execCommandApproval (command array) に secret → 検出される", () => {
    const h = makeHarness();
    h.codex.handleServerRequest(3, "execCommandApproval", {
      callId: "c1",
      conversationId: "T1",
      command: ["bash", "-c", SECRET_CMD],
      cwd: "/repo",
      parsedCmd: [],
    });
    const payload = h.cards[0]!.card.payload;
    expect(payload.trigger).toBe("both");
    expect(payload.secret_kinds).toContain("github-token");
  });

  it("legacy applyPatchApproval (fileChanges 内容) に secret → 検出される", () => {
    const h = makeHarness();
    h.codex.handleServerRequest(4, "applyPatchApproval", {
      callId: "c1",
      conversationId: "T1",
      fileChanges: { "config.ts": { content: `const k = "${SECRET}";` } },
      grantRoot: "/repo",
    });
    const payload = h.cards[0]!.card.payload;
    expect(payload.trigger).toBe("both");
    expect(payload.secret_kinds).toContain("github-token");
    expect(JSON.stringify(payload.secret_kinds)).not.toContain(SECRET);
  });

  it("file (item/fileChange) は承認 params に本文が無く secret 走査不可・常時ゲートのみ (trigger=destructive)", () => {
    const h = makeHarness();
    h.codex.handleServerRequest(5, "item/fileChange/requestApproval", {
      itemId: "i2",
      threadId: "T1",
      turnId: "turn_1",
      startedAtMs: 1,
      grantRoot: "/repo",
    });
    expect(h.cards.length).toBe(1); // 常時ゲートは維持
    const payload = h.cards[0]!.card.payload;
    expect(payload.trigger).toBe("destructive");
    expect(payload.secret_kinds).toBeUndefined();
  });

  it("D5: secret-trigger は allow_for_session でも次の同一要求を auto-allow しない (再カード)", async () => {
    const h = makeHarness();
    const params = {
      itemId: "i1",
      threadId: "T1",
      turnId: "turn_1",
      startedAtMs: 1,
      command: SECRET_CMD,
    };
    h.codex.handleServerRequest(10, "item/commandExecution/requestApproval", params);
    expect(h.cards.length).toBe(1);
    h.bridge.resolve(h.cards[0]!.requestId, "allow_for_session");
    await flush();
    // 同一署名の 2 回目: secret-trigger ゆえ cache をバイパスし再びカードを出す (auto-allow しない)。
    h.codex.handleServerRequest(11, "item/commandExecution/requestApproval", params);
    expect(h.cards.length).toBe(2);
  });

  it("D5 対比: 非 secret は allow_for_session 後の同一要求を auto-allow (カード再発行なし)", async () => {
    const h = makeHarness();
    const params = {
      itemId: "i1",
      threadId: "T1",
      turnId: "turn_1",
      startedAtMs: 1,
      command: "ls -la /tmp",
    };
    h.codex.handleServerRequest(20, "item/commandExecution/requestApproval", params);
    expect(h.cards.length).toBe(1);
    h.bridge.resolve(h.cards[0]!.requestId, "allow_for_session");
    await flush();
    // 同一署名の 2 回目: destructive-only ゆえ cache 命中で auto-allow (UI カードを再発行しない)。
    //   ここでの主眼は「secret=再カード(D5) ⇔ 非secret=auto-allow(再カード無し)」の対比。
    h.codex.handleServerRequest(21, "item/commandExecution/requestApproval", params);
    await flush();
    expect(h.cards.length).toBe(1); // 再カード無し (= cache 命中で auto-allow された)
    expect(h.responses.length).toBe(2); // 2 回とも Response は出る
    // bug 019ee033: auto-allow の codex Response は accept でなければならない (旧実装は
    //   result.decision 未設定 → decline 写像で「許可したはずが拒否」になっていた)。
    expect(h.responses[0]!.result).toEqual({ decision: "acceptForSession" }); // 1 回目=人間 allow_for_session
    expect(h.responses[1]!.result).toEqual({ decision: "accept" }); // 2 回目=auto-allow → accept
  });

  it("bug 019ee033: allow_for_session 後の auto-allow が codex Response=accept (decline でない)", async () => {
    const h = makeHarness();
    const params = {
      itemId: "i1",
      threadId: "T1",
      turnId: "turn_1",
      startedAtMs: 1,
      command: "rm -rf /tmp/scratch", // 非 secret の destructive (cache 対象)
    };
    // 1 回目: 人間が allow_for_session → 署名を session-allow cache へ登録。
    h.codex.handleServerRequest(30, "item/commandExecution/requestApproval", params);
    expect(h.cards.length).toBe(1);
    h.bridge.resolve(h.cards[0]!.requestId, "allow_for_session");
    await flush();
    expect(h.responses[0]!.result).toEqual({ decision: "acceptForSession" });
    // 2 回目: 同一署名 → cache 命中で auto-allow (behavior:"allow", decision 未設定)。
    //   codex Response は accept でなければならない (旧バグ: undefined → decline)。
    h.codex.handleServerRequest(31, "item/commandExecution/requestApproval", params);
    await flush();
    expect(h.cards.length).toBe(1); // カード再発行なし (auto-allow)
    expect(h.responses.length).toBe(2);
    expect(h.responses[1]!.result).toEqual({ decision: "accept" });
  });

  it("bug 019ee033 (legacy-exec): allow_for_session 後の auto-allow が ReviewDecision=approved", async () => {
    const h = makeHarness();
    // legacy-exec は command を配列で受ける (buildGateInput が array→join で署名化)。
    const params = {
      itemId: "i1",
      threadId: "T1",
      turnId: "turn_1",
      startedAtMs: 1,
      command: ["rm", "-rf", "/tmp/scratch"],
    };
    h.codex.handleServerRequest(40, "execCommandApproval", params);
    expect(h.cards.length).toBe(1);
    h.bridge.resolve(h.cards[0]!.requestId, "allow_for_session");
    await flush();
    expect(h.responses[0]!.result).toEqual({ decision: "approved_for_session" });
    // 同一署名の 2 回目: cache 命中で auto-allow → legacy ReviewDecision=approved (旧バグ: denied)。
    h.codex.handleServerRequest(41, "execCommandApproval", params);
    await flush();
    expect(h.cards.length).toBe(1);
    expect(h.responses.length).toBe(2);
    expect(h.responses[1]!.result).toEqual({ decision: "approved" });
  });
});

describe("INV-CODEX-REQID: 1:1 突合 / foreign id 無視", () => {
  it("foreign request_id の resolve は突合せず Response を出さない", async () => {
    const h = makeHarness();
    h.codex.handleServerRequest(1, "item/commandExecution/requestApproval", {
      itemId: "i1",
      threadId: "T1",
      turnId: "turn_1",
      startedAtMs: 1,
      command: "x",
    });
    // bridge に存在しない request_id を resolve → false。
    expect(h.bridge.resolve("sess_test:apr-FOREIGN", "allow")).toBe(false);
    await Promise.resolve();
    expect(h.responses.length).toBe(0);
    // 正しい request_id なら 1 件だけ Response。
    h.bridge.resolve(h.cards[0]!.requestId, "allow");
    await flush();
    expect(h.responses.length).toBe(1);
    expect(h.responses[0]!.id).toBe(1);
  });

  it("同一 codex id の二重受信は 1 枚のカードのみ (idempotent)", () => {
    const h = makeHarness();
    const p = { itemId: "i1", threadId: "T1", turnId: "turn_1", startedAtMs: 1, command: "x" };
    h.codex.handleServerRequest(5, "item/commandExecution/requestApproval", p);
    h.codex.handleServerRequest(5, "item/commandExecution/requestApproval", p);
    expect(h.cards.length).toBe(1);
    expect(h.codex.inFlightCount).toBe(1);
  });

  it("non-approval method は false (呼び出し側が通常経路へ)", () => {
    const h = makeHarness();
    expect(h.codex.handleServerRequest(1, "mcpServer/elicitation/request", {})).toBe(false);
    expect(h.cards.length).toBe(0);
  });
});
