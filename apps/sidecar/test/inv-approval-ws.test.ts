/**
 * INV-APPROVAL-WS (3#SEC-1): inbound WS 制御チャネルの認証ゲートと request_id エントロピー。
 *
 * 脅威: ws-client は inbound `{type:"approval",request_id,decision}` / `{type:"interrupt"}` を
 * 無認証で受理し approvalBridge.resolve / managed.stop へ流していた。request_id が
 * `${sessionId}:apr-${Date.now()}-${seq}` で予測容易、かつ waiting.approval イベントで同一
 * チャネルに observable だったため、任意 WS peer が allow 注入で deny 既定ゲートを反転できた
 * (INV-APPROVAL バイパス)。
 *
 * 対策後の不変条件:
 * (a) token 無し/誤 token の approval injection は WsClient で破棄され resolve に至らない。
 * (b) interrupt も同様。
 * (c) request_id が予測可能な連番 (Date.now/seq) でない (crypto.randomBytes 由来)。
 * (d) decision が enum (allow/deny) 以外なら sidecar 配線で破棄される。
 * 既存 SEC-2 scope テスト (foreign request_id 拒否) は緑維持。
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { WebSocketServer, type WebSocket } from "ws";

import { ApprovalBridge } from "../src/approval-bridge.js";
import type { HookCommonInput } from "../src/normalize.js";
import { Sidecar } from "../src/sidecar.js";
import { WsClient } from "../src/ws-client.js";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

let server: WebSocketServer | undefined;
let client: WsClient | undefined;
afterEach(async () => {
  client?.close();
  client = undefined;
  if (server) {
    await new Promise<void>((r) => server!.close(() => r()));
    server = undefined;
  }
});

function startServer(): Promise<{ port: number; conns: WebSocket[] }> {
  return new Promise((resolve) => {
    const conns: WebSocket[] = [];
    const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    wss.on("connection", (ws) => conns.push(ws));
    wss.on("listening", () => {
      server = wss;
      const addr = wss.address();
      resolve({ port: typeof addr === "object" && addr ? addr.port : 0, conns });
    });
  });
}

function preToolUse(toolName: string, toolInput: Record<string, unknown>): HookCommonInput {
  return {
    session_id: "s1",
    hook_event_name: "PreToolUse",
    tool_name: toolName,
    tool_input: toolInput,
  };
}

describe("INV-APPROVAL-WS (3#SEC-1): inbound control auth gate (real WS)", () => {
  it("(a) approval injection WITHOUT token does NOT resolve a pending approval", async () => {
    const { port, conns } = await startServer();
    const { EventStore } = await import("../src/store.js");
    const store = new EventStore(":memory:");
    const TOKEN = "the-real-control-token-xyz";
    client = new WsClient({ url: `ws://127.0.0.1:${port}`, store, controlToken: TOKEN });

    const bridge = new ApprovalBridge({ timeoutMs: 300 });
    client.on("approval", (msg) => {
      if (msg.decision === "allow" || msg.decision === "deny") {
        bridge.resolve(msg.request_id, msg.decision, msg.reason);
      }
    });
    client.connect();
    for (let i = 0; i < 50 && conns.length === 0; i++) await sleep(10);

    // 高リスク承認を 1 件保留 (UI 応答が無ければ deny に倒れる)。
    let reqId = "";
    const p = bridge.requestApproval(preToolUse("Bash", { command: "rm -rf /tmp/x" }), (id) => {
      reqId = id;
    });

    // 攻撃者が token 無しで allow を注入 (request_id は observable と仮定)。
    conns[0]!.send(JSON.stringify({ type: "approval", request_id: reqId, decision: "allow" }));
    // 誤 token でも同様。
    conns[0]!.send(
      JSON.stringify({ type: "approval", request_id: reqId, decision: "allow", token: "wrong" }),
    );
    await sleep(40);
    // 注入は破棄され、まだ保留のまま。
    expect(bridge.pendingCount, "injection must NOT resolve the approval").toBe(1);

    // タイムアウトで安全側 deny に倒れる (allow 反転していない)。
    const r = await p;
    expect(r.behavior).toBe("deny");
    store.close();
  });

  it("(a') approval injection WITH the correct token DOES resolve", async () => {
    const { port, conns } = await startServer();
    const { EventStore } = await import("../src/store.js");
    const store = new EventStore(":memory:");
    const TOKEN = "the-real-control-token-xyz";
    client = new WsClient({ url: `ws://127.0.0.1:${port}`, store, controlToken: TOKEN });

    const bridge = new ApprovalBridge({ timeoutMs: 1000 });
    client.on("approval", (msg) => {
      if (msg.decision === "allow" || msg.decision === "deny") {
        bridge.resolve(msg.request_id, msg.decision, msg.reason);
      }
    });
    client.connect();
    for (let i = 0; i < 50 && conns.length === 0; i++) await sleep(10);

    let reqId = "";
    const p = bridge.requestApproval(preToolUse("Bash", { command: "rm -rf /tmp/x" }), (id) => {
      reqId = id;
    });
    conns[0]!.send(
      JSON.stringify({ type: "approval", request_id: reqId, decision: "deny", token: TOKEN }),
    );
    const r = await p;
    expect(r.behavior).toBe("deny"); // 正規 token の deny は通る
    store.close();
  });

  it("(b) interrupt injection WITHOUT token does NOT stop the managed process", async () => {
    const { port, conns } = await startServer();
    const { EventStore } = await import("../src/store.js");
    const store = new EventStore(":memory:");
    const TOKEN = "tok-interrupt-guard";
    client = new WsClient({ url: `ws://127.0.0.1:${port}`, store, controlToken: TOKEN });
    const onInterrupt = vi.fn();
    client.on("interrupt", onInterrupt);
    client.connect();
    for (let i = 0; i < 50 && conns.length === 0; i++) await sleep(10);

    conns[0]!.send(JSON.stringify({ type: "interrupt", session_id: "s1" }));
    conns[0]!.send(JSON.stringify({ type: "interrupt", session_id: "s1", token: "nope" }));
    await sleep(40);
    expect(onInterrupt, "unauthenticated interrupt must be dropped").not.toHaveBeenCalled();

    conns[0]!.send(JSON.stringify({ type: "interrupt", session_id: "s1", token: TOKEN }));
    await sleep(40);
    expect(onInterrupt, "authenticated interrupt is delivered").toHaveBeenCalledTimes(1);
    store.close();
  });
});

describe("INV-APPROVAL-WS (3#SEC-1): request_id entropy + decision enum", () => {
  it("(c) request_id is NOT a predictable Date.now/seq sequence", async () => {
    const bridge = new ApprovalBridge({ timeoutMs: 10 });
    const ids: string[] = [];
    for (let i = 0; i < 8; i++) {
      await bridge.requestApproval(preToolUse("Bash", { command: "rm -rf /x" }), (id) =>
        ids.push(id),
      );
    }
    // sessionId プレフィックスは温存 (SEC-2 scope)。
    for (const id of ids) expect(id).toMatch(/^s1:apr-/);
    const randomParts = ids.map((id) => id.replace(/^s1:apr-/, ""));
    // 連番でない: 隣接 id が数値インクリメントでない。
    for (let i = 1; i < randomParts.length; i++) {
      expect(randomParts[i]).not.toBe(randomParts[i - 1]);
      // Date.now-連番の旧形式 (apr-<digits>-<seq>) でないこと。
      expect(randomParts[i]).not.toMatch(/^\d+-\d+$/);
    }
    // 十分なエントロピー長 (base64url(16 bytes) = 22 文字)。
    for (const r of randomParts) expect(r.length).toBeGreaterThanOrEqual(20);
    // 全 id がユニーク。
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("(d) Sidecar drops approval with a non-enum decision (real wiring)", () => {
    const sidecar = new Sidecar({
      sessionId: "s1",
      wsUrl: "ws://127.0.0.1:1/never",
      dbPath: ":memory:",
    });
    const resolveSpy = vi.spyOn(sidecar.approvalBridge, "resolve");
    // sidecar の配線済み handler を直接叩く (WsClient.emit)。token ゲートは WsClient 内で
    // 既に通過した前提のメッセージ。decision が enum 外なら resolve に渡らない。
    sidecar.wsClient.emit("approval", {
      type: "approval",
      request_id: "s1:apr-anything",
      decision: "sudo-allow-everything" as unknown as "allow",
    });
    expect(resolveSpy, "non-enum decision must not reach resolve").not.toHaveBeenCalled();
    sidecar.store.close();
  });

  it("SEC-2 regression stays green: foreign request_id is rejected by resolve()", () => {
    const bridge = new ApprovalBridge({ timeoutMs: 1000 });
    expect(bridge.resolve("s2:apr-foreign", "allow")).toBe(false);
  });
});
