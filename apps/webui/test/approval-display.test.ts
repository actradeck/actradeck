/**
 * 承認カードの表示派生 (純関数) の契約テスト — ADR 019e9999 段階②.
 *
 * D3 (楽観更新しない): ack が来るまで "送信中"、ok=false / error は "failed" として
 *   絶対に「許可済み」へ倒さない。
 * D4 (allow/deny 2 値): decision の往復が allow→allowed / deny→denied。
 * SEC: primary text は command(redacted) → path → tool_name の順で、生 tool_input を参照しない。
 */
import { describe, expect, it } from "vitest";

import {
  ackPhase,
  ackPhaseLabel,
  ackResolvedOrSending,
  allowRequiresAck,
  approvalPrimaryText,
  approvalTimeRemainingMs,
  buildApproveFrame,
  interruptEnabledForState,
  markApproveSending,
  reduceApproveAck,
  riskTone,
  type AckState,
} from "../src/ui/approval-display.js";

import type { PendingApproval } from "../src/realtime/contract.js";

function approval(o: Partial<PendingApproval> = {}): PendingApproval {
  return {
    request_id: "req-1",
    tool_name: "Bash",
    command: undefined,
    path: undefined,
    risk_level: undefined,
    requested_at: "2026-06-05T00:00:00.000Z",
    session_id: "s1",
    trigger: undefined,
    secret_kinds: undefined,
    persistable: undefined,
    ...o,
  };
}

describe("ackPhase (D3: 楽観更新しない)", () => {
  it("undefined ack → pending (未送信)", () => {
    expect(ackPhase(undefined)).toBe("pending");
  });

  it("ok=undefined → sending (ack 待ち)", () => {
    const ack: AckState = { decision: "allow", ok: undefined, error: undefined };
    expect(ackPhase(ack)).toBe("sending");
  });

  it("ok=true allow → allowed / deny → denied", () => {
    expect(ackPhase({ decision: "allow", ok: true, error: undefined })).toBe("allowed");
    expect(ackPhase({ decision: "deny", ok: true, error: undefined })).toBe("denied");
  });

  it("段階③ 4 値: allow_for_session → allowed_for_session / cancel → cancelled", () => {
    expect(ackPhase({ decision: "allow_for_session", ok: true, error: undefined })).toBe(
      "allowed_for_session",
    );
    expect(ackPhase({ decision: "cancel", ok: true, error: undefined })).toBe("cancelled");
  });

  it("4 値とも ok=false / error は failed (どの decision も許可済みに倒さない・D3)", () => {
    expect(ackPhase({ decision: "allow_for_session", ok: false, error: undefined })).toBe("failed");
    expect(ackPhase({ decision: "cancel", ok: true, error: "relay closed" })).toBe("failed");
  });

  it("ok=false は decision に関わらず failed (許可済みに倒さない)", () => {
    expect(ackPhase({ decision: "allow", ok: false, error: undefined })).toBe("failed");
    expect(ackPhase({ decision: "deny", ok: false, error: undefined })).toBe("failed");
  });

  it("error 付きは ok=true でも failed (relay 失敗を成功表示しない)", () => {
    expect(ackPhase({ decision: "allow", ok: true, error: "relay closed" })).toBe("failed");
  });
});

describe("ackPhaseLabel", () => {
  it("各フェーズに日本語ラベルを返す", () => {
    expect(ackPhaseLabel("pending")).toBe("未対応");
    expect(ackPhaseLabel("sending")).toBe("送信中…");
    expect(ackPhaseLabel("allowed")).toBe("許可を送信しました");
    expect(ackPhaseLabel("denied")).toBe("拒否を送信しました");
    expect(ackPhaseLabel("failed")).toContain("中継に失敗");
  });

  it("段階③ 4 値: allow_for_session / cancel のラベル", () => {
    expect(ackPhaseLabel("allowed_for_session")).toBe("セッション中は許可を送信しました");
    expect(ackPhaseLabel("cancelled")).toBe("取消を送信しました");
  });
});

describe("ackResolvedOrSending (二重送信防止)", () => {
  it("sending/allowed/denied は true、pending/failed は false (再試行可)", () => {
    expect(ackResolvedOrSending("sending")).toBe(true);
    expect(ackResolvedOrSending("allowed")).toBe(true);
    expect(ackResolvedOrSending("denied")).toBe(true);
    expect(ackResolvedOrSending("pending")).toBe(false);
    expect(ackResolvedOrSending("failed")).toBe(false);
  });

  it("段階③ 4 値の確定フェーズ (allowed_for_session/cancelled) も二重送信を抑止する", () => {
    expect(ackResolvedOrSending("allowed_for_session")).toBe(true);
    expect(ackResolvedOrSending("cancelled")).toBe(true);
  });
});

