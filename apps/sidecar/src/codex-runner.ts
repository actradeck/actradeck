/**
 * Managed runner (`agentmon codex`) — codex app-server を子プロセス起動する (ADR 019ea31b (a)).
 *
 * 責務 (plan.md §10 / §11 Managed Mode, Codex App Server):
 * - `codex app-server` を **raw stdio pipe** の子プロセスとして起動 (node-pty 不要: JSON-RPC は
 *   端末対話でなく構造化フレーム)。stdin/stdout = JSON-RPC frame、stderr = ログ/診断。
 * - framing = line-delimited JSON (CodexJsonRpc)。
 * - handshake 固定順: initialize → initialized → thread/start → turn/start。
 *   thread/start Response が同期で {thread:{id,sessionId}} を返すので canonical=thread.id を
 *   **即確定** (hold-then-flush 不要・ADR (e))。
 * - notification → normalize-codex → sink.emit (redaction choke を通る)。
 * - 承認 ServerRequest → CodexApprovalBridge (UI 承認 ↔ JSON-RPC Response)。
 * - 子 PID 生存監視 heartbeat (process-monitor) で liveness の process_alive シグナル供給。
 * - shutdown: graceful flush (既存 sink/store) → 子 SIGTERM → timeout で SIGKILL。**対象 PID 限定**。
 *
 * session 終端規律 (AGG-1/AGG-2): session.ended は **thread/closed または child OS exit** の
 *   **先着 1 回** (idempotent)。process/exited は `process/spawn` ライフサイクル通知のため写像せず
 *   (normalize で drop)、終端源にしない。実 codex は SIGTERM 時に thread/closed も process/exited も
 *   emit しないため、child OS exit を確実な終端源として結線する。
 */
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";

import type { ApprovalBridge } from "./approval-bridge.js";
import {
  CodexApprovalBridge,
  type CodexApprovalCard,
  isCodexApprovalRequest,
} from "./approval-bridge-codex.js";
import { buildChildEnv } from "./child-env.js";
import { CodexJsonRpc, type CodexInboundMessage, type CodexRequestId } from "./codex-jsonrpc.js";
import { buildEvent } from "./event-factory.js";
import { escalateKill } from "./kill-escalation.js";
import { normalizeCodexNotification, type CodexNormalizeContext } from "./normalize-codex.js";
import { ProcessMonitor, type ProcessSample } from "./process-monitor.js";
import type { SessionIdentity } from "./session-identity.js";
import type { EventSink } from "./sink.js";

export interface CodexRunnerOptions {
  readonly sink: EventSink;
  /** 承認ブリッジ (無改変再利用)。UI 4 値 decision ↔ codex Response。 */
  readonly approvalBridge: ApprovalBridge;
  /**
   * session 識別の権威 (ADR 019e9462 / 019ea31b (e))。codex は thread/start Response で
   * thread.id を得て `learn(thread.id)` で確定する。**実機の並列負荷では thread/started 等の
   * notification が thread/start Response より先着しうる** ため、確定前の notification は
   * emitMonitoring が hold し、確定後に canonical で正規化して flush する (fallback 割れ防止)。
   */
  readonly identity: SessionIdentity;
  /** codex 実行パス (既定: PATH 上の "codex")。 */
  readonly codexBin?: string;
  readonly cwd?: string;
  /** heartbeat 間隔 (ms)。 */
  readonly heartbeatMs?: number;
  /** turn/start で送る初期入力テキスト (任意)。未指定なら turn/start を送らない。 */
  readonly initialPrompt?: string;
  /** SIGTERM 後 SIGKILL までの猶予 (ms)。既定 5s。 */
  readonly killGraceMs?: number;
  /** clientInfo.name / version (initialize)。既定 actradeck-sidecar。 */
  readonly clientName?: string;
  readonly clientVersion?: string;
  /**
   * テスト注入用 spawn seam (QA carryover / TDA-5)。既定は `defaultSpawnChild` (実 codex を
   * `spawn(codexBin, ["app-server"], …)` 起動)。env は **ランナー側で buildChildEnv 構築**して
   * `opts.env` で渡すため、fake seam が受け取った `opts.env` を観測して spawn 配線を falsifiable に
   * pin できる (managed-runner の `spawnPty`/`PtySpawnOptions` の stdio 版 mirror)。zero-arg seam だと
   * env が既定枝の内部で構築され注入時にバイパスされ、配線が未 pin になっていた。
   */
  readonly spawnChild?: (
    file: string,
    args: readonly string[],
    opts: ChildSpawnOptions,
  ) => ChildLike;
  /** 診断フック (handshake 進捗・parse error・stderr 行)。 */
  readonly onDiagnostic?: (msg: string) => void;
}

