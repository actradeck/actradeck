/**
 * INV-CODEX-SESSION-ID + INV-CODEX-REDACTION-TRANSPARENCY — startManagedCodex 配線。
 *
 * 実 EventStore(temp SQLite) + 実 EventSink(redactDeep choke) + 実 SessionIdentity を使い、
 * **フェイク codex 子プロセス** (JSON-RPC を喋る EventEmitter) を注入して handshake →
 * notification → sink を貫通させる。mock は子プロセスの I/O 境界のみ (REAL DATA: 正規化・
 * redaction・persist は実コード)。
 *
 * SESSION-ID: 全イベント session_id===thread.id, provider_session_id===thread.sessionId。
 * AGG-1: process/exited は drop (process/spawn ライフサイクル通知・session 終端ではない)。
 * AGG-2: 真の終端源は child OS exit と thread/closed。child exit で session.ended を 1 回 emit
 *   (idempotent・state は exit code/signal で completed/failed)。
 * REDACTION-TRANSPARENCY: codex notification の payload (diff/command/token) に秘匿を仕込み、
 *   SQLite/送信路に [REDACTED:*] が出て raw が残らないことを assert。
 */
import { mkdtempSync } from "node:fs";
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ApprovalBridge } from "../src/approval-bridge.js";
import { startManagedCodex, type ChildLike } from "../src/codex-runner.js";
import { SessionIdentity } from "../src/session-identity.js";
import { EventSink } from "../src/sink.js";
import { EventStore } from "../src/store.js";
import type { WsClient } from "../src/ws-client.js";

const THREAD_ID = "019ea327-2f0f-7840-b8ed-d36285b533a1";
const SESSION_ID = "019ea400-1111-7840-b8ed-aaaaaaaaaaaa";

/** フェイク codex 子プロセス。stdin に書かれた JSON-RPC に応答し、任意 notification を流せる。 */
class FakeCodexChild extends EventEmitter implements ChildLike {
  readonly pid = 999999; // 実在しない PID (process-monitor は alive=false を観測するだけ)。
  private stdinBuf = "";
  readonly inbound: Array<Record<string, unknown>> = [];
  readonly stdoutEmitter = new EventEmitter();
  readonly stderrEmitter = new EventEmitter();
  killed: NodeJS.Signals | undefined;

  readonly stdin = {
    write: (chunk: string): boolean => {
      this.stdinBuf += chunk;
      let i: number;
      while ((i = this.stdinBuf.indexOf("\n")) >= 0) {
        const line = this.stdinBuf.slice(0, i);
        this.stdinBuf = this.stdinBuf.slice(i + 1);
        if (line.trim()) this.onClientMessage(JSON.parse(line) as Record<string, unknown>);
      }
      return true;
    },
  };
  readonly stdout = {
    on: (ev: "data", l: (c: Buffer | string) => void) => this.stdoutEmitter.on(ev, l),
    off: (ev: "data", l: (c: Buffer | string) => void) => this.stdoutEmitter.off(ev, l),
  };
  readonly stderr = {
    on: (ev: "data", l: (c: Buffer | string) => void) => this.stderrEmitter.on(ev, l),
  };

  override on(
    event: "exit",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): this;
  override on(event: string, listener: (...args: unknown[]) => void): this {
    return super.on(event, listener);
  }

  kill(signal?: NodeJS.Signals): boolean {
    this.killed = signal ?? "SIGTERM";
    return true;
  }

  /** server → client に 1 行送る。 */
  emitLine(msg: Record<string, unknown>): void {
    this.stdoutEmitter.emit("data", JSON.stringify(msg) + "\n");
  }

  /** 子プロセスの OS exit を発火する (AGG-2: 真の終端源)。 */
  emitExit(code: number | null, signal: NodeJS.Signals | null = null): void {
    this.emit("exit", code, signal);
  }

