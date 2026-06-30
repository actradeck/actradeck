#!/usr/bin/env node
/**
 * agentmon CLI — Managed Mode エントリ (`agentmon claude [-- claude args]`).
 *
 * plan.md §11 Managed Mode: Sidecar が claude を PTY 子プロセスとして起動し、
 * hook receiver / process monitor / stdout-stderr collector / git diff watcher /
 * secret redactor / SQLite append-only / WS client を配線する。
 *
 * 使い方:
 *   agentmon claude [-- <claude に渡す引数>]
 *   環境変数:
 *     INGEST_TOKEN       backend ingestion(/ingest/ws) の Bearer 認証トークン。backend と同一値。
 *                        未設定だと backend が upgrade を 401 で拒否する (値はログに出さない)。
 *     ACTRADECK_BACKEND_PORT  backend WS のポート (既定 55410; .env.example と単一出所)
 *     ACTRADECK_WS_URL        送信先 backend WS の base。指定時は BACKEND_PORT より優先
 *                             (既定 ws://127.0.0.1:${ACTRADECK_BACKEND_PORT})。canonical な
 *                             ingestion パス /ingest/ws は本 CLI が付与する (base にパスが
 *                             無ければ補完。既に /ingest/ws を含むフル URL はそのまま尊重)。
 *     ACTRADECK_DB       ローカル SQLite パス (既定 ~/.actradeck/sidecar.db)
 *     ACTRADECK_SESSION  session_id (既定 自動採番)
 *     ACTRADECK_CLAUDE_BIN  claude 実行パス (既定 PATH 上の "claude")
 *
 * graceful shutdown: SIGINT/SIGTERM で未送信を flush し close する。
 */
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { newEventId } from "@actradeck/event-model";

import { ApprovalAllowlistStore } from "./approval-allowlist-store.js";
import { runApprovalsCli } from "./approvals-cli.js";
import { Sidecar } from "./sidecar.js";
import { AttachDaemon } from "./attach-daemon.js";
import { CodexRolloutDaemon } from "./codex-rollout-daemon.js";
import { type DaemonRuntime, parseDaemonArgs, runStart, runStatus, runStop } from "./daemon-cli.js";

function parseArgs(argv: readonly string[]): {
  provider: string;
  claudeArgs: string[];
} {
  // argv[0]=node, argv[1]=cli.js, argv[2]=provider (claude), rest=passthrough。
  const provider = argv[2] ?? "claude";
  const sepIdx = argv.indexOf("--");
  const claudeArgs = sepIdx >= 0 ? argv.slice(sepIdx + 1) : argv.slice(3);
  return { provider, claudeArgs };
}

/**
 * 3#TDA-3: backend WS port の単一出所。`.env.example` の ACTRADECK_BACKEND_PORT (既定 55410)
 * を参照する (旧実装は 8787 ハードコードで .env.example / ポート割当メモ 019e8e7f と不整合)。
 * ACTRADECK_WS_URL が明示指定されればそれを優先 (運用上の上書き)。
 */
export const DEFAULT_BACKEND_PORT = 55410;

/**
 * backend ingestion WS の canonical パス。backend の `app.get("/ingest/ws", {websocket:true})`
 * (ingestion-server.ts) と単一契約。**egress live bug (decision pending) の回帰固定点**:
 * 旧 resolveWsUrl は base のみ返し path を欠いたため、sidecar はルート `/` に upgrade して
 * 404→未 OPEN→0 送信になっていた (egress-handshake の test ws は任意 path を受理し見逃した)。
 */
export const INGEST_WS_PATH = "/ingest/ws";

/**
 * base URL に canonical な ingestion path を付与する。
 * - path 無し (pathname が "" または "/") → INGEST_WS_PATH を設定。
 * - 既に何らかの path を持つ (フル URL) → operator 指定を尊重しそのまま。
 * - URL として解釈不能な場合は末尾スラッシュを除いて INGEST_WS_PATH を後置 (防御的)。
 */
function withIngestPath(base: string): string {
  let u: URL;
  try {
    u = new URL(base);
  } catch {
    return base.replace(/\/+$/, "") + INGEST_WS_PATH;
  }
  if (u.pathname === "" || u.pathname === "/") {
    u.pathname = INGEST_WS_PATH;
  }
  // URL.toString() は path のみのとき末尾スラッシュを付けないが、念のため正規化。
  return u.toString().replace(/\/+$/, "");
}

