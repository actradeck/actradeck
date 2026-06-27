/**
 * INV-GIT-WATCHER-LIFECYCLE — no emit after stop() (shutdown race).
 *
 * GitWatcher の debounce が撃った in-flight `captureAndEmit` は `await snapshotDiff()` (git 子
 * プロセス) を跨いで `onEvent`→`sink.emit`→`store.append` する。`stop()` がこの in-flight capture を
 * 待たずに返ると、attach-daemon が続けて呼ぶ `store.close()` の後に capture が emit し、閉じた
 * SQLite へ append→attach daemon は unhandledRejection handler を持たない (cli.ts mainDaemon) ため
 * **プロセスクラッシュ**になる (TDA-4 H・process-monitor / codex-rollout-tailer と同型の pattern class)。
 *
 * falsifiable: git-watcher.ts の stop() から `if (this.currentCapture) await this.currentCapture;`
 * を外すと、stop() が in-flight capture を待たず即 resolve し `expect(stopResolved).toBe(false)` が
 * 赤になる。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { GitWatcher } from "../src/git-watcher.js";
import { SessionIdentity } from "../src/session-identity.js";

describe("INV-GIT-WATCHER-LIFECYCLE: no emit after stop()", () => {
  let tmp: string | undefined;

  afterEach(() => {
    if (tmp !== undefined) rmSync(tmp, { recursive: true, force: true });
    tmp = undefined;
  });

  function makeWatcher(): { gw: GitWatcher; events: unknown[] } {
    tmp = mkdtempSync(join(tmpdir(), "actradeck-gw-life-"));
    const events: unknown[] = [];
    const identity = new SessionIdentity({
      fallbackSessionId: "sess_gw",
      explicitSessionId: "sess_gw",
    });
    const gw = new GitWatcher({ identity, repoRoot: tmp, onEvent: (e) => events.push(e) });
    return { gw, events };
  }

  it("stop() drains an in-flight capture before returning [TDA-4]", async () => {
    const { gw } = makeWatcher();
    // debounce が撃った in-flight captureAndEmit 相当を注入する (await 境界で停めた状態)。
    type W = { running: boolean; currentCapture: Promise<unknown> | undefined };
    let release!: () => void;
    const inflight = new Promise<void>((r) => (release = r));
    (gw as unknown as W).running = true;
    (gw as unknown as W).currentCapture = inflight;

    let stopResolved = false;
    const stopP = gw.stop().then(() => {
      stopResolved = true;
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(stopResolved).toBe(false); // stop は in-flight capture を drain するまで返らない。

    release();
    await stopP;
    expect(stopResolved).toBe(true);
  });

  it("captureAndEmit tracks the in-flight promise then clears it", async () => {
    const { gw } = makeWatcher();
    type W = { currentCapture: Promise<unknown> | undefined };
    // repoRoot は非 git の temp dir。snapshotDiff は git() が空を返すため容認される。
    const p = gw.captureAndEmit();
    expect((gw as unknown as W).currentCapture).toBeDefined(); // 同期で in-flight を握る。
    await p;
    expect((gw as unknown as W).currentCapture).toBeUndefined(); // finally で clear。
  });
});