/** spawnChild seam が受け取る spawn オプション (child_process spawn の本モジュール使用分)。 */
export interface ChildSpawnOptions {
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly stdio: readonly ["pipe", "pipe", "pipe"];
}

/** child_process の本モジュールが使う部分集合 (テストでフェイク注入可能)。 */
export interface ChildLike {
  readonly pid: number | undefined;
  readonly stdin: { write(chunk: string): unknown };
  readonly stdout: {
    on(event: "data", listener: (chunk: Buffer | string) => void): unknown;
    off?(event: "data", listener: (chunk: Buffer | string) => void): unknown;
  };
  readonly stderr: {
    on(event: "data", listener: (chunk: Buffer | string) => void): unknown;
  };
  on(
    event: "exit",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): unknown;
  kill(signal?: NodeJS.Signals): boolean;
}

export interface CodexManagedSession {
  readonly pid: number | undefined;
  /** プロセス終了の Promise (exit code、signal kill は 0 扱い)。 */
  readonly exited: Promise<number>;
  /** canonical session_id (= thread.id)。handshake 前は undefined。 */
  threadId(): string | undefined;
  /** provider_session_id (= thread.sessionId)。 */
  providerSessionId(): string | undefined;
  /** turn を中断する (turn/interrupt)。 */
  interrupt(): void;
  /** 対象 PID に限定して停止 (SIGTERM→猶予後 SIGKILL)。 */
  stop(signal?: NodeJS.Signals): void;
  /** collector / monitor / jsonrpc を停止し残バッファを flush。 */
  dispose(): void;
}

/** 既定 spawn seam: 実 child_process で codex app-server を起動する。テストは opts.spawnChild で差し替える。 */
function defaultSpawnChild(
  file: string,
  args: readonly string[],
  opts: ChildSpawnOptions,
): ChildLike {
  return spawn(file, [...args], {
    cwd: opts.cwd,
    env: opts.env,
    stdio: [...opts.stdio],
  }) as ChildProcessWithoutNullStreams as unknown as ChildLike;
}

/**
 * codex app-server を managed 子プロセスとして起動し、handshake → notification 正規化 →
 * 承認ブリッジ → heartbeat を配線する。
 */
