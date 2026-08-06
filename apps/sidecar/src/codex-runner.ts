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

import type { ApprovalDecision, DeliveryStatus, ResolutionOrigin } from "@actradeck/event-model";

import type { ApprovalBridge } from "./approval-bridge.js";
import { resolutionOriginSuffix } from "./approval-bridge.js";
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
   * R1 (ADR 019f2421): JSON-RPC request の有界 timeout (ms)。app-server ハングで handshake が
   * 永久待ちにならないよう seam 化する。未指定なら env `ACTRADECK_CODEX_RPC_TIMEOUT_MS`、それも
   * 無ければ既定 25s。handshake の Response は prompt ACK (turn/start は inProgress を即返す) ゆえ、
   * 生成的 timeout は「真に無応答な server」のみを捕捉する。
   */
  readonly rpcTimeoutMs?: number;
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

/**
 * R1 (ADR 019f2421): JSON-RPC request が有界 timeout に達したときの typed error。
 * handshake().catch がこの型で「無応答 server」を識別し session.ended(failed, handshake_timeout)
 * を emit する (通常の method error と区別する)。
 */
export class CodexRpcTimeoutError extends Error {
  constructor(
    readonly method: string,
    readonly timeoutMs: number,
  ) {
    super(`codex rpc timeout: ${method} did not respond within ${timeoutMs}ms`);
    this.name = "CodexRpcTimeoutError";
  }
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
 * R2 (ADR 019f2421): エラー由来の **非 raw** な短い識別子を返す (NO-RAW: errno code / message 冒頭のみ)。
 * 生の write payload / command / secret は含めない (errno は "EPIPE" 等の OS レベル定数)。
 */
function errCode(err: unknown): string {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  if (typeof code === "string" && code.length > 0) return code;
  if (err instanceof Error) return err.message.slice(0, 60);
  return "unknown";
}

/**
 * R2 (ADR 019f2421): stream に "error"/"end"/"close" listener を **防御的に** 付ける。
 * fake seam (テスト) の stream が `on` を持たない場合は no-op (ChildLike 契約を広げず後方互換)。
 * これらの listener が無いと EPIPE が uncaughtException → daemon 全体 fatal になる (cli.ts:472)。
 */
function attachStreamEvent(
  stream: unknown,
  event: "error" | "end" | "close",
  listener: (err?: Error) => void,
): void {
  const s = stream as { on?: (ev: string, l: (err?: Error) => void) => unknown } | undefined;
  if (s !== undefined && typeof s.on === "function") {
    s.on(event, listener);
  }
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

  // R1: request timeout の解決 (seam → env → 既定 25s)。0/負値は既定へ (無効化を許さない: 無界待ち防止)。
  const envTimeout = Number(process.env.ACTRADECK_CODEX_RPC_TIMEOUT_MS);
  const rpcTimeoutMs =
    opts.rpcTimeoutMs !== undefined && opts.rpcTimeoutMs > 0
      ? opts.rpcTimeoutMs
      : Number.isFinite(envTimeout) && envTimeout > 0
        ? envTimeout
        : 25_000;

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
  // R1: pending は response 解決 (onMessage) と timeout/teardown 時の reject を分けて保持し、
  //   タイマーを併せて掃除できるようにする (closure leak / 無界待ちを解消)。
  interface PendingRpc {
    readonly onMessage: (msg: CodexInboundMessage) => void;
    readonly onReject: (err: Error) => void;
    timer: NodeJS.Timeout | undefined;
  }
  const pending = new Map<CodexRequestId, PendingRpc>();

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
    // R2: 死 stream への同期 write throw を局所観測する (daemon 全体 fatal を防ぐ)。errno のみ (NO-RAW)。
    onWriteError: (err) => {
      diag(`write-error: ${errCode(err)}`);
      handleConnectionLoss("stdin_write_error");
    },
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
    emitResolved: (
      requestId: string,
      decision: ApprovalDecision | "deny",
      origin: ResolutionOrigin | undefined,
      delivery: DeliveryStatus,
    ) => {
      // TDA-1 (ADR 019f2476): 承認解決を tool.permission.resolved として対称 emit
      //   (claude=hook-receiver.ts と同一契約)。①Approval Inbox カードの clear
      //   (projection foldPendingApprovals は provider 非依存で request_id 一致除去)
      //   ②決定の監査証跡。emitCard と同じ codex event metadata を通し
      //   provider=codex / source=app_server / thread_id / turn_id を担保する。
      //   NO-RAW: payload は kind/request_id/enum のみ・raw command/cwd を再掲しない。
      //   全イベントは sink.emit の redactDeep choke を通る。
      //   ADR 0014 Phase 4 (decision 019fd705): resolution_origin / delivery_status を CC 経路と
      //   同一契約で載せる (closed enum のみ・「送った」と偽らない)。
      const allowed = decision === "allow" || decision === "allow_for_session";
      emitCodex((sessionId, ts) =>
        buildEvent({
          session_id: sessionId,
          provider: "codex",
          source: "app_server",
          ...(providerSessionId !== undefined ? { provider_session_id: providerSessionId } : {}),
          ...(threadId !== undefined ? { thread_id: threadId } : {}),
          ...(currentTurnId !== undefined ? { turn_id: currentTurnId } : {}),
          event_type: "tool.permission.resolved",
          state: allowed ? "running.tool_preparing" : "running.model_wait",
          timestamp: ts,
          summary: `承認 ${allowed ? "許可" : "拒否"}${resolutionOriginSuffix(origin)}`,
          payload: {
            kind: "tool.permission.resolved",
            request_id: requestId,
            decision,
            ...(origin !== undefined ? { resolution_origin: origin } : {}),
            delivery_status: delivery,
          },
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

  // R2 (ADR 019f2421): stdin/stdout に "error" listener が無いと、死 pipe への write-after-death
  //   (EPIPE) が CLI の uncaughtException → process.exit(1) = **他 session を監督する daemon 全体を
  //   落とす**。shutdown-race close-backstop (decision 019ef10b) と同型の crash-safety backstop として、
  //   1 codex session の死 pipe を局所封じ込めする (source で contain)。
  //   stdout "end"/"close" は接続喪失として扱い、lingering process の half-closed channel が zombie を
  //   残さないよう終端させる (emitSessionEndedFailure は先着ガードで idempotent)。
  attachStreamEvent(child.stdin, "error", (err) => {
    diag(`stdin-error: ${errCode(err)}`);
    handleConnectionLoss("stdin_error");
  });
  attachStreamEvent(child.stdout, "error", (err) => {
    diag(`stdout-error: ${errCode(err)}`);
    handleConnectionLoss("stdout_error");
  });
  // stdout "end"/"close" は正常終了でも発火する。ここで直接 failed を emit すると clean exit を
  //   false-failed 化しうる (close が exit に先行する稀ケース)。よって lingering process を stopChild で
  //   確実に終端し、authoritative な state (completed/failed) は child "exit" 経路に委ねる (zombie 回避)。
  attachStreamEvent(child.stdout, "end", () => handleStreamClosed("stdout_end"));
  attachStreamEvent(child.stdout, "close", () => handleStreamClosed("stdout_close"));

  // --- exit。 ---
  let resolveExit: (code: number) => void = () => {};
  const exited = new Promise<number>((resolve) => {
    resolveExit = resolve;
  });
  let teardownDone = false;
  let killTimer: NodeJS.Timeout | undefined;
  // R5 (ADR 019f2421): operator が stop() を呼んだ (graceful)。crash と区別して session.ended を
  //   正直に報告するためのフラグ (SIGTERM/SIGKILL でも operator 起点なら completed/stopped)。
  let operatorStopRequested = false;

  child.on("exit", (code, signal) => {
    // AGG-2: child OS exit は **真の終端源**。実 codex は SIGTERM 時 thread/closed も
    // process/exited も emit しないため、ここで session.ended を結線しないと crash/SIGKILL で
    // UI が終端を観測できない。sessionEnded ガードで idempotent (thread/closed 先着時は二重に
    // 出さない)。state は exit code/signal (+ R5 operator-stop) で completed/failed を判定する。
    emitSessionEndedOnce(code, signal);
    // R4 (ADR 019f2421): child 消失時、in-flight codex 承認を **死 pipe へ write せず** 安全側 deny へ
    //   即解決する (30s ApprovalBridge timeout 宙吊り + 死 pipe sendResponse=R2 crash 誘発 を除去)。
    //   emitSessionEndedOnce の後・teardown の前に呼ぶ (bridge.resolve は同期・finish は suppress される)。
    codexApproval.cancelInFlight();
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
    const cleanExit = code === 0 && signal === null;
    // R5 (ADR 019f2421): operator が stop() で終了させた (SIGTERM/SIGKILL) 場合は crash でなく
    //   graceful stop。既存の state enum (completed/failed) と reason 文字列のみで表現し、schema/
    //   state 契約は変えない (completed + reason="stopped")。operatorStop でない signal は従来どおり failed。
    const operatorStop = operatorStopRequested && !cleanExit;
    const completed = cleanExit || operatorStop;
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
          state: completed ? "completed" : "failed",
          // ADR 0014 Phase 3b-2 (D7): child OS exit は確定的なプロセス消滅 = 再開不能。
          //   end_kind は emit 済み state と整合 (completed↔completed / failed↔failed)、
          //   recoverability は両分岐とも "not_resumable" を明示する。terminalContinuation("failed")
          //   は "unknown" だが、ここはプロセス消滅という process_exit 証跡があるため generic な
          //   normalizer failed より強く not_resumable と断定できる (thread/delete と同性質)。
          end_kind: completed ? "completed" : "failed",
          recoverability: "not_resumable",
          timestamp: ts,
          summary: cleanExit
            ? "Codex プロセス終了"
            : operatorStop
              ? "Codex プロセス停止 (operator)"
              : `Codex プロセス終了 (${signal !== null ? `signal=${signal}` : `code=${code ?? "?"}`})`,
          payload: {
            kind: "session.ended",
            reason: cleanExit
              ? "exit_0"
              : operatorStop
                ? "stopped"
                : signal !== null
                  ? `signal_${signal}`
                  : `exit_${code ?? "unknown"}`,
          },
        }),
      );
    });
  }

  /**
   * R1/R2 (ADR 019f2421): handshake timeout / 接続喪失 (stream error/end/close) を **観測可能な**
   * session.ended(failed, reason=<enum>) として 1 回だけ emit する (sessionEnded 先着ガードで idempotent)。
   * reason は固定リテラル (handshake_timeout / handshake_failed / stdin_error / stdout_end 等) の非 raw enum。
   * canonical 未確定でも operator が失敗を観測できるよう、呼び元が identity.flushWithFallback() を続けて呼ぶ。
   */
  function emitSessionEndedFailure(reason: string): void {
    if (sessionEnded) return;
    sessionEnded = true;
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
          state: "failed",
          // ADR 0014 Phase 3c precedence (decision 019fd250): managed の end_kind を uniform 化。
          //   この経路は handleConnectionLoss が stopChild で子を終端しており「プロセス消滅 +
          //   thread 未確立/接続喪失」= 再開対象が無い。child-exit 経路 (emitSessionEndedOnce)
          //   と同じく end_kind=state 整合 / recoverability は process_exit 同性質の証跡として
          //   not_resumable を明示する (NULL のままだと同じ managed failed でも経路により
          //   continuation 表示が揺れる非一様を解消)。
          end_kind: "failed",
          recoverability: "not_resumable",
          timestamp: ts,
          summary: `Codex 接続失敗 (${reason})`,
          payload: { kind: "session.ended", reason },
        }),
      );
    });
  }

  /**
   * R2 (ADR 019f2421): 接続喪失 (stream error / stdout end/close / write-after-death) を局所処理する。
   * lingering process を停止し (zombie 回避)、失敗を観測可能化してから teardown する。teardownDone なら no-op
   * (二重処理防止)。emitSessionEndedFailure は先着ガードゆえ、exit が先行していれば正確な state を保つ。
   */
  function handleConnectionLoss(reason: string): void {
    if (teardownDone) return;
    stopChild("SIGTERM"); // lingering process を確実に終端 (kill 済/死亡済なら no-op)。
    emitSessionEndedFailure(reason);
    opts.identity.flushWithFallback(); // canonical 未確定でも held を fallback で flush (観測喪失を防ぐ)。
    teardown();
  }

  /**
   * R2 (ADR 019f2421): stdout の "end"/"close" (readable 側の終端)。正常終了でも発火するため、
   * ここでは state を直接確定せず、lingering process を stopChild で終端して authoritative な
   * session.ended を child "exit" 経路に委ねる (clean exit の false-failed 化を避けつつ zombie を回避)。
   * exit が既に処理済 (teardownDone) / 終端済 (sessionEnded) なら no-op。
   */
  function handleStreamClosed(reason: string): void {
    if (teardownDone || sessionEnded) return;
    diag(`stream-closed: ${reason}`);
    stopChild("SIGTERM");
  }

  /**
   * JSON-RPC request を送り response を待つ。
   * R1 (ADR 019f2421): 有界 timeout を張り、app-server 無応答で永久待ちにならないようにする。
   * timeout / teardown で pending を typed error / abort error で reject し closure leak を残さない。
   */
  function request(method: string, params: Record<string, unknown>): Promise<CodexInboundMessage> {
    const id = nextId++;
    return new Promise<CodexInboundMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!pending.has(id)) return;
        pending.delete(id);
        reject(new CodexRpcTimeoutError(method, rpcTimeoutMs));
      }, rpcTimeoutMs);
      timer.unref?.(); // request timer が daemon の event loop 終了を妨げないように。
      pending.set(id, {
        onMessage: (msg) => {
          if (msg.error !== undefined) {
            reject(new Error(`${method} failed: ${msg.error.message ?? "unknown"}`));
          } else {
            resolve(msg);
          }
        },
        onReject: reject,
        timer,
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
      const entry = pending.get(msg.id);
      if (entry === undefined) {
        // foreign / 未知 id の Response は無視 (INV-CODEX-REQID)。
        diag(`unknown response id=${String(msg.id)}`);
        return;
      }
      pending.delete(msg.id);
      if (entry.timer) clearTimeout(entry.timer); // R1: response 到着で timeout を解除。
      entry.onMessage(msg);
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
    // R1: outstanding pending を全 reject し closure/timer leak を残さない (握られない Promise は
    //   handshake().catch が受ける。無関係な request は本 file 内で handshake のみ)。
    rejectAllPending("teardown");
  }

  /** R1: 未解決の pending を全て reject し timer を掃除する (無界待ち / closure leak の解消)。 */
  function rejectAllPending(reasonTag: string): void {
    if (pending.size === 0) return;
    const entries = [...pending.values()];
    pending.clear();
    for (const entry of entries) {
      if (entry.timer) clearTimeout(entry.timer);
      entry.onReject(new Error(`codex rpc aborted: ${reasonTag}`));
    }
  }

  /**
   * R1/R2/R5 (ADR 019f2421): 対象 PID 限定の段階的停止 (SIGTERM→killGraceMs→SIGKILL・escalateKill)。
   * operator stop / handshake timeout / connection loss が共有する単一 choke。teardownDone 後は再武装
   * しない (exit 後に kill timer を残さない)。再 stop 時は前 timer を解除してから再武装する。
   */
  function stopChild(signal: NodeJS.Signals = "SIGTERM"): void {
    if (teardownDone) return;
    if (killTimer) clearTimeout(killTimer);
    killTimer = escalateKill(child, { signal, graceMs: killGraceMs });
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

  // handshake を起動。R1 (ADR 019f2421): 失敗 (timeout / method error) 時は observed-failure に倒す:
  //   ① session.ended(failed, reason) を emit ② canonical 未確定でも fallback で flush (operator が観測)
  //   ③ un-enforceable zombie を残さないよう child を stop。silent hang を作らない。
  void handshake().catch((err: unknown) => {
    diag(`handshake error: ${err instanceof Error ? err.message : String(err)}`);
    const reason = err instanceof CodexRpcTimeoutError ? "handshake_timeout" : "handshake_failed";
    emitSessionEndedFailure(reason);
    opts.identity.flushWithFallback();
    stopChild("SIGTERM");
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
      // 強み(a): signal → killGraceMs → SIGKILL の段階的停止 (PID 限定)・escalateKill に集約。
      // R5 (ADR 019f2421): operator 起点の graceful stop を記録し、後続 exit を crash-failed と混同せず
      //   completed/stopped で報告する (schema/state 契約は不変・reason 文字列のみ)。
      operatorStopRequested = true;
      stopChild(signal);
    },
    dispose: () => teardown(),
  };
}
