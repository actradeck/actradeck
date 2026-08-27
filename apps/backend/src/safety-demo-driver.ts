/**
 * Safety Demo Driver — 使い捨てセーフティデモの **native-free 実行体** (ADR 019f22a7 P1 / decision 019f387f).
 *
 * 旧 driver (`apps/sidecar/e2e/run-safety-demo.mts`) は Sidecar 一式 (better-sqlite3 native /
 * node-pty / hook receiver HTTP) を引き込み、Docker cockpit image (apps/sidecar 非 COPY) には載らなかった。
 * 本 driver は **backend 自身の src に同居**し、apps/sidecar/* を一切 import せず、backend の ingestion WS
 * (`/ingest/ws`) へ実 `ws` クライアントで接続して NormalizedEvent を直接 emit する。ゆえに Docker cockpit
 * (apps/backend + tsx + node_modules を COPY 済) で **host 配線ゼロ**の self-run セーフティデモが成立する。
 *
 * import 規律 (native-free の担保):
 *   許可: `ws` (npm) / `@actradeck/event-model` (正典 newEventId/parseEvent + 型) / node builtins /
 *         `./safety-demo-script.js` (定数・イベント列)。
 *   禁止: apps/sidecar/* (WsClient / normalize / cli / Sidecar) / better-sqlite3 / node-pty /
 *         `@actradeck/redaction` (redact は backend ingress floor が保存前に行う = 再実装しない)。
 *
 * REAL DATA ONLY:
 *   - **block 脚**: `tool.permission.requested`(risk=high, rm -rf) を emit → hold。UI が backend 経由で
 *     relay する `{type:"approval",request_id,decision,token}` を待ち、token が自 control_token と一致した
 *     decision で resolved を emit する。UI 無応答は安全側 timeout → **deny** に縮退する (自動 allow しない)。
 *   - **redact 脚**: `command.completed` の payload.command に dummy secret を **un-redacted** で載せる。
 *     backend ingress redaction floor (ingestion-server.ts:409) が保存前に redact する (= 本物の redaction)。
 *
 * 正直な限界 (過大表示しない):
 *   - hold は **driver 所有**の timeout であり、実セッションの sidecar ApprovalBridge ではない。driver が
 *     承認 resolve 前に異常終了 (ws 切断/kill 以外の crash) すると当該 pending card は残りうる (SIGTERM/
 *     signal は deny-safe に resolve してから閉じる)。実運用の観測は依然 host sidecar が要る (これは
 *     throwaway デモ)。block はイベントフロー + 承認カード + 監査証跡の実証であり、コマンド実行の停止では
 *     ない (デモは実コマンドを走らせない)。risk は固定定数 (実セッションは classifyCommandRisk)。
 */
import { randomBytes } from "node:crypto";

import { WebSocket } from "ws";

import {
  ApprovalDecision,
  type NormalizedEvent,
  type State,
  deriveDemoApprovalRequestId,
  newEventId,
  parseEvent,
} from "@actradeck/event-model";
import { tokenEquals } from "@actradeck/redaction";

import {
  DEMO_APPROVAL_TRIGGER,
  DEMO_CWD,
  DEMO_HIGH_RISK_COMMAND,
  DEMO_RISK_LEVEL,
  DEMO_STEPS,
  DEMO_TOOL_NAME,
  SAFETY_DEMO_SESSION_PREFIX,
  demoSecretCommand,
  type DemoStep,
} from "./safety-demo-script.js";

/**
 * hold (UI relay の Deny を待つ) の既定 timeout。
 *
 * これは **デモ自身の pacing 値**であり、本番の承認待ち (`DEFAULT_APPROVAL_TIMEOUT_MS`) とは
 * 独立に決める。以前は「sidecar の安全側 30s と同値」と書いていたが、本番既定を 300s へ広げた
 * 現在その記述は成立しない (デモを 5 分待たせるのは意図に反するため追従させない)。
 * デモは合成した承認要求を自前で hold するので、本番ゲートの順序不変条件とも無関係。
 */
export const DEFAULT_HOLD_TIMEOUT_MS = 30_000;
/** auto-deny (CI/ヘッドレス) の既定 timeout — 短くして決定論的に安全側 deny へ倒す。 */
export const DEFAULT_AUTO_DENY_TIMEOUT_MS = 1_500;
/** イベント間の pacing (live UI で人が追える速さ)。既存 driver 踏襲。 */
export const DEFAULT_PACING_MS = 450;
/** 既定 backend ingestion port。 */
export const DEFAULT_BACKEND_PORT = 55_410;

