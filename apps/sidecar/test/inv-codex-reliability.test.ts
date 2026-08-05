/**
 * INV-CODEX-RELIABILITY — P4 Codex Managed Mode transport/lifecycle 信頼性強化 (ADR 019f2421).
 *
 * 承認ロジックは現行で正しい (別テストで pin 済)。本ファイルは **enforcement transport/lifecycle**
 * の 4 hardening (+R5) を falsifiable な INV として固定する:
 *  - INV-CODEX-HANDSHAKE-TIMEOUT (R1): 無応答 app-server → handshake が有界で reject → child 停止 →
 *    session.ended(failed, handshake_timeout) を 1 回 emit (canonical 未確定でも fallback で観測)。
 *  - INV-CODEX-STREAM-ERROR-CONTAINED (R2): stdin/stdout "error" (EPIPE) → daemon crash させず
 *    (unhandled にしない)・diag + safe teardown で封じ込め。send の同期 write throw も局所吸収。
 *  - INV-CODEX-FRAME-BUFFER-BOUND (R3): newline 無し >cap bytes → buffer reset + parse-error diag、
 *    以降の正常 frame は parse 継続。
 *  - INV-CODEX-APPROVAL-EXIT-DRAIN (R4): in-flight 承認 + child exit → 死 pipe へ write せず即 deny 解決
 *    (30s timeout 宙吊りを除去)・二重解決なし。
 *  - INV-CODEX-STOP-STATE (R5): operator stop → session.ended が crash (failed) と graceful stop
 *    (completed/stopped) を区別。
 *
 * REAL DATA: 正規化・redaction・persist・承認ゲートは実コード。mock は codex 子プロセスの I/O 境界のみ。
 */
import { EventEmitter } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ApprovalBridge } from "../src/approval-bridge.js";
import { CodexJsonRpc, type CodexInboundMessage } from "../src/codex-jsonrpc.js";
import { startManagedCodex, type ChildLike } from "../src/codex-runner.js";
import { SessionIdentity } from "../src/session-identity.js";
import { EventSink } from "../src/sink.js";
import { EventStore } from "../src/store.js";
import type { WsClient } from "../src/ws-client.js";

const THREAD_ID = "019ea327-2f0f-7840-b8ed-d36285b533a1";
const SESSION_ID = "019ea400-1111-7840-b8ed-aaaaaaaaaaaa";
const FALLBACK = "sess_fallback";

/** EPIPE 様のエラー (errno code 付き) を作る。 */
function epipe(): NodeJS.ErrnoException {
  const e = new Error("write EPIPE") as NodeJS.ErrnoException;
  e.code = "EPIPE";
  return e;
}

/**
 * フェイク codex 子プロセス。stdin/stdout に error listener を張れる (R2)。
 * autoHandshake=false で無応答 server を模す (R1)。writeThrows で死 stream write を模す (R2 send-guard)。
 */
class FakeCodexChild extends EventEmitter implements ChildLike {
  readonly pid = 424242;
  private stdinBuf = "";
  readonly inbound: Array<Record<string, unknown>> = [];
  readonly stdoutEmitter = new EventEmitter();
  readonly stdinEmitter = new EventEmitter();
  readonly stderrEmitter = new EventEmitter();
  killed: NodeJS.Signals | undefined;
  killCount = 0;
  autoHandshake = true;
  writeThrows = false;

  readonly stdin = {
    write: (chunk: string): boolean => {
      if (this.writeThrows) throw epipe();
      this.stdinBuf += chunk;
      let i: number;
      while ((i = this.stdinBuf.indexOf("\n")) >= 0) {
        const line = this.stdinBuf.slice(0, i);
        this.stdinBuf = this.stdinBuf.slice(i + 1);
        if (line.trim()) this.onClientMessage(JSON.parse(line) as Record<string, unknown>);
      }
      return true;
    },
    on: (ev: "error", l: (err: Error) => void) => this.stdinEmitter.on(ev, l),
  };
  readonly stdout = {
    on: (ev: "data", l: (c: Buffer | string) => void) => this.stdoutEmitter.on(ev, l),
    off: (ev: "data", l: (c: Buffer | string) => void) => this.stdoutEmitter.off(ev, l),
  };
  readonly stderr = {
    on: (ev: "data", l: (c: Buffer | string) => void) => this.stderrEmitter.on(ev, l),
  };

