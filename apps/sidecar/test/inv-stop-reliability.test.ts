/**
 * INV-STOP-* — 強み(a)「停止の確実性」。
 *
 * 真因 / 背景 (decision 参照):
 *   managed-runner (claude) の stop は `child.kill(signal)` のみで、SIGINT を握り潰す子
 *   (claude が起動した TUI / 子シェル) を確実に停止できなかった。codex-runner は既に
 *   SIGTERM→killGraceMs→SIGKILL の escalation を持つため、対称な escalation を managed-runner へ
 *   移植し、両 runner の重複を共有 helper (escalateKill) に集約した。
 *
 * 本テストが固定する不変条件:
 *  - INV-STOP-INTERRUPT-E2E : UI interrupt 相当 (wsClient.emit("interrupt")) → 自セッションの
 *                             managed が SIGINT を受け、child exit で session が終端する。
 *  - INV-STOP-ESCALATION    : SIGINT を握り潰す子 → killGraceMs 後に SIGKILL で停止する。
 *                             managed (既定 SIGINT) / codex (既定 SIGTERM) の **両 runner** で固定する。
 *  - INV-STOP-PID-SCOPED    : kill 対象は所有 child オブジェクトのみ (負 PID / プロセスグループ /
 *                             foreign を撃たない)。escalateKill が child.kill 経由であることを pin。
 *  - INV-STOP-SESSION-SCOPED: foreign session_id の interrupt は managed.stop を呼ばない (SEC-2)。
 *  - INV-ATTACH-NO-KILL     : managed 不在 (interrupt) で no-op (非退行は inv-attach-daemon が担保。
 *                             本ファイルでは escalateKill が child を持たない経路を起こさないことを確認)。
 *
 * codex escalation の pin (裁定 019ecfbf / QA-1): codex stop は共有 helper (escalateKill) へ集約済
 * だが、codex 固有の配線 (既定 SIGTERM → SIGKILL escalation / 再stop clear) を pin する codex テストが
 * 無く、配線退行 (誤 signal / 誤 graceMs / 再武装前 clear 欠落) が managed/helper の緑のまま見逃される
 * 死角だった。process 終端は security-load-bearing のため、managed の INV-STOP-ESCALATION 群を
 * codex 既定 SIGTERM 向けに鏡写しで固定する。
 *
 * 決定論: 実 claude を起動しない (spawnPty を FakePty に差し替え)。escalation の timing は
 * vi.useFakeTimers で killGraceMs を厳密に進めて flaky を排除する。実 PID は一切操作しない。
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  startManagedClaude,
  type ManagedSession,
  type PtyLike,
  type TerminalLike,
} from "../src/managed-runner.js";
import { startManagedCodex, type ChildLike as CodexChildLike } from "../src/codex-runner.js";
import { ApprovalBridge } from "../src/approval-bridge.js";
import { escalateKill, type KillableChild } from "../src/kill-escalation.js";
import { SessionIdentity } from "../src/session-identity.js";
import { Sidecar } from "../src/sidecar.js";
import { EventSink } from "../src/sink.js";
import { EventStore } from "../src/store.js";
import type { WsClient } from "../src/ws-client.js";

/** kill / exit を観測できる最小フェイク PTY 子 (実 node-pty を起動しない)。 */
class FakePty implements PtyLike {
  readonly pid = 424242; // 実在しない PID (process-monitor は alive=false を観測するだけ)。
  readonly kills: Array<string | undefined> = [];
  private dataListeners: Array<(d: string) => void> = [];
  private exitListeners: Array<(e: { exitCode: number; signal?: number }) => void> = [];

  onData(listener: (d: string) => void): { dispose(): void } {
    this.dataListeners.push(listener);
    return {
      dispose: () => {
        this.dataListeners = this.dataListeners.filter((l) => l !== listener);
      },
    };
  }
  onExit(listener: (e: { exitCode: number; signal?: number }) => void): { dispose(): void } {
    this.exitListeners.push(listener);
    return { dispose: () => {} };
  }
  write(): void {
    /* noop */
  }
  resize(): void {
    /* noop */
  }
  kill(signal?: string): void {
    this.kills.push(signal);
  }
  /** 子の OS exit を発火 (claude プロセス終了相当)。 */
  emitExit(exitCode = 0): void {
    for (const l of [...this.exitListeners]) l({ exitCode });
  }
}

