/**
 * ActraDeck Safety Demo — 使い捨て「セーフティデモ」セッションの seed ドライバ (ADR 019f22a7 P1)。
 *
 * 目的: 「ダミー高リスク操作を実際に承認ゲートで止め、ダミー secret を実際に保存前 redact する」
 *       使い捨てデモセッションを **実パイプライン (sidecar → ingestion → event store)** で駆動する。
 *
 * REAL DATA ONLY:
 *   - run-hook-replay-e2e.mts と違い送り先は `VerificationWsSink` **ではなく**、実 backend の
 *     ingestion WS (`/ingest/ws`) へ実 `WsClient` で接続する。よって backend の
 *     `INSERT INTO events` (apps/backend/src/ingest-store.ts) を実際に通り、event store に実行が入る。
 *   - hook は実 claude が送る hook JSON 形状 (probe 採取) を実 HTTP で HookReceiver に POST する
 *     (画面スクレイピングでなく構造化イベント経路)。
 *
 * 駆動シーケンス (使い捨て 1 セッション):
 *   a. SessionStart (cwd = 使い捨て /tmp/actradeck-demo)。
 *   b. PreToolUse Bash `rm -rf <demoCwd>/build` → 実 classifyCommandRisk=high (recursive-rm)
 *      → 承認カード emit (tool.permission.requested)。
 *        - hold モード (既定): 承認は pending のまま hold し、UI が後で Deny を relay する想定。
 *          UI 無応答なら既存の安全側 timeout (30s) → deny に縮退する (INV-APPROVAL)。
 *        - auto-deny モード (CI/ヘッドレス): 短い approvalTimeoutMs → 実 bridge が安全側 deny に倒す
 *          (= resolved(deny) が event store へ到達)。人手を介さず決定論的。
 *   c. ダミー secret を含むコマンド出力を **PostToolUse** (非ゲート経路) の tool_input.command として
 *      流す → 実 `Sink.emit` が保存前 redact → redaction_count_by_kind に aws-access-key-id /
 *      github-token が乗る (生 secret は SQLite/DB に残らない)。
 *   d. Stop / SessionEnd。
 *
 * デモセッションの識別 (schema 逸脱なし):
 *   session_id を `demo-safety-<short>` prefix にする (event-model の既存 `session_id` フィールドの
 *   許容範囲。新フィールドは足さない)。cwd も使い捨て /tmp 配下ゆえ「デモと分かる・削除できる」。
 *
 * 合成 secret は **公開ダミーのみ** (AKIA…/ghp_…)。実 secret は厳禁。本ファイルは `e2e/` 配下ゆえ
 * oss-history-scan の fixture-path 免除 (grep の --exclude-dir=e2e / git pathspec の e2e 除外) の
 * 対象で、既存 run-hook-replay-e2e.mts と同じ扱い。
 *
 * 実行 (CLI):
 *   INGEST_TOKEN=... pnpm --filter @actradeck/sidecar demo:safety
 *   env で上書き可 (ハードコードしない):
 *     INGEST_TOKEN                 backend ingestion の Bearer トークン (必須)。
 *     ACTRADECK_WS_URL             送信先 backend WS base (既定 ws://127.0.0.1:55410、/ingest/ws は補完)。
 *     ACTRADECK_BACKEND_PORT       backend WS port (既定 55410・ACTRADECK_WS_URL 未指定時)。
 *     ACTRADECK_DEMO_APPROVAL      "hold" | "auto-deny" (既定 hold)。
 *     ACTRADECK_DEMO_APPROVAL_TIMEOUT_MS  承認タイムアウト上書き (正の整数)。
 *     ACTRADECK_DEMO_SESSION_ID    セッション id 上書き (既定 demo-safety-<short>)。
 *     ACTRADECK_DEMO_CWD           使い捨て cwd (既定 /tmp/actradeck-demo)。
 *     ACTRADECK_DEMO_DB            sidecar SQLite パス (既定 temp)。
 */
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

import { resolveWsUrl } from "../src/cli.js";
import { Sidecar } from "../src/sidecar.js";
import { HOOK_TOKEN_HEADER } from "../src/settings-injection.js";
import type { StoredRow } from "../src/store.js";

/** hold / auto-deny の 2 モード。既定は hold (UI が後で Deny を relay する想定)。 */
export type SafetyDemoApprovalMode = "hold" | "auto-deny";