  /**
   * thread/start Response を手動で遅延させるモード (ordering 回帰テスト用)。
   * true のとき thread/start には自動応答せず、テストが releaseThreadStart() で解放する。
   */
  deferThreadStart = false;
  private pendingThreadStartId: string | number | undefined;

  /** 保留中の thread/start に応答して canonical を確定させる。 */
  releaseThreadStart(): void {
    if (this.pendingThreadStartId === undefined) return;
    const id = this.pendingThreadStartId;
    this.pendingThreadStartId = undefined;
    this.emitLine({
      id,
      result: {
        thread: { id: THREAD_ID, sessionId: SESSION_ID, status: { type: "idle" } },
        model: "gpt-x",
        modelProvider: "openai",
      },
    });
  }

  /** client request に自動応答する (handshake)。 */
  private onClientMessage(msg: Record<string, unknown>): void {
    this.inbound.push(msg);
    const id = msg.id;
    const method = msg.method;
    if (method === "initialize") {
      this.emitLine({ id, result: { userAgent: "fake/0.137.0", codexHome: "/home/x/.codex" } });
    } else if (method === "thread/start") {
      if (this.deferThreadStart) {
        this.pendingThreadStartId = id as string | number; // テストが releaseThreadStart で解放。
        return;
      }
      this.emitLine({
        id,
        result: {
          thread: { id: THREAD_ID, sessionId: SESSION_ID, status: { type: "idle" } },
          model: "gpt-x",
          modelProvider: "openai",
        },
      });
    } else if (method === "turn/start") {
      this.emitLine({ id, result: { turn: { id: "turn_1", status: "inProgress", items: [] } } });
    }
    // initialized / turn/interrupt は notification (応答不要)。
  }
}