/** hold / auto-deny の 2 モード。既定は hold。 */
export type SafetyDemoApprovalMode = "hold" | "auto-deny";

/**
 * relay で受理する decision の allowlist = **event-model 正典 zod enum から導出** (TDA-2)。
 * ハードコード列挙は enum 追加/リネームで drift するため `ApprovalDecision.options` を単一出所にする
 * (realtime-server.ts:96 の VALID_DECISIONS と同型)。
 */
const VALID_DECISIONS: ReadonlySet<string> = new Set<string>(ApprovalDecision.options);

export interface DemoDriverOptions {
  /** 送信先 backend ingestion WS (フル or base・/ingest/ws を補完)。既定は env / 127.0.0.1:55410。 */
  readonly wsUrl?: string;
  /** backend ingestion の Bearer トークン (env INGEST_TOKEN)。未設定なら backend が 401。 */
  readonly ingestToken?: string;
  /** hold (既定) / auto-deny。 */
  readonly approvalMode?: SafetyDemoApprovalMode;
  /** 承認 hold の timeout 上書き (ms)。未指定はモード既定。 */
  readonly approvalTimeoutMs?: number;
  /** デモ session id。未指定なら demo-safety-<short>。 */
  readonly sessionId?: string;
  /** 使い捨て cwd。未指定なら /tmp/actradeck-demo。 */
  readonly cwd?: string;
  /** イベント間 pacing (ms)。テストは 0 に落として決定論高速化。 */
  readonly pacingMs?: number;
  /** open までの接続待ち (ms)。未接続なら明示 throw。既定 8s。 */
  readonly connectTimeoutMs?: number;
  /** 進捗ログ (secret を含めない・既定 stderr)。 */
  readonly onLog?: (msg: string) => void;
}

export interface DemoDriverResult {
  /** 使い捨てデモ session id。 */
  readonly sessionId: string;
  /** 承認カードの request_id (承認キー空間 `…:apr-…`・INV-REQUEST-ID-NAMESPACE)。 */
  readonly requestId: string;
  /** 承認モード。 */
  readonly approvalMode: SafetyDemoApprovalMode;
  /** 承認の最終 decision (timeout→"deny" / relay 値)。 */
  readonly approvalDecision: ApprovalDecision;
  /** emit した event_type 列 (順序検証用)。 */
  readonly sentEventTypes: readonly string[];
}

/** ACTRADECK_BACKEND_PORT を安全に解決する (不正は既定 55410)。 */
export function resolvePort(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.ACTRADECK_BACKEND_PORT;
  const n = raw !== undefined ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_BACKEND_PORT;
}

/** base URL に `/ingest/ws` を補完する (ingestion-server.ts:283 の route)。 */
export function resolveDriverWsUrl(
  explicit?: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const base = explicit ?? env.ACTRADECK_WS_URL ?? `ws://127.0.0.1:${resolvePort(env)}`;
  return base.includes("/ingest/ws") ? base : `${base.replace(/\/+$/, "")}/ingest/ws`;
}

/** relay で来た decision を T1 enum へ正規化 (未知値は undefined = 無視)。 */
export function normalizeDecision(raw: unknown): ApprovalDecision | undefined {
  return typeof raw === "string" && VALID_DECISIONS.has(raw)
    ? (raw as ApprovalDecision)
    : undefined;
}

/**
 * relay の control token を定数時間比較で検証する (ws-client.ts SEC-1 と同原則・fail-safe)。
 * 自 control_token と一致しない token を載せた approval は **無視**する (無認証 peer の注入を遮断)。
 * 比較本体は @actradeck/redaction の正典 `tokenEquals` (TDA-5 sweep で単一出所化)。
 */
export function tokenMatches(expected: string, provided: unknown): boolean {
  return tokenEquals(expected, provided);
}

