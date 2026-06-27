/**
 * LIVE-2: Managed Mode の PTY ↔ ユーザー実端末 双方向接続 (wireTerminal)。
 *
 * 真因 (decision 019e956e): managed-runner は child.onData→collector.push で監視取り込みのみ行い、
 * ユーザー端末 (process.stdout) にエコーせず process.stdin も子へ転送しなかった。結果、起動した
 * claude を操作・視認できず、プロンプト未送信→hook 未発火→canonical 未学習に降格していた。
 *
 * 本テストは wireTerminal の契約 (a)-(e) を固定する:
 *  (a) child PTY data → terminal.stdout エコー (かつ collector への取り込みと両立)。
 *  (b) terminal.stdin → child.write 転送 (TTY のとき raw mode 化)。
 *  (c) terminal resize → child.resize (初期サイズも実端末に合わせる)。
 *  (d) restore() で raw mode を false に戻し全リスナ解除 (idempotent)。
 *  (e) 非 TTY (CI/パイプ) では raw 化・resize・stdin 転送をスキップし collector のみ駆動。
 *
 * PTY と端末の境界はフェイク注入でユニット化する (実 node-pty を起動しない)。
 */
import { describe, expect, it } from "vitest";

import {
  wireTerminal,
  type PtyLike,
  type TerminalInput,
  type TerminalOutput,
  type TerminalLike,
} from "../src/managed-runner.js";

interface DataListener {
  (data: string): void;
}
interface ExitListener {
  (e: { exitCode: number; signal?: number }): void;
}

class FakePty implements PtyLike {
  readonly pid = 4242;
  dataListeners: DataListener[] = [];
  exitListeners: ExitListener[] = [];
  writes: string[] = [];
  resizes: Array<[number, number]> = [];
  kills: Array<string | undefined> = [];
  dataDisposed = 0;

  onData(listener: DataListener): { dispose(): void } {
    this.dataListeners.push(listener);
    return {
      dispose: () => {
        this.dataDisposed++;
        this.dataListeners = this.dataListeners.filter((l) => l !== listener);
      },
    };
  }
  onExit(listener: ExitListener): { dispose(): void } {
    this.exitListeners.push(listener);
    return { dispose: () => {} };
  }
  write(data: string): void {
    this.writes.push(data);
  }
  resize(cols: number, rows: number): void {
    this.resizes.push([cols, rows]);
  }
  kill(signal?: string): void {
    this.kills.push(signal);
  }
  // テスト用: 子が出力した体で data listener を駆動。
  emitData(data: string): void {
    for (const l of [...this.dataListeners]) l(data);
  }
}

class FakeStdin implements TerminalInput {
  isTTY: boolean;
  rawCalls: boolean[] = [];
  resumed = 0;
  paused = 0;
  private listeners: Array<(c: Buffer | string) => void> = [];
  // setRawMode を「存在させるか」制御 (非 TTY パイプは setRawMode を持たない/throw する)。
  private readonly hasSetRawMode: boolean;
  setRawMode?: (mode: boolean) => void;

  constructor(isTTY: boolean, hasSetRawMode = true) {
    this.isTTY = isTTY;
    this.hasSetRawMode = hasSetRawMode;
    if (hasSetRawMode) {
      this.setRawMode = (mode: boolean): void => {
        this.rawCalls.push(mode);
      };
    }
  }
  resume(): void {
    this.resumed++;
  }
  pause(): void {
    this.paused++;
  }
  on(_event: "data", listener: (c: Buffer | string) => void): void {
    this.listeners.push(listener);
  }
  off(_event: "data", listener: (c: Buffer | string) => void): void {
    this.listeners = this.listeners.filter((l) => l !== listener);
  }
  get dataListenerCount(): number {
    return this.listeners.length;
  }
  emitKey(chunk: Buffer | string): void {
    for (const l of [...this.listeners]) l(chunk);
  }
}

class FakeStdout implements TerminalOutput {
  isTTY: boolean;
  columns: number;
  rows: number;
  written: string[] = [];
  private listeners: Array<() => void> = [];

  constructor(isTTY: boolean, columns = 100, rows = 30) {
    this.isTTY = isTTY;
    this.columns = columns;
    this.rows = rows;
  }
  write(data: string): boolean {
    this.written.push(data);
    return true;
  }
  on(_event: "resize", listener: () => void): void {
    this.listeners.push(listener);
  }
  off(_event: "resize", listener: () => void): void {
    this.listeners = this.listeners.filter((l) => l !== listener);
  }
  get resizeListenerCount(): number {
    return this.listeners.length;
  }
  triggerResize(cols: number, rows: number): void {
    this.columns = cols;
    this.rows = rows;
    for (const l of [...this.listeners]) l();
  }
}

function makeTerm(stdin: FakeStdin, stdout: FakeStdout): TerminalLike {
  return { stdin, stdout };
}

