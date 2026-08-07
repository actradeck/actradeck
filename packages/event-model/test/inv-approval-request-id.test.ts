/**
 * INV-APPROVAL-REQUEST-ID (event-model 層・TDA-R4-12): 採番の shape/決定論契約。
 * 実 redactor 不変性 (INV-APPROVAL-REQUEST-ID-STABLE) は sidecar 側で pin する —
 * ここは event-model が単独で保証できる契約 (RE 準拠・決定論・session 分離) のみを固定し、
 * per-file coverage floor (erosion tripwire) を実効化する。
 */
import { describe, expect, it } from "vitest";

import {
  APPROVAL_REQUEST_ID_RE,
  deriveDemoApprovalRequestId,
  mintApprovalRequestId,
} from "../src/index.js";

describe("INV-APPROVAL-REQUEST-ID: 採番 shape/決定論 (event-model 契約)", () => {
  it("mint は正準 RE 準拠・呼ぶたび distinct token・同一 session は同一 tag", () => {
    const a = mintApprovalRequestId("sess-x");
    const b = mintApprovalRequestId("sess-x");
    expect(a).toMatch(APPROVAL_REQUEST_ID_RE);
    expect(b).toMatch(APPROVAL_REQUEST_ID_RE);
    expect(a).not.toBe(b); // CSPRNG token
    expect(a.slice(0, 13)).toBe(b.slice(0, 13)); // tag = sha256(session) 先頭 12hex (s prefix 込)
    expect(mintApprovalRequestId("sess-y").slice(0, 13)).not.toBe(a.slice(0, 13));
  });

  it("demo 変種は RE 準拠・決定論・session 分離 (旧形 `${sessionId}:apr-1` 回帰で RED)", () => {
    const d = deriveDemoApprovalRequestId("sess-demo");
    expect(d).toMatch(APPROVAL_REQUEST_ID_RE);
    expect(deriveDemoApprovalRequestId("sess-demo")).toBe(d);
    expect(deriveDemoApprovalRequestId("sess-demo2")).not.toBe(d);
  });
});