export function resolveWsUrl(): string {
  const explicit = process.env.ACTRADECK_WS_URL;
  if (explicit !== undefined && explicit.length > 0) return withIngestPath(explicit);
  const portRaw = process.env.ACTRADECK_BACKEND_PORT;
  const parsed = portRaw !== undefined ? Number.parseInt(portRaw, 10) : Number.NaN;
  const port =
    Number.isInteger(parsed) && parsed > 0 && parsed < 65536 ? parsed : DEFAULT_BACKEND_PORT;
  return withIngestPath(`ws://127.0.0.1:${port}`);
}

function defaultDbPath(): string {
  const dir = join(homedir(), ".actradeck");
  mkdirSync(dir, { recursive: true });
  return join(dir, "sidecar.db");
}

function parseCodexAttachArgs(argv: readonly string[]): {
  backfill?: boolean;
  codexHome?: string;
  statePath?: string;
  pollIntervalMs?: number;
} {
  const out: {
    backfill?: boolean;
    codexHome?: string;
    statePath?: string;
    pollIntervalMs?: number;
  } = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--backfill") {
      out.backfill = true;
      continue;
    }
    if (arg === "--codex-home" && argv[i + 1] !== undefined) {
      out.codexHome = argv[++i]!;
      continue;
    }
    if (arg === "--state-path" && argv[i + 1] !== undefined) {
      out.statePath = argv[++i]!;
      continue;
    }
    if (arg === "--poll-interval-ms" && argv[i + 1] !== undefined) {
      const parsed = Number.parseInt(argv[++i]!, 10);
      if (Number.isInteger(parsed) && parsed > 0) out.pollIntervalMs = parsed;
    }
  }
  return out;
}

/**
 * Attach idle-reaper の設定を env から解決する (QA-2 / ADR 019eb448)。
 *
 * idle-TTL は **SessionEnd abrupt-exit backstop** であり liveness シグナルではない
 * (GitWatcher 由来 diff は lastHookAt を更新しない設計)。正常稼働でも hook 間隔が
 * idle-TTL を超える session を誤 reap しうる (誤 reap は次 hook で self-heal するが窓が出る)。
 * 運用で窓を狭めたい/広げたい場合に env で調整可能にする:
 *  - ACTRADECK_ATTACH_IDLE_TTL_MS: 正の整数のみ採用 (既定 = registry の 30min)。
 *  - ACTRADECK_ATTACH_REAPER_INTERVAL_MS: 0 以上の整数 (0 で自動 sweep 無効・既定 60s)。
 * 不正値 (非数値 / 負 / idle-TTL=0) は無視して registry 既定にフォールバックする。
 */
export function resolveAttachReaperConfig(): {
  idleTtlMs?: number;
  reaperIntervalMs?: number;
} {
  const out: { idleTtlMs?: number; reaperIntervalMs?: number } = {};
  const ttlRaw = process.env.ACTRADECK_ATTACH_IDLE_TTL_MS;
  const ttl = ttlRaw !== undefined ? Number.parseInt(ttlRaw, 10) : Number.NaN;
  if (Number.isInteger(ttl) && ttl > 0) out.idleTtlMs = ttl;
  const intervalRaw = process.env.ACTRADECK_ATTACH_REAPER_INTERVAL_MS;
  const interval = intervalRaw !== undefined ? Number.parseInt(intervalRaw, 10) : Number.NaN;
  if (Number.isInteger(interval) && interval >= 0) out.reaperIntervalMs = interval;
  return out;
}

/**
 * managed mode (`agentmon claude`) の session id 構成を解決する。
 *
 * live-found 修正 (task 019e948f): managed mode は **実 claude の hook が canonical session_id を
 * 供給する**。したがって ACTRADECK_SESSION が設定されていても **即確定 (explicit) にしてはならない**。
 * 即確定すると learn-once が hook の canonical を無視し、監視イベント(=ACTRADECK_SESSION)と
 * hook イベント(=claude session_id)が別 session に割れる (ライブで実測: probe_003)。
 *
 * よって managed mode では:
 *  - `explicitSession` は **常に false** (canonical は必ず hook 由来。explicit 即確定は Attach/test 専用)。
 *  - `sessionId` は ACTRADECK_SESSION (あれば) または自動採番。これは SessionIdentity の
 *    **fallback id** (canonical 確定前の暫定 / hook 皆無時の last-resort) として渡る。
 *
 * @param idFactory テスト注入用の id 生成器 (既定 newEventId)。
 */
export function resolveManagedSession(idFactory: () => string = newEventId): {
  sessionId: string;
  explicitSession: false;
} {
  const env = process.env.ACTRADECK_SESSION;
  const sessionId = env !== undefined && env.length > 0 ? env : `sess_${idFactory()}`;
  return { sessionId, explicitSession: false };
}