describe("riskTone", () => {
  it("high/medium/low を対応トーンへ、未知は muted", () => {
    expect(riskTone("high")).toBe("high");
    expect(riskTone("medium")).toBe("warn");
    expect(riskTone("low")).toBe("ok");
    expect(riskTone(undefined)).toBe("muted");
    expect(riskTone("weird")).toBe("muted");
  });
});

describe("allowRequiresAck (段階2: 高リスク allow ゲート / INV-INBOX-HIGHRISK-DENY-DEFAULT)", () => {
  it("high のみ allow を明示確認でゲート、medium/low/未知はゲートしない", () => {
    expect(allowRequiresAck("high")).toBe(true);
    expect(allowRequiresAck("medium")).toBe(false);
    expect(allowRequiresAck("low")).toBe(false);
    expect(allowRequiresAck(undefined)).toBe(false);
    expect(allowRequiresAck("weird")).toBe(false);
  });
});

describe("approvalPrimaryText (SEC: redaction 済み値のみ・優先順)", () => {
  it("command(redacted) を最優先", () => {
    expect(approvalPrimaryText(approval({ command: "pnpm test", path: "/x" }))).toBe("pnpm test");
  });

  it("command 無しなら path", () => {
    expect(approvalPrimaryText(approval({ command: undefined, path: "/etc/hosts" }))).toBe(
      "/etc/hosts",
    );
  });

  it("command/path 無しなら tool_name", () => {
    expect(
      approvalPrimaryText(approval({ command: undefined, path: undefined, tool_name: "Edit" })),
    ).toBe("Edit");
  });

  it("いずれも無ければ request_id へフォールバック", () => {
    expect(
      approvalPrimaryText(
        approval({ command: undefined, path: undefined, tool_name: undefined, request_id: "r9" }),
      ),
    ).toBe("r9");
  });
});

describe("buildApproveFrame (T1 ClientFrame 追従・単一出所)", () => {
  it("allow を request_id/session_id 同梱で構築", () => {
    const f = buildApproveFrame("s1", "req-1", "allow");
    expect(f).toEqual({
      type: "approve",
      session_id: "s1",
      request_id: "req-1",
      decision: "allow",
    });
  });

  it("deny + reason を載せる", () => {
    const f = buildApproveFrame("s1", "req-2", "deny", "looks risky");
    expect(f.decision).toBe("deny");
    expect("reason" in f && f.reason).toBe("looks risky");
  });

  it("reason undefined はキーごと落とす", () => {
    const f = buildApproveFrame("s1", "req-3", "allow", undefined);
    expect("reason" in f).toBe(false);
  });

  it("段階③ 4 値 (allow_for_session/cancel) を decision にそのまま載せる", () => {
    expect(buildApproveFrame("s1", "req-4", "allow_for_session").decision).toBe(
      "allow_for_session",
    );
    expect(buildApproveFrame("s1", "req-5", "cancel").decision).toBe("cancel");
  });

  it("ADR 019ee0c0: persist=true で persist:true を載せる (再起動後も許可)", () => {
    const f = buildApproveFrame("s1", "req-6", "allow_for_session", undefined, true);
    expect("persist" in f && f.persist).toBe(true);
    expect(f.decision).toBe("allow_for_session");
  });

  it("persist 省略 / false はキーごと落とす (fail-safe)", () => {
    expect("persist" in buildApproveFrame("s1", "req-7", "allow_for_session")).toBe(false);
    expect(
      "persist" in buildApproveFrame("s1", "req-8", "allow_for_session", undefined, false),
    ).toBe(false);
  });
});