/** DemoStep + payload から NormalizedEvent を組み、parseEvent (ingress と同一検証) で検証して返す。 */
function buildDemoEvent(input: {
  sessionId: string;
  eventType: DemoStep["event_type"];
  state: State;
  summary: string;
  cwd: string;
  payload: Record<string, unknown>;
}): NormalizedEvent {
  return parseEvent({
    event_id: newEventId(),
    // 既存デモ (sidecar 経由) と同じ可視結果にするため claude_code / hooks を既定にする。
    provider: "claude_code",
    source: "hooks",
    session_id: input.sessionId,
    // デモは承認イベントフローを再現するが、実コマンドを起動・停止しない。
    ...(input.eventType === "session.started" ? { governance_mode: "observe_only" } : {}),
    event_type: input.eventType,
    state: input.state,
    timestamp: new Date().toISOString(),
    summary: input.summary,
    cwd: input.cwd,
    payload: input.payload,
    metrics: {},
  });
}

function sleep(ms: number): Promise<void> {
  return ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve();
}

/**
 * hold 中 (resolveHold 定義済) なら **deny-safe** に解決する純ヘルパ (QA-3)。解決したら true。
 * SIGTERM/SIGINT ハンドラと finally backstop が共有し、pending 承認を安全側 (deny) で畳んでから閉じる
 * (INV-APPROVAL: 自動 allow しない)。resolveHold 未設定 (未 hold / 既に解決済) は no-op で false。
 */
export function denySafeResolveHold(
  resolveHold: ((d: ApprovalDecision) => void) | undefined,
): boolean {
  if (resolveHold === undefined) return false;
  resolveHold("deny");
  return true;
}

/**
 * 使い捨て Safety Demo を backend ingestion WS へ直接駆動する (native-free)。
 *
 * backend 未起動 (connectTimeoutMs 内に open にならない) なら **明示 throw** する (silent skip 禁止)。
 */