/** hold のとき UI に承認時間を与える既定 timeout (既存の安全側 30s と同値)。 */
export const DEFAULT_HOLD_TIMEOUT_MS = 30_000;
/** auto-deny (CI/ヘッドレス) の既定 timeout。短くして決定論的に安全側 deny へ倒す。 */
export const DEFAULT_AUTO_DENY_TIMEOUT_MS = 1_500;

/** 公開ダミー secret のみ (実在しない・redactor.ts の REDACTION_RULES に合致する形)。 */
export const DEMO_AWS_ACCESS_KEY_ID = "AKIAIOSFODNN7EXAMPLE"; // aws-access-key-id (AKIA + 16 字)
export const DEMO_GITHUB_TOKEN = `ghp_${"DemoFakeSeedT0ken".padEnd(36, "x")}`; // github-token (ghp_ + 36 字)

export interface SafetyDemoOptions {
  /** 送信先 backend ingestion WS (フル URL・/ingest/ws を含む)。既定は cli.resolveWsUrl()。 */
  readonly wsUrl?: string;
  /** backend ingestion の Bearer トークン (env INGEST_TOKEN)。未設定なら backend が 401。 */
  readonly ingestToken?: string;
  /** hold (既定) / auto-deny。 */
  readonly approvalMode?: SafetyDemoApprovalMode;
  /** 承認タイムアウト上書き (ms)。未指定ならモード既定。 */
  readonly approvalTimeoutMs?: number;
  /** デモセッション id。未指定なら demo-safety-<short>。 */
  readonly sessionId?: string;
  /** 使い捨て cwd。未指定なら /tmp/actradeck-demo。 */
  readonly demoCwd?: string;
  /** sidecar SQLite パス。未指定なら temp。 */
  readonly dbPath?: string;
  /** WsClient が backend へ接続するまでの待ち時間 (ms)。未接続なら明示エラー。既定 8s。 */
  readonly connectTimeoutMs?: number;
  /** 進捗ログの吐き先 (既定 console.error)。 */
  readonly onLog?: (msg: string) => void;
}

export interface SafetyDemoResult {
  /** 使い捨てデモセッション id (`demo-safety-<short>`)。削除時のキー。 */
  readonly sessionId: string;
  /** 使い捨て cwd。 */
  readonly demoCwd: string;
  /** sidecar SQLite パス (テストが no-raw を再検証できる)。 */
  readonly dbPath: string;
  /** 承認モード。 */
  readonly approvalMode: SafetyDemoApprovalMode;
  /** 高リスク PreToolUse が受け取った permissionDecision ("deny" 想定)。 */
  readonly approvalDecision: string;
  /**
   * shutdown 前に採取した SQLite 永続行のスナップショット (event_type / event_json)。
   * テストが「生 secret が SQLite に無い」「redaction_count_by_kind が乗る」を再検証する素。
   */
  readonly storedRows: ReadonlyArray<{ event_type: string; event_json: string }>;
}

interface PreToolUseHookOutput {
  hookSpecificOutput?: {
    hookEventName?: string;
    permissionDecision?: string;
    permissionDecisionReason?: string;
  };
}

function shortId(): string {
  return randomBytes(4).toString("hex");
}

function resolveApprovalMode(raw: string | undefined): SafetyDemoApprovalMode {
  return raw === "auto-deny" ? "auto-deny" : "hold";
}

async function postHook(
  endpoint: string,
  body: Record<string, unknown>,
  token: string,
): Promise<PreToolUseHookOutput> {
  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      // blocking hook の socket を teardown 後に再利用させない (単発接続)。
      connection: "close",
      [HOOK_TOKEN_HEADER]: token,
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return (
    text.length > 0 ? (JSON.parse(text) as PreToolUseHookOutput) : {}
  ) as PreToolUseHookOutput;
}

