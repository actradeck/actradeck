/**
 * QA-R4-1 (Phase 4 R4 監査): daemon-class → hello `active_pending_request_ids` 宣言の配線を実 ws で固定する。
 *
 * egress-handshake (P4-*) は WsClient option 単体を、backend inv-approval-reconcile は手組み hello を
 * 見るが、**daemon class が provider を実際に配線しているか**は両者の間に落ちる: 呼び出し側の
 * `pendingApprovalIdsProvider: pendingIdsFromBridge(...)` を削除しても全 suite が緑のままだった
 * (QA-R4-1 probe・sidecar 92 files で SURVIVED)。落ちると hello から宣言が消え、backend は fail-safe で
 * reconcile せず、再起動後の stale approval card が永久に actionable のまま残る (silent-off)。
 * 同 hello frame は過去に reannounce が policy_capable を落とす H 回帰を起こした実績がある
 * (decision 019f1859) — daemon-class→option 配線の pin は inv-daemon-policy-capability と同型。
 *
 * scope: AttachDaemon (既定モード・実 ws で hello capture) + CodexRolloutDaemon (observe-only は
 * 宣言を**載せない** = reconcile 対象外の安全側)。managed Sidecar (sidecar.ts) は構築重量を避け、
 * 同一 helper への配線をソース結合 pin で覆う (precedent: inv-tripwire-coverage の config 読取)。
 */
import { afterEach, describe, expect, it } from "vitest";

import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { WebSocketServer, type WebSocket as WsServerSocket } from "ws";

import { AttachDaemon } from "../src/attach-daemon.js";
import { CodexRolloutDaemon } from "../src/codex-rollout-daemon.js";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const SRC_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "src");

let server: WebSocketServer | undefined;
const cleanup: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const fn of cleanup.splice(0)) await fn();
  if (server) {
    await new Promise<void>((r) => server!.close(() => r()));
    server = undefined;
  }
});

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

async function firstHello(frames: unknown[]): Promise<Record<string, unknown> | undefined> {
  for (let i = 0; i < 200; i++) {
    const h = frames.find((f) => (f as { type?: string })?.type === "hello");
    if (h) return h as Record<string, unknown>;
    await sleep(10);
  }
  return undefined;
}

describe("INV daemon-class active_pending_request_ids 配線 (real ws)", () => {
  it("AttachDaemon の hello は宣言を載せる (pending ゼロでも空配列 = 正当な宣言・provider 削除で RED)", async () => {
    const frames: unknown[] = [];
    const port = await startCaptureServer(frames);
    const dir = mkdtempSync(join(tmpdir(), "ad-recon-attach-"));
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
    // provider 配線が生きていれば「pending ゼロ」の空配列宣言 (欠落は provider 未配線 = RED)。
    expect(hello?.active_pending_request_ids).toEqual([]);
    // runtime_epoch も同じ hello 経路で運ばれる (uuid shape)。
    expect(String(hello?.runtime_epoch)).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    // TDA-V9-7: 縮退カウンタも同じ hello 経路で運ばれる (daemonCountersProvider 未配線なら field 欠落 = RED)。
    // 正常時は 0 報告 (「縮退なし」の宣言)。NO-RAW: 非負整数のみで request_id 原文を含まない。
    expect(hello?.daemon_counters).toEqual({ unstableRequestIdCount: 0 });
  });

  it("CodexRolloutDaemon の hello は宣言を載せない (observe-only → reconcile 対象外の安全側)", async () => {
    const frames: unknown[] = [];
    const port = await startCaptureServer(frames);
    const dir = mkdtempSync(join(tmpdir(), "ad-recon-codex-"));
    const codexHome = join(dir, "codex-home");
    mkdirSync(codexHome, { recursive: true });
    const daemon = new CodexRolloutDaemon({
      wsUrl: `ws://127.0.0.1:${port}/ingest/ws`,
      dbPath: join(dir, "s.db"),
      codexHome,
      pollIntervalMs: 60_000,
      onWarning: () => {},
    });
    cleanup.push(async () => {
      await daemon.shutdown();
      rmSync(dir, { recursive: true, force: true });
    });
    await daemon.start();

    const hello = await firstHello(frames);
    expect(hello?.type).toBe("hello");
    expect("active_pending_request_ids" in (hello ?? {})).toBe(false);
    // TDA-V9-7: observe-only は ApprovalBridge を持たないため counters も載せない (未報告扱い)。
    expect("daemon_counters" in (hello ?? {})).toBe(false);
  });

  it("managed Sidecar / AttachDaemon とも provider は共有 helper 経由 (ソース結合 pin)", () => {
    // Sidecar class の実構築は重い (hook receiver 等) ため、配線行の存在をソースで pin する。
    // 手書き `?? []` 等へ置換されると pendingIdsFromBridge の undefined 透過 (TDA-8) が壊れる。
    for (const file of ["sidecar.ts", "attach-daemon.ts"]) {
      const src = readFileSync(join(SRC_DIR, file), "utf8");
      expect(
        /pendingApprovalIdsProvider:\s*pendingIdsFromBridge\(/.test(src),
        `${file} が pendingIdsFromBridge を配線していない`,
      ).toBe(true);
      // TDA-V9-7: 縮退カウンタも同じ正準 helper 経由で配線する (手書き `?? 0` / 直読みへ置換されると
      // bridge 未生成窓で 0 を「報告された 0」として送ってしまい未報告と区別できなくなる)。
      expect(
        /daemonCountersProvider:\s*daemonCountersFromBridge\(/.test(src),
        `${file} が daemonCountersFromBridge を配線していない`,
      ).toBe(true);
    }
  });
});