export async function runSafetyDemoDriver(opts: DemoDriverOptions = {}): Promise<DemoDriverResult> {
  const log = opts.onLog ?? ((m: string) => process.stderr.write(`[safety-demo-driver] ${m}\n`));
  const approvalMode = opts.approvalMode ?? "hold";
  const approvalTimeoutMs =
    opts.approvalTimeoutMs ??
    (approvalMode === "auto-deny" ? DEFAULT_AUTO_DENY_TIMEOUT_MS : DEFAULT_HOLD_TIMEOUT_MS);
  const sessionId =
    opts.sessionId ?? `${SAFETY_DEMO_SESSION_PREFIX}${randomBytes(4).toString("hex")}`;
  const cwd = opts.cwd ?? DEMO_CWD;
  const pacingMs = opts.pacingMs ?? DEFAULT_PACING_MS;
  const connectTimeoutMs = opts.connectTimeoutMs ?? 8_000;
  const ingestToken = opts.ingestToken ?? process.env.INGEST_TOKEN;
  const url = resolveDriverWsUrl(opts.wsUrl);
  // per-connection 制御トークン (server 側は付与しないが sidecar と同じ SEC-1 認可境界を driver 側でも張る)。
  const controlToken = randomBytes(32).toString("hex");
  // 承認キー空間 (INV-REQUEST-ID-NAMESPACE の `…:apr-…`)。決定論的 (テストが再計算可能) かつ
  // redaction-stable な正準採番 (TDA-R2-1/SEC-R2-4: 旧 `${sessionId}:apr-1` は任意 session id
  // 注入 (ACTRADECK_DEMO_SESSION_ID) で SEC-1 hazard を再現した — 正準へ集約)。
  const requestId = deriveDemoApprovalRequestId(sessionId);

  const ws =
    ingestToken !== undefined && ingestToken.length > 0
      ? new WebSocket(url, { headers: { Authorization: `Bearer ${ingestToken}` } })
      : new WebSocket(url);

  const sentEventTypes: string[] = [];
  let requestedEmitted = false;
  let resolvedEmitted = false;
  // hold を解く関数 (relay approval / timeout / signal が resolve する)。
  let resolveHold: ((d: ApprovalDecision) => void) | undefined;

  ws.on("message", (data: Buffer) => {
    let msg: unknown;
    try {
      msg = JSON.parse(data.toString("utf8"));
    } catch {
      return; // ack 等の非 JSON / 壊れは無視。
    }
    if (
      msg === null ||
      typeof msg !== "object" ||
      (msg as { type?: unknown }).type !== "approval"
    ) {
      return; // ack など approval 以外は無視。
    }
    const frame = msg as { request_id?: unknown; decision?: unknown; token?: unknown };
    if (frame.request_id !== requestId) return; // 別 request は無視。
    if (!tokenMatches(controlToken, frame.token)) return; // fail-safe: token 不一致は無視。
    const decision = normalizeDecision(frame.decision);
    if (decision !== undefined && resolveHold !== undefined) resolveHold(decision);
  });

  // SIGTERM/SIGINT: open な承認要求があれば deny-safe に解決してから閉じる (pending card を残さない)。
  const onSignal = (): void => {
    log("signal received → deny-safe shutdown");
    denySafeResolveHold(resolveHold);
  };
  process.once("SIGTERM", onSignal);
  process.once("SIGINT", onSignal);

  const send = (event: NormalizedEvent): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      ws.send(JSON.stringify(event), (err) => (err ? reject(err) : resolve()));
      sentEventTypes.push(event.event_type);
    });

  const emitStep = (step: DemoStep, payload: Record<string, unknown>, stateOverride?: State) =>
    send(
      buildDemoEvent({
        sessionId,
        eventType: step.event_type,
        state: stateOverride ?? step.state,
        summary: step.summary,
        cwd,
        payload,
      }),
    );

  try {
    // open を待つ (未接続は明示 throw)。
    await new Promise<void>((resolve, reject) => {
      if (ws.readyState === WebSocket.OPEN) return resolve();
      const timer = setTimeout(
        () =>
          reject(
            new Error(
              `backend ingestion WS (${url}) へ ${connectTimeoutMs}ms 以内に接続できません`,
            ),
          ),
        connectTimeoutMs,
      );
      ws.once("open", () => {
        clearTimeout(timer);
        resolve();
      });
      ws.once("error", (err: Error) => {
        clearTimeout(timer);
        reject(err);
      });
    });
    log(
      `connected session=${sessionId} mode=${approvalMode} timeout=${approvalTimeoutMs}ms ws=${url}`,
    );

    // hello: control_token + 所有 session_id を送る (backend registry が relay 認可を学習)。
    // policy_capable / agent_visibility は **載せない** (policy 宛先 / readiness を汚染しない)。
    ws.send(
      JSON.stringify({ type: "hello", control_token: controlToken, session_ids: [sessionId] }),
    );

    // a. session.started。
    await emitStep(DEMO_STEPS.sessionStarted, { kind: DEMO_STEPS.sessionStarted.event_type });
    await sleep(pacingMs);

    // b. block 脚: 高リスク承認要求 (rm -rf) → hold。
    requestedEmitted = true;
    await emitStep(DEMO_STEPS.permissionRequested, {
      kind: DEMO_STEPS.permissionRequested.event_type,
      request_id: requestId,
      tool_name: DEMO_TOOL_NAME,
      command: DEMO_HIGH_RISK_COMMAND,
      risk_level: DEMO_RISK_LEVEL,
      trigger: DEMO_APPROVAL_TRIGGER,
    });
    log(`hold: awaiting approval for ${requestId} (${approvalMode})`);

    // hold: relay approval を待ち、無応答は安全側 deny へ縮退 (INV-APPROVAL)。
    const decision = await new Promise<ApprovalDecision>((resolve) => {
      const timer = setTimeout(() => {
        resolveHold = undefined;
        resolve("deny");
      }, approvalTimeoutMs);
      resolveHold = (d: ApprovalDecision) => {
        clearTimeout(timer);
        resolveHold = undefined;
        resolve(d);
      };
    });
    const allowed = decision === "allow" || decision === "allow_for_session";
    log(`approval resolved: ${decision}`);

    // resolved: 許可 running.tool_preparing / 拒否 running.model_wait (hook-receiver.ts:367 と parity)。
    resolvedEmitted = true;
    await emitStep(
      DEMO_STEPS.permissionResolvedDeny,
      {
        kind: DEMO_STEPS.permissionResolvedDeny.event_type,
        request_id: requestId,
        decision,
      },
      allowed ? "running.tool_preparing" : "running.model_wait",
    );
    await sleep(pacingMs);

    // c. redact 脚: dummy secret を含む command.completed を un-redacted で送る (ingress floor が redact)。
    await emitStep(DEMO_STEPS.commandCompleted, {
      kind: DEMO_STEPS.commandCompleted.event_type,
      command: demoSecretCommand(),
      exit_code: 0,
      // tool_use_id 由来キー (`tu:…`)・承認キー空間と非交差 (INV-REQUEST-ID-NAMESPACE)。
      request_id: `tu:${sessionId}-cmd`,
    });
    await sleep(pacingMs);

    // d. session.ended。
    await emitStep(DEMO_STEPS.sessionEnded, {
      kind: DEMO_STEPS.sessionEnded.event_type,
      reason: "other",
    });

    // 送信 (ws.send コールバック) は既に解決済み = OS バッファへ flush 済み。短い猶予後に閉じる。
    await sleep(150);

    return { sessionId, requestId, approvalMode, approvalDecision: decision, sentEventTypes };
  } finally {
    process.off("SIGTERM", onSignal);
    process.off("SIGINT", onSignal);
    // TDA-6 backstop: throw 等で承認要求のみ emit され resolved 未達なら、best-effort で resolved(deny) を
    // emit してから閉じ、pending card の残存を縮小する (INV-APPROVAL: 安全側 deny)。resolvedEmitted ゲートで
    // 正常路との二重 resolved を防ぐ。ws 死亡時は send が同期 throw / reject するため try/catch で握り (daemon を
    // 落とさない backstop)、それでも emit 不能なら card は残りうる (限界・docs 開示)。
    // NOTE: finally は一度しか走らないため、ここで resolvedEmitted を再セットしない (dead store・CodeQL
    //   js/useless-assignment-to-local #24)。二重 resolved 防止はガード条件 (読み取り) のみで成立する。
    if (requestedEmitted && !resolvedEmitted) {
      try {
        await emitStep(
          DEMO_STEPS.permissionResolvedDeny,
          {
            kind: DEMO_STEPS.permissionResolvedDeny.event_type,
            request_id: requestId,
            decision: "deny",
          },
          "running.model_wait",
        );
      } catch {
        // ws 死亡等で emit 不能: card は残りうる (限界・docs 開示)。daemon は落とさない。
      }
    }
    try {
      ws.close();
    } catch {
      // 既に閉じている等は無視。
    }
  }
}