/** 非 TTY フェイク端末 (raw 化・stdin 転送・resize をスキップする安全ブランチ)。 */
function makeNonTtyTerminal(): TerminalLike {
  return {
    stdin: {
      isTTY: false,
      on: () => {},
      off: () => {},
    },
    stdout: {
      isTTY: false,
      write: () => true,
      on: () => {},
      off: () => {},
    },
  };
}

interface Rig {
  readonly child: FakePty;
  readonly session: ReturnType<typeof startManagedClaude>;
  readonly cleanup: () => void;
}

function makeManagedRig(opts?: { killGraceMs?: number }): Rig {
  const dir = mkdtempSync(join(tmpdir(), "stop-reliability-"));
  const store = new EventStore(join(dir, "sidecar.db"));
  const wsClient = { notifyAppended: () => {} } as unknown as WsClient;
  const sink = new EventSink({ store, wsClient });
  const identity = new SessionIdentity({ fallbackSessionId: "sess_stop", flushTimeoutMs: 0 });
  const child = new FakePty();
  const session = startManagedClaude({
    sink,
    hookEndpoint: "http://127.0.0.1:1/hook",
    identity,
    heartbeatMs: 999_999, // process monitor を実質止める (fake timer 干渉とノイズを避ける)。
    ...(opts?.killGraceMs !== undefined ? { killGraceMs: opts.killGraceMs } : {}),
    terminal: makeNonTtyTerminal(),
    spawnPty: () => child,
  });
  return {
    child,
    session,
    cleanup: () => {
      session.dispose();
      store.close();
    },
  };
}