/**
 * Attach Mode エントリ (`agentmon daemon start|stop|status` / `agentmon attach`) — ADR 019ea476。
 * 常駐 daemon を起動し CC の settings へ安定 hook endpoint を非破壊配線する (起動を所有しない)。
 */
async function mainDaemon(): Promise<void> {
  const args = parseDaemonArgs(process.argv.slice(2));
  const wsUrl = resolveWsUrl();
  const dbPath = process.env.ACTRADECK_DB ?? defaultDbPath();
  const ingestToken = process.env.INGEST_TOKEN;
  // literal token-mode の nonce: env override (ACTRADECK_HOOK_TOKEN) があれば流用、
  // 無ければ daemon が自前採番する (AttachDaemon 側既定)。
  const envHookToken = process.env.ACTRADECK_HOOK_TOKEN;
  // idle-reaper の env 上書き (QA-2 / ADR 019eb448)。誤 reap 窓の運用調整用。
  const reaperConfig = resolveAttachReaperConfig();

  let runningDaemon: AttachDaemon | undefined;
  const rt: DaemonRuntime = {
    log: (m) => process.stderr.write(`${m}\n`),
    startDaemon: async (opts) => {
      const daemon = new AttachDaemon({
        wsUrl: opts.wsUrl,
        dbPath: opts.dbPath,
        ...(opts.ingestToken !== undefined && opts.ingestToken.length > 0
          ? { ingestToken: opts.ingestToken }
          : {}),
        ...(opts.hookToken !== undefined && opts.hookToken.length > 0
          ? { hookToken: opts.hookToken }
          : {}),
        onHook: (name) => process.stderr.write(`[hook] ${name}\n`),
        onInterruptIgnored: (sid) =>
          process.stderr.write(
            `[attach] interrupt 無視 (Attach は停止制御非対応 / 非所有 PID を kill しない) session=${sid ?? "?"}\n`,
          ),
        onValidationError: (et, msg) => process.stderr.write(`[validation-error] ${et}: ${msg}\n`),
        // L2(b): 承認 disk-write 失敗を operator へ件数のみ surface (NO-RAW・生 fs エラー非表示)。
        onPersistFailure: (count) =>
          process.stderr.write(`[approval-persist] disk persist failed (count=${count})\n`),
        ...reaperConfig,
      });
      const { hookEndpoint } = await daemon.start();
      runningDaemon = daemon;
      // daemon が検証に使う実 nonce を settings へ書くために返す。
      return { daemon, hookEndpoint, hookToken: daemon.hookAuthToken };
    },
  };

  if (args.action === "status") {
    runStatus(args, rt);
    return;
  }
  if (args.action === "stop") {
    runStop(args, rt);
    return;
  }

  // start: daemon を起動して settings を配線し、常駐する (SIGINT/SIGTERM で detach + shutdown)。
  const outcome = await runStart(
    args,
    {
      wsUrl,
      dbPath,
      ...(ingestToken !== undefined && ingestToken.length > 0 ? { ingestToken } : {}),
      ...(envHookToken !== undefined && envHookToken.length > 0 ? { hookToken: envHookToken } : {}),
    },
    rt,
  );
  if (outcome.status !== "started" || runningDaemon === undefined) {
    // dry-run / already-running / denied-* は常駐しない (daemon も起動済でない)。
    if (outcome.status === "denied-needs-confirm" || outcome.status === "denied-token-leak") {
      process.exitCode = 1;
    }
    return;
  }
  const daemon = runningDaemon;
  let shuttingDown = false;
  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    process.stderr.write(`[attach] ${signal} → detach + shutdown\n`);
    // settings から ActraDeck hooks を可逆 detach し state を消す。
    runStop(args, rt);
    await daemon.shutdown();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.stderr.write(
    `[attach] 常駐中 (endpoint=${outcome.hookEndpoint ?? "?"})。CC を起動すると hook が届きます。Ctrl-C で detach。\n`,
  );
  // 常駐: daemon は外部 hook 受信で動作し続ける。process を生かし続ける。
}

