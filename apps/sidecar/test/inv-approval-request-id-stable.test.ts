/**
 * INV-APPROVAL-REQUEST-ID-STABLE — 承認 request_id の redaction-stable 契約 (SEC-1・Phase 4 監査 R2)。
 *
 * 背景: 旧採番 `${sessionId}:apr-…` は raw session_id を payload.request_id へ露出していた。
 * `sess_<uuidv7>` 形 (41 文字の単一 charset run) の session_id は redaction high-entropy ルール
 * (40 文字以上 + 複数 class) に合致し、ingress 床が request_id の prefix を `[REDACTED:…]` に置換。
 * at-rest (DB/UI) と bridge Map (raw) の id 空間が割れ、①UI approve relay の resolve no-op
 * ②Phase 4 reconcile の「宣言に無い」誤判定 → 生存 pending の合成 cancel、を引き起こした。
 *
 * 本テストは **実 redactor** (合成 regex でない) を通して:
 *  (a) mintApprovalRequestId の産物が redaction を透過する (全 session id shape で不変)
 *  (b) 旧形式が sess_<uuidv7> で実際に壊れることの再現 (この hazard が消えたら (a) は vacuous
 *      になるため、redaction 側の閾値変更を検知する coupling pin)
 *  (c) pendingRequestIds() 宣言と at-rest の空間一致 (bridge 実採番 → 実 redactor 透過)
 * を回帰固定する。id 形式・redaction 閾値のどちらを変えてもここが赤くなる。
 */
import { describe, expect, it } from "vitest";

import { redactEventWithAuthoritativeCounts } from "@actradeck/redaction";

import { ApprovalBridge, mintApprovalRequestId } from "../src/approval-bridge.js";
import type { HookCommonInput } from "../src/normalize.js";

/** SEC-1 再現ベクタ: mintSyntheticSessionId 形 (sess_ + uuidv7 = 41 文字の単一 charset run)。 */
const SYNTHETIC_SESSION_ID = "sess_0199f0a1-2b3c-7d4e-8f01-23456789abcd";

const SESSION_ID_VECTORS: readonly string[] = [
  "0199f0a1-2b3c-7d4e-8f01-23456789abcd", // 素の uuid (attach 実 session)
  SYNTHETIC_SESSION_ID, // mintSyntheticSessionId 形 (旧形式で redaction を踏む)
  "s1", // テスト/デモの短い id
  "a".repeat(64), // 異常に長い id でも tag 化で安定
];

function requestedEvent(sessionId: string, requestId: string): Record<string, unknown> {
  return {
    event_id: "e1",
    session_id: sessionId,
    ts: "2026-08-06T00:00:00Z",
    source: "hook",
    provider: "claude-code",
    payload: {
      kind: "tool.permission.requested",
      request_id: requestId,
      tool_name: "Bash",
      summary: "approval request",
    },
  };
}

function redactedRequestId(sessionId: string, requestId: string): unknown {
  const out = redactEventWithAuthoritativeCounts(requestedEvent(sessionId, requestId)) as {
    payload?: { request_id?: unknown };
  };
  return out.payload?.request_id;
}

describe("INV-APPROVAL-REQUEST-ID-STABLE (SEC-1 R2): request_id は redaction を透過する", () => {
  it("(a) mintApprovalRequestId の産物は全 session id shape で redaction 不変", () => {
    for (const sessionId of SESSION_ID_VECTORS) {
      const requestId = mintApprovalRequestId(sessionId);
      // 形式: s<12hex>:apr-<base64url> — どの charset run も high-entropy 閾値 (40) 未満。
      expect(requestId).toMatch(/^s[0-9a-f]{12}:apr-[A-Za-z0-9_-]{20,}$/);
      expect(redactedRequestId(sessionId, requestId)).toBe(requestId);
    }
  });

  it("(b) 旧形式 (raw session_id prefix) は sess_<uuidv7> で実際に redaction を踏む (hazard 再現 pin)", () => {
    const legacyId = `${SYNTHETIC_SESSION_ID}:apr-F9aSKs-LnHcbygXAZ16NLQ`;
    const atRest = redactedRequestId(SYNTHETIC_SESSION_ID, legacyId);
    // 旧形式が壊れなくなったら (redaction 閾値変更等)、(a) の保証根拠が変わったということ —
    // このテストを更新する前に mintApprovalRequestId の契約を再監査すること。
    expect(atRest).not.toBe(legacyId);
    expect(String(atRest)).toContain("[REDACTED:");
  });

  it("(c) bridge 実採番の pendingRequestIds() 宣言は at-rest と同一空間 (実 redactor 透過)", async () => {
    const bridge = new ApprovalBridge({ timeoutMs: 50 });
    const input: HookCommonInput = {
      session_id: SYNTHETIC_SESSION_ID,
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "rm -rf /tmp/x" },
    };
    const done = bridge.requestApproval(input, () => {});
    const declared = bridge.pendingRequestIds();
    expect(declared).toHaveLength(1);
    const requestId = declared[0]!;
    // 宣言値をそのまま requested イベントに載せて実 redactor を通しても不変 =
    // hello 宣言 (raw) と DB pending (at-rest) が突合可能。
    expect(redactedRequestId(SYNTHETIC_SESSION_ID, requestId)).toBe(requestId);
    await done; // timeout deny で回収 (リーク防止)
  });
});