describe("INV-STOP-* : 強み(a) 停止の確実性 (managed-runner escalation)", () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    vi.useRealTimers();
    for (const c of cleanups.splice(0)) c();
  });

  // --- INV-STOP-INTERRUPT-E2E ------------------------------------------------
  it("INV-STOP-INTERRUPT-E2E: stop('SIGINT') sends SIGINT and child exit resolves session.exited", async () => {
    const rig = makeManagedRig();
    cleanups.push(rig.cleanup);

    // UI interrupt 相当: sidecar.ts:174 は managed.stop("SIGINT") を呼ぶ。
    rig.session.stop("SIGINT");
    expect(rig.child.kills[0]).toBe("SIGINT"); // 1 段目は SIGINT。

    // 子 (claude プロセス) が SIGINT に応じて exit → session.exited が解決する (= session.ended 相当)。
    rig.child.emitExit(0);
    await expect(rig.session.exited).resolves.toBe(0);
  });

  // --- INV-STOP-ESCALATION ---------------------------------------------------
  it("INV-STOP-ESCALATION: a child that ignores SIGINT is SIGKILLed after killGraceMs", () => {
    vi.useFakeTimers();
    const graceMs = 5_000;
    const rig = makeManagedRig({ killGraceMs: graceMs });
    cleanups.push(rig.cleanup);

    // SIGINT を「握り潰す」子: stop で SIGINT は届くが exit を発火しない (= unresponsive)。
    rig.session.stop("SIGINT");
    expect(rig.child.kills).toEqual(["SIGINT"]);

    // 猶予未満では SIGKILL を撃たない。
    vi.advanceTimersByTime(graceMs - 1);
    expect(rig.child.kills).toEqual(["SIGINT"]);

    // 猶予到達で SIGKILL へ段階昇格 (escalation 除去時はここが届かずプロセスが死なない)。
    vi.advanceTimersByTime(1);
    expect(rig.child.kills).toEqual(["SIGINT", "SIGKILL"]);
  });

  it("INV-STOP-ESCALATION (clear-on-exit): child that exits within grace is NOT SIGKILLed", () => {
    vi.useFakeTimers();
    const graceMs = 5_000;
    const rig = makeManagedRig({ killGraceMs: graceMs });
    cleanups.push(rig.cleanup);

    rig.session.stop("SIGINT");
    // 猶予内に応答して exit → teardown が SIGKILL 予約を clear する (死んだ PID へ撃たない)。
    rig.child.emitExit(0);
    vi.advanceTimersByTime(graceMs * 2);
    expect(rig.child.kills).toEqual(["SIGINT"]); // SIGKILL は撃たれない。
  });

  it("INV-STOP-ESCALATION (double-stop): re-stop re-arms without double SIGKILL", () => {
    vi.useFakeTimers();
    const graceMs = 5_000;
    const rig = makeManagedRig({ killGraceMs: graceMs });
    cleanups.push(rig.cleanup);

    rig.session.stop("SIGINT");
    vi.advanceTimersByTime(graceMs - 1);
    rig.session.stop("SIGINT"); // 再 stop: 前回 timer を clear し再武装する。
    expect(rig.child.kills).toEqual(["SIGINT", "SIGINT"]);
    // 1 回目の予約は解除済 → 残り 1ms 進めても SIGKILL は出ない。
    vi.advanceTimersByTime(1);
    expect(rig.child.kills).toEqual(["SIGINT", "SIGINT"]);
    // 2 回目の猶予満了で SIGKILL は **1 回だけ**。
    vi.advanceTimersByTime(graceMs);
    expect(rig.child.kills).toEqual(["SIGINT", "SIGINT", "SIGKILL"]);
  });

  // --- INV-STOP-PID-SCOPED ---------------------------------------------------
  it("INV-STOP-PID-SCOPED: escalation kills only the owned child object (no process.kill, no negative PID)", () => {
    vi.useFakeTimers();
    const procKillSpy = vi.spyOn(process, "kill");
    const child: KillableChild & { kills: Array<string | undefined> } = {
      kills: [],
      kill(signal?: string) {
        this.kills.push(signal);
      },
    };
    const timer = escalateKill(child, { signal: "SIGINT", graceMs: 1_000 });
    vi.advanceTimersByTime(1_000);
    clearTimeout(timer);

    // child.kill のみが使われ、process.kill (PID/負 PID 直叩き) は一切呼ばれない。
    expect(child.kills).toEqual(["SIGINT", "SIGKILL"]);
    expect(procKillSpy).not.toHaveBeenCalled();
    procKillSpy.mockRestore();
  });

  it("INV-STOP-PID-SCOPED: managed stop routes through child.kill (no process.kill)", () => {
    vi.useFakeTimers();
    const procKillSpy = vi.spyOn(process, "kill");
    const rig = makeManagedRig({ killGraceMs: 1_000 });
    cleanups.push(rig.cleanup);

    rig.session.stop("SIGINT");
    vi.advanceTimersByTime(1_000);

    expect(rig.child.kills).toEqual(["SIGINT", "SIGKILL"]);
    expect(procKillSpy).not.toHaveBeenCalled(); // sidecar.md: 無関係 PID を巻き込まない。
    procKillSpy.mockRestore();
  });
});

/**
 * INV-STOP-SESSION-SCOPED / INV-STOP-INTERRUPT-E2E (routing):
 * 実 Sidecar の wsClient.on("interrupt") 配線 (sidecar.ts:161-176) を貫通する。
 * UI interrupt relay 相当に wsClient.emit("interrupt", {...}) を直接発火し、
 *  - 自セッション宛 → managed.stop("SIGINT") が呼ばれる (INV-STOP-INTERRUPT-E2E)。
 *  - foreign / 欠落  → managed.stop は呼ばれない (SEC-2 / INV-STOP-SESSION-SCOPED)。
 * managed は DB/実 claude を起こさないフェイクを private フィールドへ注入する (routing のみを固定)。
 */
