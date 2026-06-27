/**
 * INV-STALLED (P0 必須リグレッション, testing.md) — sidecar の責務分。
 *
 * 不変条件 (sidecar が担保する範囲):
 *  (1) process heartbeat は **REAL** プロセスの生死を観測する
 *      (sampleOnce: alive=true は実在 PID、alive=false は消滅 PID)。モック禁止。
 *  (2) managed-runner が出す process_alive heartbeat が実プロセスの生死を反映する。
 *
 * 注: liveness 合成 (4 heartbeat を分解して停止を断定しない) は **backend が正典**
 *    (apps/backend/src/liveness.ts、INV-STALLED + INV-LIVENESS-PARITY ガード付き)。
 *    sidecar は「process heartbeat」という 1 シグナルを供給するのみで、合成判定は持たない
 *    (再#3 TDA-1: sidecar 側の synthesizeLiveness はデッド重複だったため撤去し正典を一本化)。
 *    よって本ファイルは process heartbeat 供給の REAL 検証に限定する。
 */
import { type ChildProcess, spawn } from "node:child_process";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { NormalizedEvent } from "@actradeck/event-model";

import { ProcessMonitor } from "../src/process-monitor.js";
import { startManagedClaude } from "../src/managed-runner.js";
import { SessionIdentity } from "../src/session-identity.js";
import { EventSink } from "../src/sink.js";
import { EventStore } from "../src/store.js";
import type { WsClient } from "../src/ws-client.js";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** REAL: 実子プロセスを spawn し、生死を観測できる状態にする。 */
function spawnSleeper(seconds: number): ChildProcess {
  // 純粋な sleep。stdout を握らず PID だけ観測対象にする。
  return spawn(process.execPath, ["-e", `setTimeout(() => {}, ${seconds * 1000})`], {
    stdio: "ignore",
  });
}

const children: ChildProcess[] = [];
afterEach(() => {
  for (const c of children) {
    try {
      c.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  }
  children.length = 0;
});

describe("INV-STALLED: process heartbeat observes REAL process liveness", () => {
  it("sampleOnce reports alive=true for a live child process (REAL spawn)", async () => {
    const child = spawnSleeper(5);
    children.push(child);
    expect(child.pid).toBeGreaterThan(0);

    const monitor = new ProcessMonitor({ pid: child.pid!, onSample: () => {} });
    const sample = await monitor.sampleOnce();
    monitor.stop();

    expect(sample.pid).toBe(child.pid);
    expect(sample.alive).toBe(true);
    expect(sample.elapsed_ms).toBeGreaterThanOrEqual(0);
    expect(sample.memory).toBeGreaterThan(0);
  });

  it("sampleOnce reports alive=false after the child process is killed (REAL exit)", async () => {
    const child = spawnSleeper(30);
    children.push(child);
    const pid = child.pid!;
    expect(pid).toBeGreaterThan(0);

    // 実際に kill して消滅を待つ。
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    child.kill("SIGKILL");
    await exited;
    // OS が PID を回収するまで僅かに待つ (pidusage が ESRCH を返すまで)。
    await sleep(50);

    const monitor = new ProcessMonitor({ pid, onSample: () => {} });
    const sample = await monitor.sampleOnce();
    monitor.stop();

    expect(sample.pid).toBe(pid);
    expect(sample.alive).toBe(false); // 消滅 → 「生存していない」と観測
    expect(sample.cpu).toBe(0);
    expect(sample.memory).toBe(0);
  });

  it("ProcessMonitor.start() emits periodic samples for a live process (REAL)", async () => {
    const child = spawnSleeper(5);
    children.push(child);
    const samples: boolean[] = [];
    const monitor = new ProcessMonitor({
      pid: child.pid!,
      intervalMs: 20,
      onSample: (s) => samples.push(s.alive),
    });
    monitor.start();
    await sleep(80);
    monitor.stop();
    expect(samples.length).toBeGreaterThanOrEqual(2); // heartbeat が複数出る
    expect(samples.every((a) => a === true)).toBe(true);
  });
});

describe("INV-STALLED: managed-runner emits process_alive heartbeat from a REAL child", () => {
  it("startManagedClaude emits heartbeat{process_alive:true} for a live process (REAL pty spawn)", async () => {
    // 実プロセス (短命でない node) を claude の代わりに起動し、heartbeat を観測する。
    const store = new EventStore(":memory:");
    const wsClient = { notifyAppended: () => {} } as unknown as WsClient;
    const sink = new EventSink({ store, wsClient });
    const heartbeats: NormalizedEvent[] = [];
    const realEmit = sink.emit.bind(sink);
    // emit を観測 (redaction 経路はそのまま通す)。
    sink.emit = ((ev: NormalizedEvent | Record<string, unknown>) => {
      const out = realEmit(ev);
      if (out?.event_type === "heartbeat") heartbeats.push(out);
      return out;
    }) as typeof sink.emit;

    // managed-runner は `--settings <path> ...claudeArgs` を先頭に付けて起動する。
    // node はその flag を解さないため、引数を無視して生き続ける小さな実行可能スクリプトを
    // claude の代役にする (REAL プロセスでの process_alive 観測)。
    const binDir = mkdtempSync(join(tmpdir(), "actradeck-stalled-bin-"));
    const fakeClaude = join(binDir, "fake-claude");
    writeFileSync(fakeClaude, `#!${process.execPath}\nsetInterval(() => {}, 1000);\n`, "utf8");
    chmodSync(fakeClaude, 0o755);

    const session = startManagedClaude({
      sink,
      hookEndpoint: "http://127.0.0.1:0/hook",
      // ADR 019e9462: 即確定 identity (explicit) で従来挙動 (canonical=s-stalled) を温存。
      identity: new SessionIdentity({
        fallbackSessionId: "s-stalled",
        explicitSessionId: "s-stalled",
      }),
      claudeBin: fakeClaude,
      heartbeatMs: 30,
    });
    expect(session.pid).toBeGreaterThan(0);

    await sleep(120);
    session.dispose();
    session.stop("SIGKILL");
    store.close();

    expect(heartbeats.length).toBeGreaterThanOrEqual(1);
    const alive = heartbeats.find((h) => h.payload.process_alive === true);
    expect(alive, "process_alive:true heartbeat must be emitted for a live child").toBeDefined();
    expect(alive!.metrics).toHaveProperty("elapsed_ms");
  });
});