async function mainCodexRolloutAttach(): Promise<void> {
  const args = parseCodexAttachArgs(process.argv.slice(4));
  const wsUrl = resolveWsUrl();
  const dbPath = process.env.ACTRADECK_DB ?? defaultDbPath();
  const ingestToken = process.env.INGEST_TOKEN;
  if (ingestToken === undefined || ingestToken.length === 0) {
    process.stderr.write(
      "[codex attach] warning: INGEST_TOKEN 未設定。backend ingestion は認証必須のため、" +
        "このままでは upgrade が 401 で拒否され送信ループになります " +
        "(.env.example の INGEST_TOKEN を設定してください)。\n",
    );
  }

  const daemon = new CodexRolloutDaemon({
    wsUrl,
    dbPath,
    ...(args.codexHome !== undefined ? { codexHome: args.codexHome } : {}),
    ...(args.statePath !== undefined ? { statePath: args.statePath } : {}),
    ...(args.pollIntervalMs !== undefined ? { pollIntervalMs: args.pollIntervalMs } : {}),
    ...(args.backfill !== undefined ? { backfill: args.backfill } : {}),
    ...(ingestToken !== undefined && ingestToken.length > 0 ? { ingestToken } : {}),
    onWarning: (m) => process.stderr.write(`[codex rollout] ${m}\n`),
    onValidationError: (et, msg) => process.stderr.write(`[validation-error] ${et}: ${msg}\n`),
    onOutOfOrder: (o) =>
      process.stderr.write(
        `[out-of-order] session=${o.session_id} type=${o.event_type} regression_ms=${o.regression_ms} (hwm=${o.high_water_mark_ms})\n`,
      ),
    onInterruptIgnored: (sid) =>
      process.stderr.write(
        `[codex attach] interrupt 無視 (rollout attach は観測専用 / codex を kill しない) session=${sid ?? "?"}\n`,
      ),
  });

  let shuttingDown = false;
  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    process.stderr.write(`[codex attach] ${signal} → shutdown\n`);
    await daemon.shutdown();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  await daemon.start();
  process.stderr.write(
    `[codex attach] rollout tailer running ws=${wsUrl} db=${dbPath} backfill=${args.backfill === true ? "true" : "false"}\n`,
  );
  await new Promise<void>(() => {});
}