async function waitFor(
  predicate: () => boolean,
  { timeoutMs, stepMs = 25 }: { timeoutMs: number; stepMs?: number },
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

/**
 * 使い捨て Safety Demo セッションを実パイプラインで駆動する。
 *
 * 実 backend が未起動 (connectTimeoutMs 内に WsClient.connected にならない) なら **明示 throw** する
 * (silent skip 禁止・CI guard 流儀)。
 */
export async function runSafetyDemo(opts: SafetyDemoOptions = {}): Promise<SafetyDemoResult> {
  const log = opts.onLog ?? ((m: string) => process.stderr.write(`[safety-demo] ${m}\n`));
  const approvalMode = opts.approvalMode ?? "hold";
  const approvalTimeoutMs =
    opts.approvalTimeoutMs ??
    (approvalMode === "auto-deny" ? DEFAULT_AUTO_DENY_TIMEOUT_MS : DEFAULT_HOLD_TIMEOUT_MS);
  const sessionId = opts.sessionId ?? `demo-safety-${shortId()}`;
  const demoCwd = opts.demoCwd ?? join(tmpdir(), "actradeck-demo");
  const wsUrl = opts.wsUrl ?? resolveWsUrl();
  const ingestToken = opts.ingestToken ?? process.env.INGEST_TOKEN;
  const connectTimeoutMs = opts.connectTimeoutMs ?? 8_000;

  // 使い捨て cwd / SQLite を用意。cwd は非 git (GitWatcher 副作用を避ける・承認/redaction が関心)。
  mkdirSync(demoCwd, { recursive: true });
  const dbDir = mkdtempSync(join(tmpdir(), "actradeck-safety-demo-"));
  const dbPath = opts.dbPath ?? join(dbDir, "sidecar.db");

  const sidecar = new Sidecar({
    sessionId,
    // 外部明示指定 (デモ id) ゆえ即確定モード。全 hook が同一 session_id を載せるため割れない。
    explicitSession: true,
    wsUrl,
    dbPath,
    cwd: demoCwd,
    approvalTimeoutMs,
    ...(ingestToken !== undefined && ingestToken.length > 0 ? { ingestToken } : {}),
  });

  log(`session=${sessionId} mode=${approvalMode} timeout=${approvalTimeoutMs}ms ws=${wsUrl}`);
  const { hookEndpoint } = await sidecar.start();

  try {
    // 実 backend 未起動なら明示エラー (silent skip 禁止)。
    const connected = await waitFor(() => sidecar.wsClient.connected, {
      timeoutMs: connectTimeoutMs,
    });
    if (!connected) {
      throw new Error(
        `backend ingestion WS (${wsUrl}) へ ${connectTimeoutMs}ms 以内に接続できません。` +
          `backend を起動し INGEST_TOKEN を一致させてください (デモは実パイプライン必須)。`,
      );
    }
    log(`connected to backend ingestion WS`);

    // a. SessionStart。
    await postHook(
      hookEndpoint,
      { session_id: sessionId, hook_event_name: "SessionStart", cwd: demoCwd, source: "startup" },
      sidecar.hookAuthToken,
    );

    // b. 高リスク PreToolUse (rm -rf) → 実 approval gate。permission_mode は載せない (= 既定モードで
    //    高リスク破壊操作をゲート。bypassPermissions を載せると defer されゲートが出ない)。
    //    POST は承認が解けるまで blocking (hold=UI/timeout, auto-deny=短 timeout)。
    const dangerousCommand = `rm -rf ${demoCwd}/build`;
    log(`PreToolUse (blocking): ${dangerousCommand}`);
    const gateResp = await postHook(
      hookEndpoint,
      {
        session_id: sessionId,
        hook_event_name: "PreToolUse",
        cwd: demoCwd,
        tool_name: "Bash",
        tool_input: { command: dangerousCommand },
      },
      sidecar.hookAuthToken,
    );
    const approvalDecision = gateResp.hookSpecificOutput?.permissionDecision ?? "unknown";
    log(`approval resolved: permissionDecision=${approvalDecision}`);

    // c. ダミー secret を含むコマンド出力を PostToolUse で流す (非ゲート経路)。
    //    normalizer は PostToolUse(Bash).tool_input.command を payload.command に carry し、
    //    Sink.emit が保存前 redact する (tool_response.stdout は carry されない → command に載せる)。
    const secretCommand = `echo "deploy with ${DEMO_AWS_ACCESS_KEY_ID} and ${DEMO_GITHUB_TOKEN} to staging"`;
    log(`PostToolUse (secret-bearing command output)`);
    await postHook(
      hookEndpoint,
      {
        session_id: sessionId,
        hook_event_name: "PostToolUse",
        cwd: demoCwd,
        tool_name: "Bash",
        tool_input: { command: secretCommand },
        tool_response: { stdout: "", stderr: "", exit_code: 0 },
      },
      sidecar.hookAuthToken,
    );

    // d. Stop / SessionEnd。
    await postHook(
      hookEndpoint,
      { session_id: sessionId, hook_event_name: "Stop", cwd: demoCwd },
      sidecar.hookAuthToken,
    );
    await postHook(
      hookEndpoint,
      { session_id: sessionId, hook_event_name: "SessionEnd", cwd: demoCwd, reason: "other" },
      sidecar.hookAuthToken,
    );

    // すべて backend へ flush されるまで待つ (append-only SQLite の未送信が捌けるまで)。
    // 未送信ゼロを確認してから snapshot + shutdown することで event store 到達を保証する。
    const flushed = await waitFor(() => sidecar.store.unsentCount() === 0, { timeoutMs: 5_000 });
    if (!flushed) {
      log(`warning: ${sidecar.store.unsentCount()} 件が未送信のまま (backend 応答遅延の可能性)`);
    }

    // shutdown が store を close する前に SQLite 永続行を採取 (no-raw 再検証の素)。
    const storedRows: Array<{ event_type: string; event_json: string }> = sidecar.store
      .allRows()
      .map((r: StoredRow) => ({ event_type: r.event_type, event_json: r.event_json }));

    return { sessionId, demoCwd, dbPath, approvalMode, approvalDecision, storedRows };
  } finally {
    await sidecar.shutdown();
  }
}

/** CLI エントリ: env から設定を解決して 1 本走らせ、要約を stderr に出す。 */
async function main(): Promise<void> {
  const approvalMode = resolveApprovalMode(process.env.ACTRADECK_DEMO_APPROVAL);
  const timeoutRaw = process.env.ACTRADECK_DEMO_APPROVAL_TIMEOUT_MS;
  const timeoutParsed = timeoutRaw !== undefined ? Number.parseInt(timeoutRaw, 10) : Number.NaN;
  const approvalTimeoutMs =
    Number.isInteger(timeoutParsed) && timeoutParsed > 0 ? timeoutParsed : undefined;

  const result = await runSafetyDemo({
    approvalMode,
    ...(approvalTimeoutMs !== undefined ? { approvalTimeoutMs } : {}),
    ...(process.env.ACTRADECK_DEMO_SESSION_ID !== undefined &&
    process.env.ACTRADECK_DEMO_SESSION_ID.length > 0
      ? { sessionId: process.env.ACTRADECK_DEMO_SESSION_ID }
      : {}),
    ...(process.env.ACTRADECK_DEMO_CWD !== undefined && process.env.ACTRADECK_DEMO_CWD.length > 0
      ? { demoCwd: process.env.ACTRADECK_DEMO_CWD }
      : {}),
    ...(process.env.ACTRADECK_DEMO_DB !== undefined && process.env.ACTRADECK_DEMO_DB.length > 0
      ? { dbPath: process.env.ACTRADECK_DEMO_DB }
      : {}),
  });

  // 要約 (原文非依存: 件数と kind 名のみ)。redaction_count_by_kind を集計して開示する。
  const byKind = new Map<string, number>();
  for (const row of result.storedRows) {
    try {
      const parsed = JSON.parse(row.event_json) as {
        redaction_count_by_kind?: Record<string, number>;
      };
      for (const [k, v] of Object.entries(parsed.redaction_count_by_kind ?? {})) {
        byKind.set(k, (byKind.get(k) ?? 0) + v);
      }
    } catch {
      /* 壊れ JSON は無視 (要約のみ) */
    }
  }

  process.stderr.write("\n========== ActraDeck SAFETY DEMO ==========\n");
  process.stderr.write(`session_id        : ${result.sessionId}\n`);
  process.stderr.write(`cwd (throwaway)   : ${result.demoCwd}\n`);
  process.stderr.write(`approval mode     : ${result.approvalMode}\n`);
  process.stderr.write(`high-risk decision: ${result.approvalDecision}\n`);
  process.stderr.write(`events persisted  : ${result.storedRows.length}\n`);
  process.stderr.write(
    `redaction by kind : ${
      byKind.size > 0 ? [...byKind.entries()].map(([k, v]) => `${k}=${v}`).join(", ") : "(none)"
    }\n`,
  );
  process.stderr.write("===========================================\n");
}

// tsx で直接起動されたときのみ実行 (import 時は副作用なし)。
if (import.meta.url === `file://${process.argv[1]}`) {
  void main().catch((e: unknown) => {
    process.stderr.write(`[safety-demo] fatal: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(1);
  });
}