  // on("exit", …) は EventEmitter を継承して ChildLike を満たす (独自 override は不要・
  //   overload 実装署名が (...args: unknown[]) だと exit overload と非互換=TS2394 になるため置かない)。

  kill(signal?: NodeJS.Signals): boolean {
    this.killed = signal ?? "SIGTERM";
    this.killCount += 1;
    return true;
  }

  emitLine(msg: Record<string, unknown>): void {
    this.stdoutEmitter.emit("data", JSON.stringify(msg) + "\n");
  }
  emitExit(code: number | null, signal: NodeJS.Signals | null = null): void {
    this.emit("exit", code, signal);
  }

  private onClientMessage(msg: Record<string, unknown>): void {
    this.inbound.push(msg);
    if (!this.autoHandshake) return; // R1: 無応答 server を模す (handshake が timeout する)。
    const id = msg.id;
    const method = msg.method;
    if (method === "initialize") {
      this.emitLine({ id, result: { userAgent: "fake/0.137.0", codexHome: "/home/x/.codex" } });
    } else if (method === "thread/start") {
      this.emitLine({
        id,
        result: {
          thread: { id: THREAD_ID, sessionId: SESSION_ID, status: { type: "idle" } },
          model: "gpt-x",
        },
      });
    } else if (method === "turn/start") {
      this.emitLine({ id, result: { turn: { id: "turn_1", status: "inProgress", items: [] } } });
    }
  }
}