async function main(): Promise<void> {
  if (process.argv[2] === "codex" && process.argv[3] === "attach") {
    await mainCodexRolloutAttach();
    return;
  }

  // Attach Mode のサブコマンド分岐 (ADR 019ea476): daemon / attach。
  const sub = process.argv[2];
  if (sub === "daemon" || sub === "attach") {
    await mainDaemon();
    return;
  }

  // ADR 019ee0c0: 永続承認 allowlist の閲覧/失効 (list|revoke|clear)。
  if (sub === "approvals") {
    const code = runApprovalsCli(process.argv.slice(3), {
      store: new ApprovalAllowlistStore(),
      now: Date.now(),
      out: (s) => process.stdout.write(s),
      err: (s) => process.stderr.write(s),
    });
    process.exit(code);
  }

  const { provider, claudeArgs } = parseArgs(process.argv);
  if (provider !== "claude" && provider !== "codex") {
    process.stderr.write(`agentmon: provider "${provider}" 未対応 (claude / codex)。\n`);
    process.exit(2);
  }

  // ADR 019e9462 + live-found 修正 (019e948f): managed mode は hook が canonical を供給するため
  // ACTRADECK_SESSION 設定時も即確定せず fallback (learn-wait) とする。canonical は常に hook 由来。
  // 確定前の監視イベントは hold され、確定後に hook session_id で flush される。
  const { sessionId, explicitSession } = resolveManagedSession();
  const wsUrl = resolveWsUrl();
  const dbPath = process.env.ACTRADECK_DB ?? defaultDbPath();
  const claudeBin = process.env.ACTRADECK_CLAUDE_BIN;

  // SEC-2 (egress): backend ingestion は Bearer 認証必須 (?token= 禁止)。INGEST_TOKEN を
  // env から読み WsClient へ Bearer として渡す。**token 値はログに出さない**。
  const ingestToken = process.env.INGEST_TOKEN;
  if (ingestToken === undefined || ingestToken.length === 0) {
    process.stderr.write(
      "[agentmon] warning: INGEST_TOKEN 未設定。backend ingestion は認証必須のため、" +
        "このままでは upgrade が 401 で拒否され送信ループになります " +
        "(.env.example の INGEST_TOKEN を設定してください)。\n",
    );
  }

  const sidecar = new Sidecar({
    sessionId,
    explicitSession,
    wsUrl,
    dbPath,
    cwd: process.cwd(),
    // 値はログに出さない。未設定時は warning 済 (上)。
    ...(ingestToken !== undefined && ingestToken.length > 0 ? { ingestToken } : {}),
    onHook: (name) => process.stderr.write(`[hook] ${name}\n`),
    onValidationError: (et, msg) => process.stderr.write(`[validation-error] ${et}: ${msg}\n`),
    // 3#QA-2: out-of-order を可視化 (イベントは落とさない。順序権威は Phase 3)。
    onOutOfOrder: (o) =>
      process.stderr.write(
        `[out-of-order] session=${o.session_id} type=${o.event_type} regression_ms=${o.regression_ms} (hwm=${o.high_water_mark_ms})\n`,
      ),
    // L2(b): 承認 disk-write 失敗を operator へ件数のみ surface (NO-RAW・生 fs エラー非表示)。
    onPersistFailure: (count) =>
      process.stderr.write(`[approval-persist] disk persist failed (count=${count})\n`),
  });

  const { hookEndpoint } = await sidecar.start();
  process.stderr.write(
    `[agentmon] provider=${provider} session=${sessionId} hook=${hookEndpoint} ws=${wsUrl} db=${dbPath}\n`,
  );

  // provider 分岐: claude=PTY hook 経路 / codex=app-server JSON-RPC 経路 (ADR 019ea31b)。
  // 双方とも `stop`(PID 限定停止) / `dispose` / `exited` を持つ共通 shape に正規化する。
  let managed: {
    readonly pid: number | undefined;
    readonly exited: Promise<number>;
    stop(signal?: NodeJS.Signals): void;
    dispose(): void;
  };
  if (provider === "codex") {
    const codexBin = process.env.ACTRADECK_CODEX_BIN;
    // codex の初期入力プロンプト: `agentmon codex -- <prompt...>` の passthrough を結合 (任意)。
    const initialPrompt = claudeArgs.length > 0 ? claudeArgs.join(" ") : undefined;
    managed = sidecar.startManagedCodex({
      ...(codexBin !== undefined ? { codexBin } : {}),
      ...(initialPrompt !== undefined ? { initialPrompt } : {}),
      onDiagnostic: (m) => process.stderr.write(`[codex] ${m}\n`),
    });
    process.stderr.write(`[agentmon] codex pid=${managed.pid ?? "?"}\n`);
  } else {
    managed = sidecar.startManaged(claudeArgs, claudeBin);
    process.stderr.write(`[agentmon] claude pid=${managed.pid}\n`);
  }

  let shuttingDown = false;
  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    process.stderr.write(`[agentmon] ${signal} → shutdown\n`);
    managed.stop(signal);
    await sidecar.shutdown();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  // SEC-3 (redaction 019e98aa): raw mode 化後に未捕捉例外/未処理 rejection が出ると
  //   `managed.stop()`(→ bridge.restore → setRawMode(false)) を経ずにプロセスが死に、
  //   ユーザー端末が raw 放置 (無反応) になる。fail-safe を二重に張る:
  //   (1) `exit` 同期ハンドラで `managed.stop()` を必ず呼ぶ (bridge.restore は同期・冪等)。
  //       どの終了経路 (正常 / 例外 / signal) でも端末を確実に復元する最後の砦。
  //   (2) `uncaughtException` / `unhandledRejection` では best-effort で stop してから非ゼロ exit。
  process.on("exit", () => {
    // 同期のみ可。bridge.restore() は同期で raw mode を戻す (sidecar.shutdown は非同期なので呼ばない)。
    try {
      managed.stop("SIGTERM");
    } catch {
      /* 端末復元の best-effort。失敗しても exit は続行。 */
    }
  });
  const onFatal = (kind: string, err: unknown): void => {
    process.stderr.write(
      `[agentmon] fatal ${kind}: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
    );
    try {
      managed.stop("SIGTERM"); // 端末復元 (raw 放置を防ぐ)。`exit` ハンドラでも冪等に再実行される。
    } catch {
      /* best-effort */
    }
    process.exit(1); // 非ゼロ exit (これにより `exit` ハンドラも発火する)。
  };
  process.on("uncaughtException", (err) => onFatal("uncaughtException", err));
  process.on("unhandledRejection", (reason) => onFatal("unhandledRejection", reason));

  const code = await managed.exited;
  process.stderr.write(`[agentmon] claude exited code=${code}\n`);
  await sidecar.shutdown();
  process.exit(code);
}

/**
 * 直接実行されたときだけ main() を起動する。test から resolveWsUrl 等を import する際に
 * sidecar を起動しないためのガード (process.argv[1] が本ファイルのときのみ実行)。
 */
function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  return fileURLToPath(import.meta.url) === entry || import.meta.url === `file://${entry}`;
}

if (isDirectRun()) {
  void main().catch((err: unknown) => {
    process.stderr.write(`[agentmon] fatal: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