describe("LIVE-2: wireTerminal (TTY)", () => {
  it("(a) echoes child data to terminal.stdout AND still drives the collector", () => {
    const child = new FakePty();
    const stdin = new FakeStdin(true);
    const stdout = new FakeStdout(true);
    const collected: string[] = [];
    wireTerminal(child, makeTerm(stdin, stdout), (d) => collected.push(d));

    child.emitData("hello-tui\x1b[0m");

    expect(stdout.written).toContain("hello-tui\x1b[0m"); // 端末エコー
    expect(collected).toEqual(["hello-tui\x1b[0m"]); // 監視取り込みと両立
  });

  it("(b) forwards terminal.stdin keystrokes to child.write and enables raw mode", () => {
    const child = new FakePty();
    const stdin = new FakeStdin(true);
    const stdout = new FakeStdout(true);
    wireTerminal(child, makeTerm(stdin, stdout), () => {});

    expect(stdin.rawCalls).toContain(true); // raw mode ON
    expect(stdin.resumed).toBeGreaterThanOrEqual(1);

    stdin.emitKey(Buffer.from("ls\r", "utf8"));
    stdin.emitKey("\x03"); // Ctrl-C (raw だと TUI が受け取る)

    expect(child.writes).toEqual(["ls\r", "\x03"]);
  });

  it("(c) applies initial size from real terminal and resizes child on SIGWINCH", () => {
    const child = new FakePty();
    const stdin = new FakeStdin(true);
    const stdout = new FakeStdout(true, 137, 51);
    wireTerminal(child, makeTerm(stdin, stdout), () => {});

    // 初期サイズを実端末に合わせる (120x40 ハードコードでない)。
    expect(child.resizes[0]).toEqual([137, 51]);

    stdout.triggerResize(80, 24);
    expect(child.resizes).toContainEqual([80, 24]);
  });

  it("(d) restore() resets raw mode to false and removes all listeners (idempotent)", () => {
    const child = new FakePty();
    const stdin = new FakeStdin(true);
    const stdout = new FakeStdout(true);
    const bridge = wireTerminal(child, makeTerm(stdin, stdout), () => {});

    expect(stdin.dataListenerCount).toBe(1);
    expect(stdout.resizeListenerCount).toBe(1);

    bridge.restore();

    expect(stdin.rawCalls[stdin.rawCalls.length - 1]).toBe(false); // raw を戻す
    expect(stdin.dataListenerCount).toBe(0); // stdin リスナ解除
    expect(stdout.resizeListenerCount).toBe(0); // resize リスナ解除
    expect(child.dataDisposed).toBe(1); // child onData dispose

    // 二重 restore でも throw せず、raw(false) を重ねて呼ばない。
    const rawFalseCount = stdin.rawCalls.filter((m) => m === false).length;
    bridge.restore();
    expect(stdin.rawCalls.filter((m) => m === false).length).toBe(rawFalseCount);
  });

  it("(d) after restore, further child data and keystrokes are not forwarded", () => {
    const child = new FakePty();
    const stdin = new FakeStdin(true);
    const stdout = new FakeStdout(true);
    const collected: string[] = [];
    const bridge = wireTerminal(child, makeTerm(stdin, stdout), (d) => collected.push(d));
    bridge.restore();

    child.emitData("late"); // listener 解除済 → エコーも collector も動かない
    stdin.emitKey("x"); // listener 解除済 → child へ転送されない

    expect(stdout.written).not.toContain("late");
    expect(collected).not.toContain("late");
    expect(child.writes).not.toContain("x");
  });
});

describe("LIVE-2: wireTerminal (non-TTY safe branch)", () => {
  it("(e) skips raw mode / stdin forwarding / resize when stdin is not a TTY but still echoes + collects", () => {
    const child = new FakePty();
    // 非 TTY パイプ: isTTY=false かつ setRawMode を持たない (実 process.stdin の挙動)。
    const stdin = new FakeStdin(false, false);
    const stdout = new FakeStdout(false);
    const collected: string[] = [];
    const bridge = wireTerminal(child, makeTerm(stdin, stdout), (d) => collected.push(d));

    // raw 化しない / stdin 転送しない / resize しない。
    expect(stdin.rawCalls).toEqual([]);
    expect(stdin.dataListenerCount).toBe(0);
    expect(stdout.resizeListenerCount).toBe(0);
    expect(child.resizes).toEqual([]);

    // collector + エコーは駆動する (既存挙動を保つ)。
    child.emitData("ci-output");
    expect(collected).toEqual(["ci-output"]);
    expect(stdout.written).toContain("ci-output");

    // restore は no-op で安全。
    expect(() => bridge.restore()).not.toThrow();
    expect(stdin.rawCalls).toEqual([]); // raw を一度も触らない
  });

  it("(e) skips raw mode when stdin has no setRawMode even if isTTY is somehow true", () => {
    const child = new FakePty();
    const stdin = new FakeStdin(true, false); // isTTY だが setRawMode 不在
    const stdout = new FakeStdout(true);
    const bridge = wireTerminal(child, makeTerm(stdin, stdout), () => {});

    expect(stdin.dataListenerCount).toBe(0); // 転送配線しない
    expect(() => bridge.restore()).not.toThrow();
  });

  it("(a) echo failures do not break collector intake", () => {
    const child = new FakePty();
    const stdin = new FakeStdin(false, false);
    const stdout = new FakeStdout(false);
    stdout.write = (): boolean => {
      throw new Error("terminal closed");
    };
    const collected: string[] = [];
    wireTerminal(child, makeTerm(stdin, stdout), (d) => collected.push(d));

    expect(() => child.emitData("x")).not.toThrow();
    expect(collected).toEqual(["x"]); // エコー失敗でも監視は継続
  });
});
