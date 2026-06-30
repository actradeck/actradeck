/**
 * QA-1 (decision 019f1859): daemon-class → hello `policy_capable` advertising の binding を実 ws で固定する。
 *
 * backend の connectedDaemons capability gating (ADR 019f1582 follow-up) は **daemon が hello で広告する
 * policy_capable** に依存する。広告の真偽は daemon 種別に固有:
 *  - AttachDaemon / managed Sidecar: policyRequest を処理する → `policy_capable: true` を広告。
 *  - CodexRolloutDaemon: observe-only (interrupt のみ wire・policy enforce 不能) → 広告しない (既定 false)。
 *
 * この binding を誤ると daemon-addressed policy が壊れる: codex に true を付けると UI が選んで timeout 再発、
 * attach から false を落とすと agent-less 状態で policy 設定不能。実 ws server で hello を capture し固定する
 * (egress-handshake は WsClient option 単体を見るが、本テストは **daemon-class→option の配線**を覆う)。
 *
 * scope: capability gating が実際に区別する attach (要広告) と codex (非広告) を覆う。managed Sidecar の
 * 広告は attach と同一の policyCapable:true 経路 + egress-handshake (2b) で覆い、構築重量を避ける。
 */
import { afterEach, describe, expect, it } from "vitest";

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { WebSocketServer, type WebSocket as WsServerSocket } from "ws";

import { AttachDaemon } from "../src/attach-daemon.js";
import { CodexRolloutDaemon } from "../src/codex-rollout-daemon.js";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

let server: WebSocketServer | undefined;
const cleanup: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const fn of cleanup.splice(0)) await fn();
  if (server) {
    await new Promise<void>((r) => server!.close(() => r()));
    server = undefined;
  }
});

/** 接続を受けて hello を含む受信フレームを frames へ push する capture ws server。 */
function startCaptureServer(frames: unknown[]): Promise<number> {
  return new Promise((resolve) => {
    const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    wss.on("connection", (ws: WsServerSocket) => {
      ws.on("message", (data) => {
        try {
          frames.push(JSON.parse(data.toString()));
        } catch {
          /* 非 JSON は無視 (hello は JSON)。 */
        }
      });
    });
    wss.on("listening", () => {
      server = wss;
      const addr = wss.address();
      resolve(typeof addr === "object" && addr ? addr.port : 0);
    });
  });
}

/** 最初の hello フレームを (最大 ~2s) 待って返す。 */
async function firstHello(frames: unknown[]): Promise<Record<string, unknown> | undefined> {
  for (let i = 0; i < 200; i++) {
    const h = frames.find((f) => (f as { type?: string })?.type === "hello");
    if (h) return h as Record<string, unknown>;
    await sleep(10);
  }
  return undefined;
}

describe("INV daemon-class policy_capable advertising (real ws)", () => {
  it("AttachDaemon は hello に policy_capable:true を載せる (policyRequest を処理する)", async () => {
    const frames: unknown[] = [];
    const port = await startCaptureServer(frames);
    const dir = mkdtempSync(join(tmpdir(), "ad-cap-attach-"));
    const daemon = new AttachDaemon({
      wsUrl: `ws://127.0.0.1:${port}/ingest/ws`,
      dbPath: join(dir, "s.db"),
      hookToken: "tok",
      host: "127.0.0.1",
      approvalTimeoutMs: 30,
    });
    cleanup.push(async () => {
      await daemon.shutdown();
      rmSync(dir, { recursive: true, force: true });
    });
    await daemon.start();

    const hello = await firstHello(frames);
    expect(hello?.type).toBe("hello");
    expect(hello?.policy_capable).toBe(true);
  });

  it("CodexRolloutDaemon は hello に policy_capable を載せない (observe-only・既定 false で除外)", async () => {
    const frames: unknown[] = [];
    const port = await startCaptureServer(frames);
    const dir = mkdtempSync(join(tmpdir(), "ad-cap-codex-"));
    const codexHome = join(dir, "codex-home");
    mkdirSync(codexHome, { recursive: true }); // tailer が走査する空の codexHome。
    const daemon = new CodexRolloutDaemon({
      wsUrl: `ws://127.0.0.1:${port}/ingest/ws`,
      dbPath: join(dir, "s.db"),
      codexHome,
      pollIntervalMs: 60_000, // hello だけ要るので tailer poll は最小化。
      onWarning: () => {},
    });
    cleanup.push(async () => {
      await daemon.shutdown();
      rmSync(dir, { recursive: true, force: true });
    });
    await daemon.start();

    const hello = await firstHello(frames);
    expect(hello?.type).toBe("hello");
    expect("policy_capable" in (hello ?? {})).toBe(false); // 広告せず → connectedDaemons から除外。
  });
});
