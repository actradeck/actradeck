/**
 * ProcessMonitor lifecycle regression — no emit after stop() (shutdown race).
 *
 * 再現していた flake (inv-codex-e2e 周辺): managed session の shutdown
 * (dispose→monitor.stop→store.close) が ProcessMonitor の tick の `await sampleOnce()` 境界で
 * 割り込むと、in-flight tick が停止後に onSample(→sink.emit→**閉じた SQLite**)を呼び、
 * tick が fire-and-forget (void) のため unhandled rejection になっていた。
 *
 * ここでは sampleOnce を手動制御の deferred に差し替えて await 境界を**決定的に**再現し
 * (実 pidusage の timing には依存しない)、stop() 後に onSample が呼ばれないことを固定する。
 * falsifiability: process-monitor.ts の「await 後の stopped 再チェック」guard を外すと、
 * release() 後に onSample が呼ばれ onSampleCalls=1 となり、この test は赤になる。
 */
import { describe, expect, it } from "vitest";

import { ProcessMonitor } from "../src/process-monitor.js";

function waitUntil(pred: () => boolean, ms = 5000): Promise<boolean> {
  return new Promise((resolve) => {
    const start = Date.now();
    const poll = (): void => {
      if (pred()) return resolve(true);
      if (Date.now() - start >= ms) return resolve(false);
      setTimeout(poll, 1);
    };
    poll();
  });
}

describe("ProcessMonitor lifecycle: no emit after stop()", () => {
  it("does not call onSample when stop() races an in-flight sampleOnce()", async () => {
    let onSampleCalls = 0;
    const monitor = new ProcessMonitor({
      pid: process.pid,
      intervalMs: 1, // 最初の tick をすぐ撃つ
      onSample: () => {
        onSampleCalls += 1;
      },
    });

    // sampleOnce を deferred に差し替え、await 境界 (shutdown が割り込む箇所) を決定的に制御する。
    let entered = false;
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    (monitor as unknown as { sampleOnce: () => Promise<unknown> }).sampleOnce = async () => {
      entered = true;
      await gate;
      return { pid: process.pid, alive: true, cpu: 0, memory: 0, elapsed_ms: 0 };
    };

    monitor.start();
    // 最初の tick が sampleOnce の await に入るまで待つ。
    expect(await waitUntil(() => entered)).toBe(true);

    // shutdown 相当: await 中に stop() を呼ぶ (この直後に store.close 相当が走る想定)。
    monitor.stop();
    // in-flight tick を resume させる。guard が無ければここで onSample→emit が走ってしまう。
    release();
    // tick の continuation (post-await guard → return) が回り切るのを待つ。
    await new Promise((r) => setTimeout(r, 20));

    expect(onSampleCalls).toBe(0);
  });

  it("calls onSample on a normal tick (guard does not break the happy path)", async () => {
    let calls = 0;
    const monitor = new ProcessMonitor({
      pid: process.pid,
      intervalMs: 1,
      onSample: () => {
        calls += 1;
      },
    });
    monitor.start();
    const got = await waitUntil(() => calls >= 1);
    monitor.stop();
    expect(got).toBe(true);
    expect(calls).toBeGreaterThanOrEqual(1);
  });
});