describe("INV-CODEX-RELIABILITY: transport/lifecycle hardening", () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    for (const c of cleanups.splice(0)) c();
  });

  function makeRig(opts?: {
    configure?: (c: FakeCodexChild) => void;
    approvalTimeoutMs?: number;
    rpcTimeoutMs?: number;
  }) {
    const dir = mkdtempSync(join(tmpdir(), "codex-rel-"));
    const store = new EventStore(join(dir, "sidecar.db"));
    const wsClient = { notifyAppended: () => {} } as unknown as WsClient;
    const sink = new EventSink({ store, wsClient });
    const identity = new SessionIdentity({ fallbackSessionId: FALLBACK, flushTimeoutMs: 0 });
    const approvalBridge = new ApprovalBridge({ timeoutMs: opts?.approvalTimeoutMs ?? 30_000 });
    const child = new FakeCodexChild();
    opts?.configure?.(child);
    const session = startManagedCodex({
      sink,
      approvalBridge,
      identity,
      heartbeatMs: 999_999,
      killGraceMs: 50,
      ...(opts?.rpcTimeoutMs !== undefined ? { rpcTimeoutMs: opts.rpcTimeoutMs } : {}),
      spawnChild: () => child,
    });
    cleanups.push(() => {
      session.dispose();
      store.close();
    });
    return { store, sink, identity, approvalBridge, child, session };
  }

  async function waitHandshake(identity: SessionIdentity): Promise<void> {
    for (let i = 0; i < 100; i++) {
      if (identity.isResolved()) return;
      await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error("handshake did not resolve canonical");
  }

  function endedRows(store: EventStore) {
    return store
      .allRows()
      .filter((r) => r.event_type === "session.ended")
      .map(
        (r) =>
          JSON.parse(r.event_json) as {
            state?: string;
            session_id: string;
            payload?: unknown;
            end_kind?: string;
            recoverability?: string;
          },
      );
  }
  function endedReason(row: { payload?: unknown }): string | undefined {
    const p = row.payload as { reason?: string } | undefined;
    return p?.reason;
  }

  // ---------------- R1 ----------------
  it("INV-CODEX-HANDSHAKE-TIMEOUT: unresponsive app-server → bounded reject → child killed → session.ended(failed, handshake_timeout) once", async () => {
    const rig = makeRig({
      rpcTimeoutMs: 60,
      configure: (c) => {
        c.autoHandshake = false; // initialize に応答しない → request が timeout する。
      },
    });
    // handshake は canonical を確定できない (無応答)。timeout→failure emit を待つ。
    let ended: ReturnType<typeof endedRows> = [];
    for (let i = 0; i < 120; i++) {
      ended = endedRows(rig.store);
      if (ended.length > 0) break;
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(ended.length).toBe(1);
    expect(ended[0]!.state).toBe("failed");
    expect(endedReason(ended[0]!)).toBe("handshake_timeout");
    // ADR 0014 Phase 3c (decision 019fd250): handshake/接続失敗経路も child-exit 経路と
    // uniform に end_kind/recoverability を明示する (経路により continuation 表示が揺れない)。
    expect(ended[0]!.end_kind).toBe("failed");
    expect(ended[0]!.recoverability).toBe("not_resumable");
    // canonical 未確定でも fallback id で観測される (silent hang でない)。
    expect(ended[0]!.session_id).toBe(FALLBACK);
    // un-enforceable zombie を残さない: child を停止した。
    expect(rig.child.killed).toBeDefined();
  });

  // ---------------- R2 ----------------
  it("INV-CODEX-STREAM-ERROR-CONTAINED: stdout 'error' (EPIPE) is contained (no crash) + failed session.ended + teardown", async () => {
    const rig = makeRig();
    await waitHandshake(rig.identity);
    // stdout 'error' を注入。listener が張られているので **throw しない** (= daemon 全体は落ちない)。
    // listener 未登録 (mutant) だと EventEmitter が 'error' を投げ、この emit が throw する (RED)。
    expect(() => rig.child.stdoutEmitter.emit("error", epipe())).not.toThrow();
    await new Promise((r) => setTimeout(r, 10));
    const ended = endedRows(rig.store);
    expect(ended.length).toBe(1);
    expect(ended[0]!.state).toBe("failed");
    expect(endedReason(ended[0]!)).toBe("stdout_error");
    // teardown 済: stdout "data" listener が外れている (これ以降 emit しても新イベントを生まない)。
    rig.child.emitLine({
      method: "item/agentMessage/delta",
      params: { threadId: THREAD_ID, delta: "x" },
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(endedRows(rig.store).length).toBe(1);
  });

  it("INV-CODEX-STREAM-ERROR-CONTAINED: stdin 'error' (EPIPE) is contained (no crash)", async () => {
    const rig = makeRig();
    await waitHandshake(rig.identity);
    expect(() => rig.child.stdinEmitter.emit("error", epipe())).not.toThrow();
    await new Promise((r) => setTimeout(r, 10));
    const ended = endedRows(rig.store);
    expect(ended.length).toBe(1);
    expect(endedReason(ended[0]!)).toBe("stdin_error");
  });

  it("INV-CODEX-STREAM-ERROR-CONTAINED: CodexJsonRpc.send catches write-after-death (no throw, onWriteError observed)", () => {
    const stdout = new EventEmitter();
    let writeErr: unknown;
    const rpc = new CodexJsonRpc({
      stdin: {
        write: () => {
          throw epipe();
        },
      },
      stdout: {
        on: (ev, l) => stdout.on(ev, l),
        off: (ev, l) => stdout.off(ev, l),
      },
      onMessage: () => {},
      onWriteError: (e) => {
        writeErr = e;
      },
    });
    // send の write が同期 throw しても send は throw しない (局所吸収 → onWriteError)。
    expect(() => rpc.send({ id: 1, method: "x" })).not.toThrow();
    expect((writeErr as NodeJS.ErrnoException | undefined)?.code).toBe("EPIPE");
  });

  it("R2: stdout 'end'/'close' defers to authoritative exit (no false-failed on clean exit) but kills lingering process", async () => {
    const rig = makeRig();
    await waitHandshake(rig.identity);
    // stdout end/close は直接 failed を emit せず lingering process を停止する (authoritative は exit)。
    rig.child.stdoutEmitter.emit("end");
    expect(rig.child.killed).toBeDefined(); // lingering process を終端した (zombie 回避)。
    expect(endedRows(rig.store).length).toBe(0); // まだ session.ended は出ていない (exit を待つ)。
    // 実際の clean exit が来たら completed で確定する (false-failed にしない)。
    rig.child.emitExit(0, null);
    await new Promise((r) => setTimeout(r, 10));
    const ended = endedRows(rig.store);
    expect(ended.length).toBe(1);
    expect(ended[0]!.state).toBe("completed");
  });

  // ---------------- R3 ----------------
  it("INV-CODEX-FRAME-BUFFER-BOUND: >cap bytes with no newline resets buffer + parse-error; normal frames still parse", () => {
    const stdout = new EventEmitter();
    const messages: CodexInboundMessage[] = [];
    const parseErrors: string[] = [];
    // 構築の副作用で stdout "data" listener を張る (以降は stdout へ直接 emit する)。
    void new CodexJsonRpc({
      stdin: { write: () => {} },
      stdout: {
        on: (ev, l) => stdout.on(ev, l),
        off: (ev, l) => stdout.off(ev, l),
      },
      onMessage: (m) => messages.push(m),
      onParseError: (line) => parseErrors.push(line),
    });
    const CAP = 16 * 1024 * 1024;
    // newline 無しで cap 超の flood を投入 → buffer reset + parse-error (fail-safe)。
    stdout.emit("data", "a".repeat(CAP + 32));
    expect(parseErrors.some((l) => l.includes("oversized frame dropped"))).toBe(true);
    // reset されているので、後続の正常 frame は正しく parse される (巨大 prefix を引きずらない)。
    stdout.emit("data", `{"method":"ok"}\n`);
    expect(messages.map((m) => m.method)).toEqual(["ok"]);
    // NO-RAW: parse-error は生 buffer 本文を含まない (固定リテラル + byte 数のみ)。
    expect(parseErrors.every((l) => !l.includes("aaaa"))).toBe(true);
  });

  // ---------------- R4 ----------------
  it("INV-CODEX-APPROVAL-EXIT-DRAIN: in-flight approval + child exit → deny-resolved promptly, no dead-pipe write, no double-resolve", async () => {
    const rig = makeRig({ approvalTimeoutMs: 30_000 });
    await waitHandshake(rig.identity);
    // codex が承認 ServerRequest を送る (high-risk command)。
    rig.child.emitLine({
      id: 7,
      method: "item/commandExecution/requestApproval",
      params: {
        itemId: "i1",
        threadId: THREAD_ID,
        turnId: "turn_1",
        command: "rm -rf /tmp/x",
        cwd: "/repo",
      },
    });
    await new Promise((r) => setTimeout(r, 0));
    // in-flight: UI カードが出て bridge pending が 1 (30s timeout 待ち)。
    expect(rig.approvalBridge.pendingCount).toBe(1);
    const cardRows = rig.store
      .allRows()
      .filter((r) => r.event_type === "tool.permission.requested");
    expect(cardRows.length).toBe(1);

    // child exit → cancelInFlight で即 deny 解決 + 死 pipe write 抑止。
    rig.child.emitExit(1, null);
    await new Promise((r) => setTimeout(r, 10));

    // 30s を待たず即解決 (pending が 0 に)。
    expect(rig.approvalBridge.pendingCount).toBe(0);
    // 死 pipe への Response write が発生していない (id=7 の result frame が stdin に書かれていない)。
    const deadPipeWrites = rig.child.inbound.filter(
      (m) => m.id === 7 && (m as { result?: unknown }).result !== undefined,
    );
    expect(deadPipeWrites.length).toBe(0);
    // session.ended は 1 回 (child exit 由来・二重終端なし)。
    expect(endedRows(rig.store).length).toBe(1);
  });

  // ---------------- R4 concurrency (QA-1) ----------------
  // 上の R4 テストは child exit 単発のみ検証する。ここでは **concurrent** な三者衝突を pin する:
  //   ① child exit (cancelInFlight を同期起動) ② sidecar.ts:371 の global drain ③ 遅延到着した UI resolve。
  // これらが同一 tick で競合しても、triple-guard が死 pipe write / 二重解決 / 二重終端を構造的に防ぐ:
  //   guard-1 = cancelInFlight の suppressed latch (finish の sendResponse を抑止)
  //   guard-2 = finish の inFlight.has gate (cancelInFlight が inFlight を先に掃除 → 遅延 .then(finish) が no-op)
  //   guard-3 = bridge.resolve の pending-deleted (deny 解決で pending 削除済 → 後続 resolve は false)。
  // これは R2 の死 pipe crash を R4 が防ぐという不変条件を、レース条件下で falsifiable に固定する。
  it("INV-CODEX-APPROVAL-EXIT-DRAIN (concurrent): child exit + global drain + racing late resolve → exactly one session.ended, zero dead-pipe result frame, late resolve() false", async () => {
    const rig = makeRig({ approvalTimeoutMs: 30_000 });
    await waitHandshake(rig.identity);
    // in-flight codex 承認 (high-risk command)。
    rig.child.emitLine({
      id: 7,
      method: "item/commandExecution/requestApproval",
      params: {
        itemId: "i1",
        threadId: THREAD_ID,
        turnId: "turn_1",
        command: "rm -rf /tmp/x",
        cwd: "/repo",
      },
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(rig.approvalBridge.pendingCount).toBe(1);
    // UI カード payload から bridge request_id を取得 (racing late resolve に使う)。
    const cardRow = rig.store.allRows().find((r) => r.event_type === "tool.permission.requested");
    const requestId = (JSON.parse(cardRow!.event_json) as { payload: { request_id: string } })
      .payload.request_id;
    expect(typeof requestId).toBe("string");

    // ① child exit → cancelInFlight を同期起動 (suppressed latch + inFlight 掃除 + bridge deny 解決)。
    rig.child.emitExit(1, null);
    // ② concurrent な全体 shutdown drain (sidecar.ts:371)。pending は既に cancelInFlight が deny 解決済ゆえ no-op。
    rig.approvalBridge.drain();
    // ③ racing late な UI 応答 (allow)。pending 削除済ゆえ二重解決しない。
    const lateResolved = rig.approvalBridge.resolve(requestId, "allow");
    // 遅延する .then(finish) microtask を走らせる (guard-1/2 で sendResponse 非到達を確認)。
    await new Promise((r) => setTimeout(r, 10));

    // (guard-3) racing late resolve は pending 削除済ゆえ false。
    expect(lateResolved).toBe(false);
    // pending は 0 (cancelInFlight の deny 解決で除去済・drain/late は no-op)。
    expect(rig.approvalBridge.pendingCount).toBe(0);
    // (guard-1 + guard-2) 死 pipe への Response frame が **一切** 書かれていない
    //   (id=7 の {id,result} frame が exit 後に出ない)。suppressed latch + inFlight.has gate の複合。
    const deadPipeWrites = rig.child.inbound.filter(
      (m) => m.id === 7 && (m as { result?: unknown }).result !== undefined,
    );
    expect(deadPipeWrites.length).toBe(0);
    // session.ended は child exit 由来の 1 回のみ (二重終端なし)。
    expect(endedRows(rig.store).length).toBe(1);
  });

  // ---------------- R1 env knob (QA-3) ----------------
  // rpcTimeoutMs の解決 (codex-runner.ts:191-197) は seam → env → 既定 25s の三段。既存テストは
  // opts.rpcTimeoutMs (seam) のみを行使する。ここでは operator 向けの **env 分岐** を pin する:
  //   ① env 指定値が honor される ② 0/負値は無効化を許さず既定 (25s) へ fail-safe で倒れる。
  it("QA-3: ACTRADECK_CODEX_RPC_TIMEOUT_MS env value is honored (drives handshake reject)", async () => {
    const prev = process.env.ACTRADECK_CODEX_RPC_TIMEOUT_MS;
    process.env.ACTRADECK_CODEX_RPC_TIMEOUT_MS = "40";
    try {
      // opts.rpcTimeoutMs は渡さない → env 解決枝を通す。無応答 server で env timeout が発火する。
      const rig = makeRig({
        configure: (c) => {
          c.autoHandshake = false;
        },
      });
      let ended: ReturnType<typeof endedRows> = [];
      for (let i = 0; i < 120; i++) {
        ended = endedRows(rig.store);
        if (ended.length > 0) break;
        await new Promise((r) => setTimeout(r, 5));
      }
      // env=40ms が採用されていれば短 budget 内で handshake_timeout が観測される。
      expect(ended.length).toBe(1);
      expect(ended[0]!.state).toBe("failed");
      expect(endedReason(ended[0]!)).toBe("handshake_timeout");
    } finally {
      if (prev === undefined) delete process.env.ACTRADECK_CODEX_RPC_TIMEOUT_MS;
      else process.env.ACTRADECK_CODEX_RPC_TIMEOUT_MS = prev;
    }
  });

  it("QA-3: ACTRADECK_CODEX_RPC_TIMEOUT_MS <=0 falls back to 25s default (fail-safe: no fast timeout)", async () => {
    const prev = process.env.ACTRADECK_CODEX_RPC_TIMEOUT_MS;
    process.env.ACTRADECK_CODEX_RPC_TIMEOUT_MS = "0"; // 無効化 (0) を許さず既定 25s へ倒れるべき。
    try {
      const rig = makeRig({
        configure: (c) => {
          c.autoHandshake = false;
        },
      });
      // 0 が誤って採用されれば setTimeout(…,0) が即発火し handshake_timeout が出る。
      //   fail-safe (25s) が効いていれば短 budget (~250ms) 内で session.ended は出ない。
      for (let i = 0; i < 50; i++) {
        if (endedRows(rig.store).length > 0) break;
        await new Promise((r) => setTimeout(r, 5));
      }
      expect(endedRows(rig.store).length).toBe(0);
    } finally {
      if (prev === undefined) delete process.env.ACTRADECK_CODEX_RPC_TIMEOUT_MS;
      else process.env.ACTRADECK_CODEX_RPC_TIMEOUT_MS = prev;
    }
  });

  // ---------------- R5 ----------------
  it("INV-CODEX-STOP-STATE: operator stop → session.ended completed/stopped (not crash-failed)", async () => {
    const rig = makeRig();
    await waitHandshake(rig.identity);
    rig.session.stop("SIGTERM"); // operator 起点の graceful stop。
    expect(rig.child.killed).toBe("SIGTERM");
    // stop が誘発する signal exit を模す。
    rig.child.emitExit(null, "SIGTERM");
    await new Promise((r) => setTimeout(r, 10));
    const ended = endedRows(rig.store);
    expect(ended.length).toBe(1);
    expect(ended[0]!.state).toBe("completed"); // crash でなく graceful stop。
    expect(endedReason(ended[0]!)).toBe("stopped");
  });

  it("INV-CODEX-STOP-STATE (contrast): signal exit WITHOUT operator stop → failed (crash)", async () => {
    const rig = makeRig();
    await waitHandshake(rig.identity);
    rig.child.emitExit(null, "SIGKILL"); // operator stop なし = crash。
    await new Promise((r) => setTimeout(r, 10));
    const ended = endedRows(rig.store);
    expect(ended.length).toBe(1);
    expect(ended[0]!.state).toBe("failed");
    expect(endedReason(ended[0]!)).toBe("signal_SIGKILL");
  });
});
