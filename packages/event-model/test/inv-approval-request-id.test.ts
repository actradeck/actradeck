/**
 * INV-APPROVAL-REQUEST-ID (event-model 層・TDA-R4-12): 採番の shape/決定論契約。
 * 実 redactor 不変性 (INV-APPROVAL-REQUEST-ID-STABLE) は sidecar 側で pin する —
 * ここは event-model が単独で保証できる契約 (RE 準拠・決定論・session 分離) のみを固定し、
 * per-file coverage floor (erosion tripwire) を実効化する。
 */
import { describe, expect, it } from "vitest";

import {
  APPROVAL_REQUEST_ID_RE,
  LEGACY_APPROVAL_REQUEST_ID_RES,
  deriveDemoApprovalRequestId,
  isRetirableApprovalRequestId,
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

/**
 * INV-APPROVAL-REQUEST-ID-RETIRABLE (SEC-R5-2 landing・task 019fd80f):
 * reconciler の DB 側ゲートが消費する「合成 retire 対象になりうる形」の閉じた判定。
 * 正準 OR known-legacy のみ true。mangled / 別 namespace / 未知形は false (消さない方向)。
 */
describe("INV-APPROVAL-REQUEST-ID-RETIRABLE: 正準 OR known-legacy のみ retire 対象", () => {
  const CANON = "s0123456789ab:apr-0123456789abcdef0123456789abcdef";
  /** v0.1.0〜v0.6.0 出荷形 (sidecar bridge): `${sessionId}:apr-<base64url 22>` (実 corpus 形・sess_<uuidv7> prefix)。 */
  const LEGACY_B64 = "sess_0199f0a1-2b3c-7d4e-8f01-23456789abcd:apr-F9aSKs-LnHcbygXAZ16NLQ";
  /** v0.4.0〜v0.6.0 出荷形 (backend safety-demo-driver): `${sessionId}:apr-1` (SEC-V9-2)。 */
  const LEGACY_DEMO = "0199f0a1-2b3c-7d4e-8f01-23456789abcd:apr-1";
  /** それ以前のコード履歴形: `${sessionId}:apr-<Date.now()>-<seq>`。 */
  const LEGACY_SEQ = "0199f0a1-2b3c-7d4e-8f01-23456789abcd:apr-1754450000000-3";

  it("正準形 (mint / demo / literal) は retirable", () => {
    expect(isRetirableApprovalRequestId(CANON)).toBe(true);
    expect(isRetirableApprovalRequestId(mintApprovalRequestId("sess-x"))).toBe(true);
    expect(isRetirableApprovalRequestId(deriveDemoApprovalRequestId("sess-x"))).toBe(true);
  });

  it("known-legacy 3 形は retirable (CHANGELOG 0.7.0 の designed recovery を壊さない)", () => {
    expect(isRetirableApprovalRequestId(LEGACY_B64)).toBe(true);
    expect(isRetirableApprovalRequestId(LEGACY_DEMO)).toBe(true);
    expect(
      isRetirableApprovalRequestId("sess_0199f0a1-2b3c-7d4e-8f01-23456789abcd:apr-999999999"),
    ).toBe(true); // 連番は 9 桁まで (10 桁は下の非対象ベクタ)
    expect(isRetirableApprovalRequestId(LEGACY_SEQ)).toBe(true);
    // 列挙は閉じている (追加のみ・削除禁止): 3 形のどれかが消えたら RED。
    expect(LEGACY_APPROVAL_REQUEST_ID_RES).toHaveLength(3);
    expect(Object.isFrozen(LEGACY_APPROVAL_REQUEST_ID_RES)).toBe(true);
  });

  it("適合宣言に載り得ない id は retirable でない (mangled / tu: namespace / 未知形)", () => {
    for (const id of [
      // redaction marker が prefix / token を置換した mangled 形 (宣言 raw ≠ at-rest)。
      "[REDACTED:high-entropy]:apr-F9aSKs-LnHcbygXAZ16NLQ",
      "sess_0199f0a1-2b3c-7d4e-8f01-23456789abcd:apr-[REDACTED:slack-token]",
      "s0123456789ab:apr-[REDACTED:hex-token]",
      // command 相関の別 namespace (INV-REQUEST-ID-NAMESPACE・QA-4)。
      "tu:toolu_01ABCDEFGHIJKLMNOPQRSTUV",
      "tu:s1:apr-F9aSKs-LnHcbygXAZ16NLQ",
      // 未知形 / 境界外。
      "",
      "s1:apr-stale",
      "s0123456789ab:apr-0123456789abcdef0123456789abcde", // 31 hex
      "s0123456789ab:apr-0123456789ABCDEF0123456789ABCDEF", // 大文字 hex は正準外
      "sess x:apr-F9aSKs-LnHcbygXAZ16NLQ", // prefix に空白
      "sess:x:apr-F9aSKs-LnHcbygXAZ16NLQ", // prefix に `:`
      "sess-x:apr-F9aSKs-LnHcbygXAZ16NL", // base64url 21
      "sess-x:apr-175445000000-3", // 12 桁 (Date.now は 13 桁)
      "sess-x:apr-1234567890", // 連番 10 桁 (demo 形は 9 桁まで)
      "[REDACTED:high-entropy]:apr-1", // demo 形でも mangled prefix は排除
    ]) {
      expect(isRetirableApprovalRequestId(id), `${JSON.stringify(id)} must NOT be retirable`).toBe(
        false,
      );
    }
  });
});