describe("approvalTimeRemainingMs (段階③ timeout UX・推定値)", () => {
  const t0 = "2026-06-05T00:00:00.000Z";
  const t0ms = Date.parse(t0);

  it("要求直後は満額 (既定 30s) 近辺を返す", () => {
    expect(approvalTimeRemainingMs(t0, t0ms)).toBe(30_000);
  });

  it("経過分を差し引く (10s 経過 → 残り 20s)", () => {
    expect(approvalTimeRemainingMs(t0, t0ms + 10_000)).toBe(20_000);
  });

  it("timeout 到達/超過は 0 にクランプ (負値を返さない)", () => {
    expect(approvalTimeRemainingMs(t0, t0ms + 30_000)).toBe(0);
    expect(approvalTimeRemainingMs(t0, t0ms + 45_000)).toBe(0);
  });

  it("timeoutMs を上書きできる (実 timeout 不明のため推定パラメータ)", () => {
    expect(approvalTimeRemainingMs(t0, t0ms, 10_000)).toBe(10_000);
    expect(approvalTimeRemainingMs(t0, t0ms + 6_000, 10_000)).toBe(4_000);
  });

  it("不正/空の requested_at は推定不能 → 満額を返す (突然 0 で慌てさせない・安全側)", () => {
    expect(approvalTimeRemainingMs("", t0ms)).toBe(30_000);
    expect(approvalTimeRemainingMs("not-a-date", t0ms, 10_000)).toBe(10_000);
  });
});

describe("interruptEnabledForState (段階③ interrupt 配線・D5)", () => {
  it("非 terminal の live/running/waiting/compacting/starting では true", () => {
    expect(interruptEnabledForState("live")).toBe(true);
    expect(interruptEnabledForState("running.tool")).toBe(true);
    expect(interruptEnabledForState("running.command_executing")).toBe(true);
    expect(interruptEnabledForState("waiting.approval")).toBe(true);
    expect(interruptEnabledForState("waiting.user_input")).toBe(true);
    expect(interruptEnabledForState("compacting")).toBe(true);
    expect(interruptEnabledForState("starting")).toBe(true);
  });

  it("terminal (completed/failed/interrupted) では false (中断は無意味)", () => {
    expect(interruptEnabledForState("completed")).toBe(false);
    expect(interruptEnabledForState("failed")).toBe(false);
    expect(interruptEnabledForState("interrupted")).toBe(false);
  });

  it("state 不明 (undefined) は安全側で false", () => {
    expect(interruptEnabledForState(undefined)).toBe(false);
  });
});

describe("markApproveSending / reduceApproveAck (D3 ライフサイクル・request_id 独立)", () => {
  it("送信で sending を立て、ack で ok/error を上書きし decision を保持", () => {
    let m: ReadonlyMap<string, AckState> = new Map();
    m = markApproveSending(m, "req-1", "allow");
    expect(ackPhase(m.get("req-1"))).toBe("sending");

    m = reduceApproveAck(m, { request_id: "req-1", ok: true, error: undefined });
    expect(m.get("req-1")?.decision).toBe("allow"); // 送信時 decision を保持
    expect(ackPhase(m.get("req-1"))).toBe("allowed");
  });

  it("ok=false / error は failed (許可済みに倒さない)", () => {
    let m: ReadonlyMap<string, AckState> = markApproveSending(new Map(), "req-1", "allow");
    m = reduceApproveAck(m, { request_id: "req-1", ok: false, error: "relay closed" });
    expect(ackPhase(m.get("req-1"))).toBe("failed");
    expect(m.get("req-1")?.error).toBe("relay closed");
  });

  it("複数 request_id を独立に保持する (相互汚染しない)", () => {
    let m: ReadonlyMap<string, AckState> = markApproveSending(new Map(), "req-A", "allow");
    m = markApproveSending(m, "req-B", "deny");
    m = reduceApproveAck(m, { request_id: "req-A", ok: true, error: undefined });
    // A は確定 (allowed)、B は未だ sending のまま。
    expect(ackPhase(m.get("req-A"))).toBe("allowed");
    expect(ackPhase(m.get("req-B"))).toBe("sending");
    m = reduceApproveAck(m, { request_id: "req-B", ok: true, error: undefined });
    expect(ackPhase(m.get("req-B"))).toBe("denied");
    expect(ackPhase(m.get("req-A"))).toBe("allowed"); // A は影響を受けない
  });

  it("送信前に届いた ack は decision 不明 → deny 既定で誤許可しない", () => {
    const m = reduceApproveAck(new Map(), { request_id: "req-x", ok: true, error: undefined });
    expect(m.get("req-x")?.decision).toBe("deny");
    expect(ackPhase(m.get("req-x"))).toBe("denied");
  });

  it("入力 Map を変異させない (純関数)", () => {
    const orig: ReadonlyMap<string, AckState> = new Map();
    const out = markApproveSending(orig, "req-1", "allow");
    expect(orig.size).toBe(0);
    expect(out.size).toBe(1);
  });
});