describe("INV-STOP-SESSION-SCOPED : interrupt は自セッション宛のみ managed.stop する", () => {
  const cleanups: Array<() => void> = [];
  afterEach(async () => {
    for (const c of cleanups.splice(0)) c();
  });

  const SESSION_ID = "019ecd00-1111-7840-b8ed-stopscopedaaaa";

  function makeSidecarWithFakeManaged(): {
    sidecar: Sidecar;
    stop: ReturnType<typeof vi.fn>;
  } {
    const dir = mkdtempSync(join(tmpdir(), "stop-scoped-"));
    const sidecar = new Sidecar({
      sessionId: SESSION_ID,
      explicitSession: true, // canonical = fallback = SESSION_ID で固定 (learn 待ちにしない)。
      wsUrl: "ws://127.0.0.1:1/ingest/ws", // connect しない (start を呼ばない)。
      dbPath: join(dir, "sidecar.db"),
      cwd: dir,
    });
    const stop = vi.fn();
    // managed は private。routing の検証のため stop / dispose を持つフェイクを注入する
    // (shutdown が managed.dispose() を呼ぶため dispose も no-op で備える)。
    const fakeManaged = { stop, dispose: () => {} } as unknown as ManagedSession;
    (sidecar as unknown as { managed: ManagedSession | undefined }).managed = fakeManaged;
    cleanups.push(() => {
      void sidecar.shutdown();
    });
    return { sidecar, stop };
  }

  it("INV-STOP-INTERRUPT-E2E (routing): own session_id interrupt → managed.stop('SIGINT')", () => {
    const { sidecar, stop } = makeSidecarWithFakeManaged();
    sidecar.wsClient.emit("interrupt", { session_id: SESSION_ID });
    expect(stop).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalledWith("SIGINT");
  });

  it("INV-STOP-SESSION-SCOPED: foreign session_id interrupt → managed.stop NOT called", () => {
    const { sidecar, stop } = makeSidecarWithFakeManaged();
    sidecar.wsClient.emit("interrupt", { session_id: `${SESSION_ID}_FOREIGN` });
    expect(stop).not.toHaveBeenCalled();
  });

  it("INV-STOP-SESSION-SCOPED: missing session_id interrupt → managed.stop NOT called", () => {
    const { sidecar, stop } = makeSidecarWithFakeManaged();
    sidecar.wsClient.emit("interrupt", {});
    expect(stop).not.toHaveBeenCalled();
  });
});

/**
 * INV-STOP-ESCALATION (codex-runner): 共有 helper へ集約後の codex 固有 escalation 配線を pin する
 * (裁定 019ecfbf / QA-1)。managed と同じ不変条件を **codex 既定 SIGTERM** 向けに鏡写しで固定し、
 * codex stop の回帰 (誤 signal / 誤 graceMs / 再武装前 clear 欠落) が helper/managed の緑のまま
 * 見逃される死角を塞ぐ。実 codex は起動せず spawnChild を FakeCodexChild に差し替える。実 PID は
 * 一切操作しない。timing は vi.useFakeTimers で killGraceMs を厳密に進めて flaky を排除する。
 */
class FakeCodexChild implements CodexChildLike {
  readonly pid = 525252; // 実在しない PID (process-monitor は alive=false を観測するだけ)。
  readonly kills: Array<NodeJS.Signals | undefined> = [];
  private exitListeners: Array<(code: number | null, signal: NodeJS.Signals | null) => void> = [];

  // codex stdio: handshake は本テストで不要 (escalation は同期パスで stop に依存しない)。
  readonly stdin = { write: (): boolean => true };
  readonly stdout = {
    on: (): void => {},
    off: (): void => {},
  };
  readonly stderr = { on: (): void => {} };