/** CLI env → driver options の純パーサ (main の分岐を testable に抽出)。ingest token は別途 main が検証する。 */
export interface DriverEnvOptions {
  readonly approvalMode: SafetyDemoApprovalMode;
  readonly approvalTimeoutMs?: number;
  readonly sessionId?: string;
}
export function parseDriverEnv(env: NodeJS.ProcessEnv): DriverEnvOptions {
  const approvalMode: SafetyDemoApprovalMode =
    env.ACTRADECK_DEMO_APPROVAL === "auto-deny" ? "auto-deny" : "hold";
  const timeoutRaw = env.ACTRADECK_DEMO_APPROVAL_TIMEOUT_MS;
  const timeoutParsed = timeoutRaw !== undefined ? Number.parseInt(timeoutRaw, 10) : Number.NaN;
  const sessionId = env.ACTRADECK_DEMO_SESSION_ID;
  return {
    approvalMode,
    ...(Number.isInteger(timeoutParsed) && timeoutParsed > 0
      ? { approvalTimeoutMs: timeoutParsed }
      : {}),
    ...(sessionId !== undefined && sessionId.length > 0 ? { sessionId } : {}),
  };
}

/** CLI エントリ: env から設定を解決して 1 本走らせ、要約を stderr に出す。 */
async function main(): Promise<void> {
  const ingestToken = process.env.INGEST_TOKEN;
  if (ingestToken === undefined || ingestToken.length === 0) {
    process.stderr.write("[safety-demo-driver] INGEST_TOKEN is required\n");
    process.exit(2);
    return;
  }
  const result = await runSafetyDemoDriver({ ingestToken, ...parseDriverEnv(process.env) });

  process.stderr.write("\n========== ActraDeck SAFETY DEMO (native-free driver) ==========\n");
  process.stderr.write(`session_id        : ${result.sessionId}\n`);
  process.stderr.write(`cwd (throwaway)   : ${DEMO_CWD}\n`);
  process.stderr.write(`approval mode     : ${result.approvalMode}\n`);
  process.stderr.write(`high-risk decision: ${result.approvalDecision}\n`);
  process.stderr.write(`events emitted    : ${result.sentEventTypes.length}\n`);
  process.stderr.write("================================================================\n");
}

// tsx で直接起動されたときのみ実行 (import 時は副作用なし・run-safety-demo.mts:334 と同型)。
if (import.meta.url === `file://${process.argv[1]}`) {
  void main().catch((e: unknown) => {
    process.stderr.write(
      `[safety-demo-driver] fatal: ${e instanceof Error ? e.message : String(e)}\n`,
    );
    process.exit(1);
  });
}
