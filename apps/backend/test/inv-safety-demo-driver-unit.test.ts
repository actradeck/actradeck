/**
 * INV-SAFETY-DEMO-DRIVER-UNIT — native-free driver の純ヘルパの決定論的契約 (PG 不要・unit project)。
 *
 * driver 本体の block/redact 貫通は inv-safety-demo-backend-e2e (実 PG) が担う。ここは URL 補完 /
 * env パース / decision 正規化 / control-token 定数時間比較の **分岐**を falsifiable に固定する
 * (特に token 不一致 fail-safe = SEC 面の回帰ゲート)。
 */
import { describe, expect, it } from "vitest";

import {
  denySafeResolveHold,
  normalizeDecision,
  parseDriverEnv,
  resolveDriverWsUrl,
  resolvePort,
  tokenMatches,
} from "../src/safety-demo-driver.js";

describe("resolveDriverWsUrl: base に /ingest/ws を補完する", () => {
  const emptyEnv: NodeJS.ProcessEnv = {};
  it("フル URL (/ingest/ws 済) はそのまま", () => {
    expect(resolveDriverWsUrl("ws://127.0.0.1:55410/ingest/ws", emptyEnv)).toBe(
      "ws://127.0.0.1:55410/ingest/ws",
    );
  });
  it("base のみは /ingest/ws を補完 (末尾スラッシュも吸収)", () => {
    expect(resolveDriverWsUrl("ws://127.0.0.1:55410", emptyEnv)).toBe(
      "ws://127.0.0.1:55410/ingest/ws",
    );
    expect(resolveDriverWsUrl("ws://127.0.0.1:55410/", emptyEnv)).toBe(
      "ws://127.0.0.1:55410/ingest/ws",
    );
  });
  it("explicit 未指定なら ACTRADECK_WS_URL を使う", () => {
    expect(resolveDriverWsUrl(undefined, { ACTRADECK_WS_URL: "ws://host:1/ingest/ws" })).toBe(
      "ws://host:1/ingest/ws",
    );
  });
  it("explicit も ACTRADECK_WS_URL も無ければ 127.0.0.1:<port> 既定", () => {
    expect(resolveDriverWsUrl(undefined, {})).toBe("ws://127.0.0.1:55410/ingest/ws");
    expect(resolveDriverWsUrl(undefined, { ACTRADECK_BACKEND_PORT: "6000" })).toBe(
      "ws://127.0.0.1:6000/ingest/ws",
    );
  });
});

describe("resolvePort: ACTRADECK_BACKEND_PORT の安全解決", () => {
  it("正の整数はその値", () => {
    expect(resolvePort({ ACTRADECK_BACKEND_PORT: "7000" })).toBe(7000);
  });
  it("不正 (非数値/0/負) は既定 55410", () => {
    expect(resolvePort({ ACTRADECK_BACKEND_PORT: "abc" })).toBe(55410);
    expect(resolvePort({ ACTRADECK_BACKEND_PORT: "0" })).toBe(55410);
    expect(resolvePort({})).toBe(55410);
  });
});

describe("normalizeDecision: T1 ApprovalDecision の 4 値のみ受理", () => {
  it("有効値はそのまま", () => {
    for (const d of ["allow", "allow_for_session", "deny", "cancel"] as const) {
      expect(normalizeDecision(d)).toBe(d);
    }
  });
  it("未知値 / 非文字列は undefined (無視)", () => {
    expect(normalizeDecision("approve")).toBeUndefined();
    expect(normalizeDecision(42)).toBeUndefined();
    expect(normalizeDecision(null)).toBeUndefined();
    expect(normalizeDecision(undefined)).toBeUndefined();
  });
});

describe("tokenMatches: control-token 定数時間比較 (fail-safe deny)", () => {
  const tok = "a".repeat(64);
  it("一致は true", () => {
    expect(tokenMatches(tok, tok)).toBe(true);
  });
  it("不一致 / 長さ違い / 非文字列 / 空は false (無認証 peer の注入を遮断)", () => {
    expect(tokenMatches(tok, "b".repeat(64))).toBe(false);
    expect(tokenMatches(tok, "a".repeat(63))).toBe(false); // 長さ違いは timingSafeEqual 前に false。
    expect(tokenMatches(tok, 123)).toBe(false);
    expect(tokenMatches(tok, "")).toBe(false);
    expect(tokenMatches(tok, undefined)).toBe(false);
  });
});

describe("denySafeResolveHold: SIGTERM/backstop の deny-safe 解決 (QA-3)", () => {
  it("hold 中 (resolveHold 定義済) は deny で解決し true を返す (INV-APPROVAL 安全側)", () => {
    const calls: string[] = [];
    const resolved = denySafeResolveHold((d) => calls.push(d));
    expect(resolved).toBe(true);
    expect(calls).toEqual(["deny"]); // 自動 allow せず必ず deny。
  });
  it("resolveHold 未設定 (未 hold / 解決済) は no-op で false", () => {
    expect(denySafeResolveHold(undefined)).toBe(false);
  });
});

describe("parseDriverEnv: CLI env → driver options", () => {
  it("既定は hold・timeout/sessionId は省略", () => {
    expect(parseDriverEnv({})).toEqual({ approvalMode: "hold" });
  });
  it("ACTRADECK_DEMO_APPROVAL=auto-deny を反映", () => {
    expect(parseDriverEnv({ ACTRADECK_DEMO_APPROVAL: "auto-deny" }).approvalMode).toBe("auto-deny");
  });
  it("正の timeout と非空 sessionId を反映・不正 timeout は省略", () => {
    expect(
      parseDriverEnv({
        ACTRADECK_DEMO_APPROVAL_TIMEOUT_MS: "1200",
        ACTRADECK_DEMO_SESSION_ID: "demo-safety-xyz",
      }),
    ).toEqual({ approvalMode: "hold", approvalTimeoutMs: 1200, sessionId: "demo-safety-xyz" });
    expect(
      parseDriverEnv({ ACTRADECK_DEMO_APPROVAL_TIMEOUT_MS: "-1" }).approvalTimeoutMs,
    ).toBeUndefined();
    expect(parseDriverEnv({ ACTRADECK_DEMO_SESSION_ID: "" }).sessionId).toBeUndefined();
  });
});