  on(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this {
    if (event === "exit") this.exitListeners.push(listener);
    return this;
  }
  kill(signal?: NodeJS.Signals): boolean {
    this.kills.push(signal);
    return true;
  }
  /** 子 (codex プロセス) の OS exit を発火する。 */
  emitExit(code: number | null = 0, signal: NodeJS.Signals | null = null): void {
    for (const l of [...this.exitListeners]) l(code, signal);
  }
}

interface CodexRig {
  readonly child: FakeCodexChild;
  readonly session: ReturnType<typeof startManagedCodex>;
  readonly cleanup: () => void;
}

function makeCodexRig(opts?: { killGraceMs?: number }): CodexRig {
  const dir = mkdtempSync(join(tmpdir(), "stop-reliability-codex-"));
  const store = new EventStore(join(dir, "sidecar.db"));
  const wsClient = { notifyAppended: () => {} } as unknown as WsClient;
  const sink = new EventSink({ store, wsClient });
  const identity = new SessionIdentity({ fallbackSessionId: "sess_stop_codex", flushTimeoutMs: 0 });
  const approvalBridge = new ApprovalBridge({ timeoutMs: 1000 });
  const child = new FakeCodexChild();
  const session = startManagedCodex({
    sink,
    approvalBridge,
    identity,
    heartbeatMs: 999_999, // process monitor を実質止める (fake timer 干渉とノイズを避ける)。
    ...(opts?.killGraceMs !== undefined ? { killGraceMs: opts.killGraceMs } : {}),
    spawnChild: () => child, // env/spawn 配線の pin は inv-codex-child-env.test.ts で検証。
  });
  return {
    child,
    session,
    cleanup: () => {
      session.dispose();
      store.close();
    },
  };
}

describe("INV-STOP-* : 強み(a) 停止の確実性 (codex-runner escalation)", () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    vi.useRealTimers();
    for (const c of cleanups.splice(0)) c();
  });

  it("INV-STOP-ESCALATION (codex): stop() default sends SIGTERM then SIGKILL after killGraceMs", () => {
    vi.useFakeTimers();
    const graceMs = 5_000;
    const rig = makeCodexRig({ killGraceMs: graceMs });
    cleanups.push(rig.cleanup);

    // codex stop の既定シグナルは SIGTERM (managed の既定 SIGINT と非対称・codex-runner.ts:516)。
    rig.session.stop();
    expect(rig.child.kills).toEqual(["SIGTERM"]);

    // 猶予未満では SIGKILL を撃たない。
    vi.advanceTimersByTime(graceMs - 1);
    expect(rig.child.kills).toEqual(["SIGTERM"]);

    // 猶予到達で SIGKILL へ段階昇格 (escalateKill の timer 除去時はここが届かない)。
    vi.advanceTimersByTime(1);
    expect(rig.child.kills).toEqual(["SIGTERM", "SIGKILL"]);
  });

  it("INV-STOP-ESCALATION (codex, clear-on-exit): child that exits within grace is NOT SIGKILLed", () => {
    vi.useFakeTimers();
    const graceMs = 5_000;
    const rig = makeCodexRig({ killGraceMs: graceMs });
    cleanups.push(rig.cleanup);

    rig.session.stop("SIGTERM");
    // 猶予内に応答して exit → teardown が SIGKILL 予約を clear する (死んだ PID へ撃たない)。
    rig.child.emitExit(0, null);
    vi.advanceTimersByTime(graceMs * 2);
    expect(rig.child.kills).toEqual(["SIGTERM"]); // SIGKILL は撃たれない。
  });

  it("INV-STOP-ESCALATION (codex, double-stop): re-stop re-arms without double SIGKILL", () => {
    vi.useFakeTimers();
    const graceMs = 5_000;
    const rig = makeCodexRig({ killGraceMs: graceMs });
    cleanups.push(rig.cleanup);

    rig.session.stop("SIGTERM");
    vi.advanceTimersByTime(graceMs - 1);
    rig.session.stop("SIGTERM"); // 再 stop: 前回 timer を clear し再武装する。
    expect(rig.child.kills).toEqual(["SIGTERM", "SIGTERM"]);
    // 1 回目の予約は解除済 → 残り 1ms 進めても SIGKILL は出ない。
    vi.advanceTimersByTime(1);
    expect(rig.child.kills).toEqual(["SIGTERM", "SIGTERM"]);
    // 2 回目の猶予満了で SIGKILL は **1 回だけ**。
    vi.advanceTimersByTime(graceMs);
    expect(rig.child.kills).toEqual(["SIGTERM", "SIGTERM", "SIGKILL"]);
  });

  it("INV-STOP-PID-SCOPED (codex): stop routes through child.kill (no process.kill)", () => {
    vi.useFakeTimers();
    const procKillSpy = vi.spyOn(process, "kill");
    const rig = makeCodexRig({ killGraceMs: 1_000 });
    cleanups.push(rig.cleanup);

    rig.session.stop("SIGTERM");
    vi.advanceTimersByTime(1_000);

    expect(rig.child.kills).toEqual(["SIGTERM", "SIGKILL"]);
    expect(procKillSpy).not.toHaveBeenCalled(); // sidecar.md: 無関係 PID を巻き込まない。
    procKillSpy.mockRestore();
  });
});