export function startManagedCodex(opts: CodexRunnerOptions): CodexManagedSession {
  const codexBin = opts.codexBin ?? "codex";
  const cwd = opts.cwd ?? process.cwd();
  const killGraceMs = opts.killGraceMs ?? 5_000;
  const diag = (m: string): void => opts.onDiagnostic?.(m);

  // SEC-1: 全 env 継承をやめ allowlist 化する (INGEST_TOKEN / ACTRADECK_* を child へ漏らさない)。
  // codex は provider 認証を env でなく CODEX_HOME 設定ファイルで受けるため extra なし
  // (= 既存 buildChildEnv() と同値)。env はランナー側で構築し seam に渡す → fake seam が opts.env を
  // 観測して spawn 配線を pin できる (claude managed-runner の spawnPty と parity)。
  const childEnv = buildChildEnv();
  const spawnChild = opts.spawnChild ?? defaultSpawnChild;
  const child: ChildLike = spawnChild(codexBin, ["app-server"], {
    cwd,
    env: childEnv,
    stdio: ["pipe", "pipe", "pipe"],
  });

  // --- request/response 相関 (handshake + 任意 request)。 ---
  let nextId = 1;
  const pending = new Map<CodexRequestId, (msg: CodexInboundMessage) => void>();

  // --- session 状態。 ---
  let threadId: string | undefined;
  let providerSessionId: string | undefined;
  let currentTurnId: string | undefined;
  let sessionEnded = false; // session.ended の先着 1 回ガード (idempotent)。

  const rpc = new CodexJsonRpc({
    stdin: child.stdin,
    stdout: child.stdout,
    onMessage: (msg) => dispatch(msg),
    onParseError: (line, err) =>
      diag(
        `parse-error: ${err instanceof Error ? err.message : String(err)} line=${line.slice(0, 80)}`,
      ),
  });

  // 承認ブリッジ (UI カード emit + codex Response 送出)。
  const codexApproval = new CodexApprovalBridge({
    bridge: opts.approvalBridge,
    sessionId: () => opts.identity.currentSessionId(),
    emitCard: (card: CodexApprovalCard, requestId: string) => {
      // UI 承認カードを emit。request_id を payload に載せ UI が approve frame で突合できるように。
      // 全イベントは sink.emit の redactDeep を通る。
      emitCodex((sessionId, ts) =>
        buildEvent({
          session_id: sessionId,
          provider: "codex",
          source: "app_server",
          ...(providerSessionId !== undefined ? { provider_session_id: providerSessionId } : {}),
          ...(threadId !== undefined ? { thread_id: threadId } : {}),
          ...(currentTurnId !== undefined ? { turn_id: currentTurnId } : {}),
          event_type: "tool.permission.requested",
          state: "waiting.approval",
          timestamp: ts,
          summary: card.summary,
          payload: { kind: "tool.permission.requested", request_id: requestId, ...card.payload },
        }),
      );
    },
    sendResponse: (id: CodexRequestId, result: Record<string, unknown>) => {
      sendResponse(id, result);
    },
  });

  // --- 子 PID heartbeat (process-monitor)。 ---
  const monitor =
    child.pid !== undefined
      ? new ProcessMonitor({
          pid: child.pid,
          ...(opts.heartbeatMs !== undefined ? { intervalMs: opts.heartbeatMs } : {}),
          onSample: (sample: ProcessSample) => emitHeartbeat(sample),
        })
      : undefined;
  monitor?.start();

  // stderr はログ/診断。観測イベントにはしないが診断フックへ流す (redaction 対象外: sink を通さない)。
  child.stderr.on("data", (chunk) => {
    const s = typeof chunk === "string" ? chunk : chunk.toString("utf8");
    diag(`stderr: ${s.trimEnd().slice(0, 200)}`);
  });

  // --- exit。 ---
  let resolveExit: (code: number) => void = () => {};
  const exited = new Promise<number>((resolve) => {
    resolveExit = resolve;
  });
  let teardownDone = false;
  let killTimer: NodeJS.Timeout | undefined;

  child.on("exit", (code, signal) => {
    // AGG-2: child OS exit は **真の終端源**。実 codex は SIGTERM 時 thread/closed も
    // process/exited も emit しないため、ここで session.ended を結線しないと crash/SIGKILL で
    // UI が終端を観測できない。sessionEnded ガードで idempotent (thread/closed 先着時は二重に
    // 出さない)。state は exit code/signal で completed/failed を判定する。
    // 注 (SEC 確認済): ここで approvalBridge.drain() は呼ばない。pending 承認は安全側
    //   timeout / shutdown-deny で解決させる (drain を足すと早期消去になる)。
    emitSessionEndedOnce(code, signal);
    teardown();
    resolveExit(code ?? 0);
  });

  // ============ helpers ============

  /**
   * emit ヘルパ: canonical 確定済みなら即 emit、未確定なら hold (SessionIdentity)。
   * build は (canonicalSessionId, timestamp) を受けて NormalizedEvent を返す。
   * 観測時刻 (ts) を **今** 固定し、hold されても発生時刻が timestamp に乗る。
   */
  function emitCodex(
    build: (sessionId: string, ts: string) => ReturnType<typeof buildEvent>,
    category: "heartbeat" | "diff" | "output" = "output",
  ): void {
    const ts = new Date().toISOString();
    opts.identity.emitMonitoring(category, (sessionId) => {
      opts.sink.emit(build(sessionId, ts));
    });
  }

  function emitHeartbeat(sample: ProcessSample): void {
    const ts = new Date().toISOString();
    opts.identity.emitMonitoring("heartbeat", (sessionId) => {
      opts.sink.emit(
        buildEvent({
          session_id: sessionId,
          provider: "codex",
          source: "app_server",
          ...(providerSessionId !== undefined ? { provider_session_id: providerSessionId } : {}),
          ...(threadId !== undefined ? { thread_id: threadId } : {}),
          event_type: "heartbeat",
          timestamp: ts,
          summary: sample.alive ? "プロセス稼働中" : "プロセス消滅",
          payload: { kind: "heartbeat", process_alive: sample.alive },
          metrics: {
            elapsed_ms: sample.elapsed_ms,
            cpu_pct: sample.cpu,
            memory_bytes: sample.memory,
          },
        }),
      );
    });
  }

  /**
   * AGG-2: child OS exit を session.ended として 1 回だけ emit する (idempotent)。
   * thread/closed が先着していれば sessionEnded=true で no-op。
   * state は exit code/signal で判定: code===0 かつ無シグナル → completed、それ以外 → failed
   *   (非ゼロ終了 / シグナル kill は異常終端)。SIGTERM/SIGKILL は graceful shutdown でも
   *   起こりうるが、UI に「終わった」事実を必ず見せるため終端を出す (停止断定の単一シグナル化
   *   ではなく、プロセス消滅という確定事実の通知)。
   */
  function emitSessionEndedOnce(code: number | null, signal: NodeJS.Signals | null): void {
    if (sessionEnded) return;
    sessionEnded = true;
    const clean = code === 0 && signal === null;
    const ts = new Date().toISOString();
    opts.identity.emitMonitoring("output", (sessionId) => {
      opts.sink.emit(
        buildEvent({
          session_id: sessionId,
          provider: "codex",
          source: "app_server",
          ...(providerSessionId !== undefined ? { provider_session_id: providerSessionId } : {}),
          ...(threadId !== undefined ? { thread_id: threadId } : {}),
          event_type: "session.ended",
          state: clean ? "completed" : "failed",
          timestamp: ts,
          summary: clean
            ? "Codex プロセス終了"
            : `Codex プロセス終了 (${signal !== null ? `signal=${signal}` : `code=${code ?? "?"}`})`,
          payload: {
            kind: "session.ended",
            reason: clean
              ? "exit_0"
              : signal !== null
                ? `signal_${signal}`
                : `exit_${code ?? "unknown"}`,
          },
        }),
      );
    });
  }

  /** JSON-RPC request を送り response を待つ。 */
  function request(method: string, params: Record<string, unknown>): Promise<CodexInboundMessage> {
    const id = nextId++;
    return new Promise<CodexInboundMessage>((resolve, reject) => {
      pending.set(id, (msg) => {
        if (msg.error !== undefined) {
          reject(new Error(`${method} failed: ${msg.error.message ?? "unknown"}`));
        } else {
          resolve(msg);
        }
      });
      rpc.send({ id, method, params });
    });
  }

  /** JSON-RPC notification を送る (response 不要)。 */
  function notify(method: string, params?: Record<string, unknown>): void {
    rpc.send(params !== undefined ? { method, params } : { method });
  }

  /** server request への Response (result) を送る。 */
  function sendResponse(id: CodexRequestId, result: Record<string, unknown>): void {
    rpc.send({ id, result });
  }

  /** 受信 message を振り分ける。 */
  function dispatch(msg: CodexInboundMessage): void {
    // (1) response: id があり method が無い → pending を解決。
    if (msg.id !== undefined && msg.method === undefined) {
      const resolver = pending.get(msg.id);
      if (resolver === undefined) {
        // foreign / 未知 id の Response は無視 (INV-CODEX-REQID)。
        diag(`unknown response id=${String(msg.id)}`);
        return;
      }
      pending.delete(msg.id);
      resolver(msg);
      return;
    }
    // (2) server request: id があり method がある → 承認なら CodexApprovalBridge、他は無視 (MVP)。
    if (msg.id !== undefined && typeof msg.method === "string") {
      if (isCodexApprovalRequest(msg.method)) {
        codexApproval.handleServerRequest(msg.id, msg.method, msg.params);
        return;
      }
      // MVP 除外の server request (elicitation / tool requestUserInput 等)。安全側で何もしない。
      diag(`unhandled server request method=${msg.method} id=${String(msg.id)}`);
      return;
    }
    // (3) notification: method のみ → normalize-codex → sink.emit。
    if (typeof msg.method === "string") {
      handleNotification(msg.method, msg.params);
      return;
    }
    diag("malformed message (no id/method)");
  }

  function handleNotification(method: string, params: unknown): void {
    // turn_id を追跡 (承認カード / turn/interrupt に turn_id を載せるため)。
    // flat `turnId` (delta/plan/diff) か turn オブジェクト `turn.id` (turn/started・completed)。
    const p =
      params !== null && typeof params === "object" ? (params as Record<string, unknown>) : {};
    const flatTurnId = typeof p.turnId === "string" ? p.turnId : undefined;
    const turnObj =
      p.turn !== null && typeof p.turn === "object"
        ? (p.turn as Record<string, unknown>)
        : undefined;
    const objTurnId =
      turnObj !== undefined && typeof turnObj.id === "string" ? turnObj.id : undefined;
    const tId = flatTurnId ?? objTurnId;
    if (tId !== undefined) currentTurnId = tId;

    // session.ended の先着 1 回ガード (thread/closed と child OS exit の重複を抑止)。
    // process/exited は normalize で drop されるためここで除外を見る必要はない (AGG-1)。
    if (method === "thread/closed" && sessionEnded) {
      return;
    }

    // 観測時刻を **今** 固定 (hold されても発生時刻が timestamp に乗る・INV-EVENT-ORDER)。
    const observedAt = new Date().toISOString();

    // 早期確認: 未知 / 除外 method なら drop (hold もしない)。normalize は副作用が無いので
    // ここで一度回して空判定する (drop 判定に sessionId は影響しない)。
    const probeCtx: CodexNormalizeContext = {
      sessionId: opts.identity.currentSessionId(),
      ...(providerSessionId !== undefined ? { providerSessionId } : {}),
      timestamp: observedAt,
    };
    let probe: ReturnType<typeof buildEvent>[];
    try {
      probe = normalizeCodexNotification({ method, params: params ?? {} }, probeCtx);
    } catch (err) {
      diag(`normalize error method=${method}: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    if (probe.length === 0) return; // 未知 / 除外 method は drop。

    if (method === "thread/closed") sessionEnded = true;

    // diff / output は category を分けて hold 有界化の優先度に乗せる。
    const category: "heartbeat" | "diff" | "output" =
      method === "turn/diff/updated"
        ? "diff"
        : method === "thread/tokenUsage/updated" || method.endsWith("status/changed")
          ? "heartbeat"
          : "output";

    // **canonical を flush 時に反映する** (LIVE-found ordering fix):
    //   未確定時に build した event を hold すると fallback session_id を載せたまま flush され、
    //   早期 notification (thread/started 等が thread/start Response より先着) が fallback
    //   session に割れる。よって event を **emitMonitoring の thunk 内で正規化**し、identity が
    //   渡す canonicalSessionId で session_id を確定させる (確定済みなら即, 未確定なら hold→canonical)。
    opts.identity.emitMonitoring(category, (canonicalSessionId) => {
      const ctx: CodexNormalizeContext = {
        sessionId: canonicalSessionId,
        ...(providerSessionId !== undefined ? { providerSessionId } : {}),
        timestamp: observedAt,
      };
      let events: ReturnType<typeof buildEvent>[];
      try {
        events = normalizeCodexNotification({ method, params: params ?? {} }, ctx);
      } catch (err) {
        diag(
          `normalize error method=${method}: ${err instanceof Error ? err.message : String(err)}`,
        );
        return;
      }
      for (const ev of events) opts.sink.emit(ev);
    });
  }

  function teardown(): void {
    if (teardownDone) return;
    teardownDone = true;
    if (killTimer) clearTimeout(killTimer);
    monitor?.stop();
    rpc.dispose();
  }

  // ============ handshake ============
  async function handshake(): Promise<void> {
    // (1) initialize (request)。clientInfo 必須 (schema 確認済)。
    await request("initialize", {
      clientInfo: {
        name: opts.clientName ?? "actradeck-sidecar",
        version: opts.clientVersion ?? "0.1.0",
      },
    });
    diag("initialize ok");

    // (2) initialized (notification)。
    notify("initialized");

    // (3) thread/start (request)。Response.thread.{id,sessionId} で canonical 即確定。
    const startRes = await request("thread/start", {
      ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
    });
    const result = (startRes.result ?? {}) as Record<string, unknown>;
    const thread = (result.thread ?? {}) as Record<string, unknown>;
    const tid = typeof thread.id === "string" ? thread.id : undefined;
    const sid = typeof thread.sessionId === "string" ? thread.sessionId : undefined;
    if (tid === undefined) throw new Error("thread/start: missing thread.id");
    threadId = tid;
    providerSessionId = sid;
    // ADR (e): canonical=thread.id を即確定 (learn-once)。これ以降の hold は flush される。
    opts.identity.learn(tid);
    diag(`thread/start ok thread.id=${tid}`);

    // (4) turn/start (request)。initialPrompt があるときのみ。
    if (opts.initialPrompt !== undefined && opts.initialPrompt.length > 0) {
      const turnRes = await request("turn/start", {
        threadId: tid,
        input: [{ type: "text", text: opts.initialPrompt }],
      });
      const turn = ((turnRes.result ?? {}) as Record<string, unknown>).turn as
        | Record<string, unknown>
        | undefined;
      if (turn !== undefined && typeof turn.id === "string") currentTurnId = turn.id;
      diag(`turn/start ok turn.id=${currentTurnId ?? "?"}`);
    }
  }

  // handshake を起動 (失敗時は診断のみ; 子の exit が exited を解決する)。
  void handshake().catch((err: unknown) => {
    diag(`handshake error: ${err instanceof Error ? err.message : String(err)}`);
  });

  return {
    pid: child.pid,
    exited,
    threadId: () => threadId,
    providerSessionId: () => providerSessionId,
    interrupt: () => {
      if (threadId !== undefined && currentTurnId !== undefined) {
        notify("turn/interrupt", { threadId, turnId: currentTurnId });
      }
    },
    stop: (signal: NodeJS.Signals = "SIGTERM") => {
      // 強み(a): signal → killGraceMs → SIGKILL の段階的停止 (PID 限定)。managed-runner と
      // 共有 helper (escalateKill) に集約 (TDA: 重複ロジックを単一 choke へ)。再 stop 時は前回
      // timer を解除してから再武装する。child exit 時は teardown が clear する (冪等)。
      if (killTimer) clearTimeout(killTimer);
      killTimer = escalateKill(child, { signal, graceMs: killGraceMs });
    },
    dispose: () => teardown(),
  };
}
