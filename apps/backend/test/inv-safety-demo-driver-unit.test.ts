/**
 * INV-SAFETY-DEMO-DRIVER-UNIT — native-free driver の純ヘルパの決定論的契約 (PG 不要・unit project)。
 *
 * driver 本体の block/redact 貫通は inv-safety-demo-backend-e2e (実 PG) が担う。ここは URL 補完 /
 * env パース / decision 正規化 / control-token 定数時間比較の **分岐**を falsifiable に固定する
 * (特に token 不一致 fail-safe = SEC 面の回帰ゲート)。
 * 加えて QA-R2-1 (sweep task 019f38b9): finally backstop の **実 emit 分岐**
 * (requested 済 ∧ 未 resolved で異常 unwind → resolved(deny) を 1 件だけ emit) を
 * in-process WS server + onLog throw 注入で決定論的に被覆する。
 */
import { AddressInfo } from "node:net";

import { describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";

import {
  denySafeResolveHold,
  normalizeDecision,
  parseDriverEnv,
  resolveDriverWsUrl,
  resolvePort,
  runSafetyDemoDriver,
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

describe("QA-R2-1: finally backstop の実 emit 分岐 (requested 後の異常 unwind → resolved(deny) を 1 件)", () => {
  interface ReceivedEvent {
    readonly event_type?: string;
    readonly payload?: { readonly request_id?: string; readonly decision?: string };
  }

  it("requested 直後に throw しても ws 生存中なら resolved(deny) が丁度 1 件 emit される", async () => {
    // in-process WS server (`/ingest/ws`・ephemeral port)。受信 JSON を収集する。
    const received: ReceivedEvent[] = [];
    const wss = new WebSocketServer({ port: 0, path: "/ingest/ws" });
    wss.on("connection", (socket) => {
      socket.on("message", (data: Buffer) => {
        try {
          const msg = JSON.parse(data.toString("utf8")) as ReceivedEvent & { type?: string };
          if (msg.type === "hello") return; // handshake frame はイベントでない。
          received.push(msg);
        } catch {
          /* 非 JSON は無視 */
        }
      });
    });
    await new Promise<void>((resolve) => wss.once("listening", () => resolve()));
    const port = (wss.address() as AddressInfo).port;

    // 注入: requested emit 直後の "hold: …" 進捗ログで throw → 正常路の resolved 前に unwind。
    // ws は OPEN のままなので finally backstop の emitStep(resolved deny) は実送信に成功する。
    const sentinel = new Error("injected-after-requested (QA-R2-1)");
    const sessionId = "demo-safety-backstop-unit";
    await expect(
      runSafetyDemoDriver({
        wsUrl: `ws://127.0.0.1:${port}`,
        sessionId,
        pacingMs: 0,
        onLog: (msg) => {
          if (msg.startsWith("hold:")) throw sentinel;
        },
      }),
    ).rejects.toThrow("injected-after-requested");

    // backstop emit の到着を poll (send コールバックは flush 済みだが受信は非同期)。
    const deadline = Date.now() + 2_000;
    while (
      Date.now() < deadline &&
      !received.some((e) => e.event_type === "tool.permission.resolved")
    ) {
      await new Promise((r) => setTimeout(r, 20));
    }
    await new Promise<void>((resolve) => wss.close(() => resolve()));

    const types = received.map((e) => e.event_type);
    expect(types).toContain("session.started");
    expect(types).toContain("tool.permission.requested");
    // backstop の実 emit: resolved(deny) が **丁度 1 件** (0→1 の emit を pin)。
    // QA-3 訂正 + QA-3R 再訂正 (裁定 019f3ed6): この注入経路は正常路 resolved に未到達のため、
    // 二重 resolved 抑止ガード (!resolvedEmitted) 自体は発火せず本テストでは falsify されない
    // (ガード弱体 mutant でも緑。e2e の resolved assert も >=1 で同様に緑)。dedup の実質的担保は
    // driver でなく **projection 層の冪等性** (request_id ベースの pending 除去は二重 resolved に
    // 対し構造的 no-op) にある — inv-safety-demo-backend-e2e.test.ts:263-267 の帰属と同じ。
    const resolved = received.filter((e) => e.event_type === "tool.permission.resolved");
    expect(resolved.length).toBe(1);
    expect(resolved[0]?.payload?.decision).toBe("deny");
    expect(resolved[0]?.payload?.request_id).toBe(`${sessionId}:apr-1`);
    // 正常路はこの後の redact/end 脚に到達していない (異常 unwind の証跡)。
    expect(types).not.toContain("command.completed");
    expect(types).not.toContain("session.ended");
  }, 15_000);
});