describe("startManagedCodex: SESSION-ID + REDACTION-TRANSPARENCY", () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    for (const c of cleanups.splice(0)) c();
  });

  function makeRig(configureChild?: (c: FakeCodexChild) => void) {
    const dir = mkdtempSync(join(tmpdir(), "codex-runner-"));
    const store = new EventStore(join(dir, "sidecar.db"));
    const wsClient = { notifyAppended: () => {} } as unknown as WsClient;
    const sink = new EventSink({ store, wsClient });
    const identity = new SessionIdentity({ fallbackSessionId: "sess_fallback", flushTimeoutMs: 0 });
    const approvalBridge = new ApprovalBridge({ timeoutMs: 1000 });
    const child = new FakeCodexChild();
    configureChild?.(child); // spawn 前に child を構成 (deferThreadStart 等)。
    const session = startManagedCodex({
      sink,
      approvalBridge,
      identity,
      heartbeatMs: 999_999, // heartbeat を実質止める (PID 監視ノイズを避ける)。
      spawnChild: () => child, // env/spawn 配線の pin は inv-codex-child-env.test.ts で検証。
    });
    cleanups.push(() => {
      session.dispose();
      store.close();
    });
    return { store, sink, identity, child, session };
  }

  /** handshake が完了し canonical が確定するまで待つ。 */
  async function waitHandshake(identity: SessionIdentity): Promise<void> {
    for (let i = 0; i < 50; i++) {
      if (identity.isResolved()) return;
      await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error("handshake did not resolve canonical");
  }

  it("canonical=thread.id and provider_session_id=thread.sessionId on all events", async () => {
    const rig = makeRig();
    await waitHandshake(rig.identity);
    expect(rig.identity.resolvedSessionId()).toBe(THREAD_ID);

    // 各種 notification を流す。
    rig.child.emitLine({
      method: "thread/started",
      params: { thread: { id: THREAD_ID, sessionId: SESSION_ID } },
    });
    rig.child.emitLine({
      method: "turn/started",
      params: { threadId: THREAD_ID, turn: { id: "turn_1" } },
    });
    rig.child.emitLine({
      method: "item/agentMessage/delta",
      params: { threadId: THREAD_ID, turnId: "turn_1", itemId: "i1", delta: "hi" },
    });
    // thread/closed (真の終端源の 1 つ) → session.ended。
    rig.child.emitLine({ method: "thread/closed", params: { threadId: THREAD_ID } });

    await new Promise((r) => setTimeout(r, 20));

    const rows = rig.store.allRows();
    expect(rows.length).toBeGreaterThanOrEqual(3);
    for (const row of rows) {
      const ev = JSON.parse(row.event_json) as {
        session_id: string;
        provider_session_id?: string;
        provider: string;
        source: string;
      };
      expect(ev.session_id).toBe(THREAD_ID); // canonical = thread.id
      expect(ev.provider_session_id).toBe(SESSION_ID); // = thread.sessionId
      expect(ev.provider).toBe("codex");
      expect(ev.source).toBe("app_server");
      expect(row.session_id).toBe(THREAD_ID); // SQLite の session_id 列も canonical
    }
    const ended = rows.find((r) => r.event_type === "session.ended");
    expect(ended).toBeDefined();
  });

  it("ORDERING: notification before canonical-learn is persisted with canonical (not fallback)", async () => {
    // 回帰固定: thread/started が thread/start Response より **先着** する競合 (実機の並列負荷で
    // 観測) を再現する。早期 notification を build 時の fallback session_id で hold すると
    // canonical 確定後も fallback のまま flush され session が割れる。emitMonitoring の thunk 内で
    // canonical を反映して正規化することを固定する。
    const rig = makeRig((c) => {
      c.deferThreadStart = true; // thread/start に即応答せず canonical 未確定状態を作る。
    });
    // handshake の initialize は通るが thread/start は保留 → canonical 未確定。
    await new Promise((r) => setTimeout(r, 20));
    expect(rig.identity.isResolved()).toBe(false);

    // canonical 未確定のまま notification が先着する。
    rig.child.emitLine({
      method: "thread/started",
      params: { thread: { id: THREAD_ID, sessionId: SESSION_ID } },
    });
    rig.child.emitLine({
      method: "item/agentMessage/delta",
      params: { threadId: THREAD_ID, turnId: "turn_1", itemId: "i1", delta: "early" },
    });
    await new Promise((r) => setTimeout(r, 20));
    // まだ hold されているので persist されていない (fallback で出ていない)。
    expect(rig.store.allRows().length).toBe(0);

    // canonical を確定 (thread/start Response 解放)。held が canonical で flush される。
    rig.child.releaseThreadStart();
    await new Promise((r) => setTimeout(r, 20));

    const rows = rig.store.allRows();
    expect(rows.length).toBeGreaterThanOrEqual(2);
    for (const row of rows) {
      expect(row.session_id).toBe(THREAD_ID); // fallback (sess_fallback) は 1 件も無い。
      const ev = JSON.parse(row.event_json) as { session_id: string };
      expect(ev.session_id).toBe(THREAD_ID);
    }
    // fallback session_id を持つ行が存在しないことを明示。
    expect(rows.some((r) => r.session_id === "sess_fallback")).toBe(false);
  });

  it("AGG-1: process/exited is dropped (no session.ended emitted)", async () => {
    const rig = makeRig();
    await waitHandshake(rig.identity);
    rig.child.emitLine({
      method: "process/exited",
      params: {
        exitCode: 0,
        processHandle: "p1",
        stdout: "",
        stderr: "",
        stdoutCapReached: false,
        stderrCapReached: false,
      },
    });
    await new Promise((r) => setTimeout(r, 20));
    // process/exited は normalize で drop → session.ended は出ない。
    const ended = rig.store.allRows().filter((r) => r.event_type === "session.ended");
    expect(ended.length).toBe(0);
  });

  it("AGG-2: child OS exit emits session.ended once (state by exit code)", async () => {
    const rig = makeRig();
    await waitHandshake(rig.identity);
    // codex は SIGTERM 時 thread/closed も process/exited も出さない → child exit が唯一の終端源。
    rig.child.emitExit(0, null);
    await new Promise((r) => setTimeout(r, 20));
    const ended = rig.store.allRows().filter((r) => r.event_type === "session.ended");
    expect(ended.length).toBe(1);
    const ev = JSON.parse(ended[0]!.event_json) as { state?: string; session_id: string };
    expect(ev.state).toBe("completed"); // code 0 + no signal → completed
    expect(ev.session_id).toBe(THREAD_ID);
  });

  it("AGG-2: non-zero / signal child exit → session.ended failed", async () => {
    const rig = makeRig();
    await waitHandshake(rig.identity);
    rig.child.emitExit(null, "SIGKILL");
    await new Promise((r) => setTimeout(r, 20));
    const ended = rig.store.allRows().filter((r) => r.event_type === "session.ended");
    expect(ended.length).toBe(1);
    const ev = JSON.parse(ended[0]!.event_json) as { state?: string };
    expect(ev.state).toBe("failed");
  });

  it("AGG-2: thread/closed before child exit → session.ended emitted once (idempotent)", async () => {
    const rig = makeRig();
    await waitHandshake(rig.identity);
    // thread/closed 先着 → session.ended (completed)。
    rig.child.emitLine({ method: "thread/closed", params: { threadId: THREAD_ID } });
    await new Promise((r) => setTimeout(r, 10));
    // その後 child exit が来ても二重に出さない (sessionEnded ガード)。
    rig.child.emitExit(0, null);
    await new Promise((r) => setTimeout(r, 20));
    const ended = rig.store.allRows().filter((r) => r.event_type === "session.ended");
    expect(ended.length).toBe(1);
  });

  it("REDACTION-TRANSPARENCY: secret in diff/command payload is masked in SQLite (no raw leak)", async () => {
    const rig = makeRig();
    await waitHandshake(rig.identity);

    const secretToken = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    const awsKey = "AKIAIOSFODNN7EXAMPLE";
    // diff に GitHub token、command 出力に AWS key を仕込む。
    rig.child.emitLine({
      method: "turn/diff/updated",
      params: {
        threadId: THREAD_ID,
        turnId: "turn_1",
        diff: `--- a/.env\n+GITHUB_TOKEN=${secretToken}\n`,
      },
    });
    rig.child.emitLine({
      method: "item/commandExecution/outputDelta",
      params: {
        threadId: THREAD_ID,
        turnId: "turn_1",
        itemId: "c1",
        delta: `export AWS_ACCESS_KEY_ID=${awsKey}`,
      },
    });

    await new Promise((r) => setTimeout(r, 20));

    const allJson = rig.store
      .allRows()
      .map((r) => r.event_json)
      .join("\n");
    // raw secret は SQLite に残っていない。
    expect(allJson).not.toContain(secretToken);
    expect(allJson).not.toContain(awsKey);
    // [REDACTED:*] マーカーが出ている。
    expect(allJson).toMatch(/\[REDACTED:/);
  });

  it("interrupt sends turn/interrupt with threadId+turnId", async () => {
    const rig = makeRig();
    await waitHandshake(rig.identity);
    // turn を開始しておく (currentTurnId をセット)。
    rig.child.emitLine({
      method: "turn/started",
      params: { threadId: THREAD_ID, turn: { id: "turn_99" } },
    });
    await new Promise((r) => setTimeout(r, 10));
    rig.session.interrupt();
    const interrupt = rig.child.inbound.find((m) => m.method === "turn/interrupt");
    expect(interrupt).toBeDefined();
    expect((interrupt!.params as { threadId: string }).threadId).toBe(THREAD_ID);
    expect((interrupt!.params as { turnId: string }).turnId).toBe("turn_99");
  });

  it("stop kills the child (PID-limited)", async () => {
    const rig = makeRig();
    await waitHandshake(rig.identity);
    rig.session.stop("SIGTERM");
    expect(rig.child.killed).toBe("SIGTERM");
  });
});
