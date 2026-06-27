/**
 * daemon-cli — `agentmon daemon start|stop|status` / `agentmon attach` の制御ロジック
 * (ADR 019ea476 D1)。CLI 引数のパースと、daemon lifecycle + settings 配線/解除 + state file を結ぶ。
 *
 * これは I/O オーケストレーションの薄い層。純ロジック (scope 解決・引数パース) は export して
 * テスト可能にし、実 daemon 起動 (常駐ループ) は startDaemon が担う。
 */
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { AttachDaemon } from "./attach-daemon.js";
import {
  checkExistingDaemon,
  type DaemonState,
  readDaemonState,
  removeDaemonState,
  stateFilePath,
  writeDaemonState,
} from "./daemon-state.js";
import {
  detachAttachHooks,
  HOOK_TOKEN_ENV_VAR,
  mergeAttachHooks,
  previewAttachHooks,
  type TokenMode,
} from "./settings-merge.js";

export type AttachScope = "project-local" | "project" | "user";

export interface DaemonArgs {
  /** start | stop | status (attach は start に正規化済)。 */
  readonly action: "start" | "stop" | "status";
  readonly scope: AttachScope;
  readonly cwd: string;
  readonly dryRun: boolean;
  readonly yes: boolean;
  readonly tokenMode: TokenMode;
}

/** codex は attach 非対応 (ADR D5)。CLI でこのエラーを投げる。 */
export class CodexAttachUnsupportedError extends Error {
  constructor() {
    super("codex は attach 非対応です。managed mode (`agentmon codex`) で観測してください。");
    this.name = "CodexAttachUnsupportedError";
  }
}

/**
 * `agentmon daemon <action> [flags]` / `agentmon attach [flags]` の引数をパースする。
 * argv は process.argv.slice(2) 相当 (先頭が "daemon" | "attach")。
 *
 * @throws CodexAttachUnsupportedError provider に codex を指定したとき。
 */
export function parseDaemonArgs(argv: readonly string[], cwd: string = process.cwd()): DaemonArgs {
  const head = argv[0];
  let action: DaemonArgs["action"];
  let rest: readonly string[];
  if (head === "attach") {
    action = "start"; // attach = daemon start の別名 (ADR D1)。
    rest = argv.slice(1);
  } else if (head === "daemon") {
    const sub = argv[1];
    if (sub !== "start" && sub !== "stop" && sub !== "status") {
      throw new Error(`agentmon daemon: 未対応のサブコマンド "${sub ?? ""}" (start|stop|status)`);
    }
    action = sub;
    rest = argv.slice(2);
  } else {
    throw new Error(`parseDaemonArgs: 先頭は daemon|attach のみ (got "${head ?? ""}")`);
  }

  let scope: AttachScope = "project-local";
  let dryRun = false;
  let yes = false;
  let tokenMode: TokenMode = "literal";
  let cwdArg = cwd;

  for (let i = 0; i < rest.length; i += 1) {
    const a = rest[i];
    switch (a) {
      case "--scope": {
        const v = rest[++i];
        if (v !== "project-local" && v !== "project" && v !== "user") {
          throw new Error(`--scope は project-local|project|user (got "${v ?? ""}")`);
        }
        scope = v;
        break;
      }
      case "--cwd": {
        const v = rest[++i];
        if (v === undefined) throw new Error("--cwd に値が必要です");
        cwdArg = v;
        break;
      }
      case "--token-mode": {
        const v = rest[++i];
        if (v !== "literal" && v !== "env") {
          throw new Error(`--token-mode は literal|env (got "${v ?? ""}")`);
        }
        tokenMode = v;
        break;
      }
      case "--dry-run":
        dryRun = true;
        break;
      case "--yes":
        yes = true;
        break;
      // codex を attach に渡す経路を明示エラー化 (ADR D5)。
      case "codex":
        throw new CodexAttachUnsupportedError();
      default:
        // 余分な provider 指定 (claude は黙認、それ以外は拒否)。
        if (a === "claude") break;
        throw new Error(`agentmon daemon/attach: 未知の引数 "${a ?? ""}"`);
    }
  }

  return { action, scope, cwd: resolve(cwdArg), dryRun, yes, tokenMode };
}

/**
 * scope から配線対象の settings file 絶対パスを解決する (ADR D2)。
 * - project-local: <cwd>/.claude/settings.local.json (gitignore 対象, 既定)。
 * - project:       <cwd>/.claude/settings.json (共有)。
 * - user:          ~/.claude/settings.json (高リスク)。
 */
export function resolveSettingsPath(
  scope: AttachScope,
  cwd: string,
  home: string = homedir(),
): string {
  switch (scope) {
    case "project-local":
      return join(cwd, ".claude", "settings.local.json");
    case "project":
      return join(cwd, ".claude", "settings.json");
    case "user":
      return join(home, ".claude", "settings.json");
  }
}

/** start 実行の依存注入 (テスト・実機で差し替え)。 */
export interface DaemonRuntime {
  /**
   * 安定 hook endpoint を確立し endpoint を返す daemon を起動する。
   * `hookToken` は daemon が実際に検証に使う nonce (settings へ literal で書くのはこの値)。
   * env override が無ければ daemon が自前採番した hookAuthToken を返すこと。
   */
  startDaemon: (opts: {
    wsUrl: string;
    dbPath: string;
    ingestToken?: string;
    hookToken?: string;
    tokenMode: TokenMode;
  }) => Promise<{ daemon: AttachDaemon; hookEndpoint: string; hookToken: string }>;
  log: (msg: string) => void;
  home?: string;
  /**
   * SEC-1: user/project scope (= 共有/グローバル設定 write) の確認プロンプト。
   * 戻り値 true で続行、false で中止。未提供 (CLI 既定) なら **安全側 deny** に倒す
   * (security.md: 承認は ask/deny 安全側。--yes が無ければ高リスク write を自動実行しない)。
   */
  confirm?: (message: string) => boolean | Promise<boolean>;
}

export interface StartOutcome {
  readonly status:
    | "started"
    | "already-running"
    | "dry-run"
    | "denied-needs-confirm"
    | "denied-token-leak";
  readonly hookEndpoint?: string;
  readonly settingsPath: string;
  readonly statePath: string;
  readonly backupPath?: string;
  readonly previewSettings?: unknown;
}

/** scope が高リスク (共有/グローバル設定 write) で確認を要するか。 */
export function scopeNeedsConfirm(scope: AttachScope): boolean {
  return scope === "user" || scope === "project";
}

/**
 * SEC-2: scope が git-tracked file に着地し literal nonce を平文で残すか。
 * project scope (`.claude/settings.json`) は **commit され他開発者と共有**されるため、
 * literal token-mode で nonce 平文を書くと tracked file に秘匿が漏れる。
 * project-local (`settings.local.json`, gitignore) と user (`~/.claude`, repo 外) は対象外。
 */
export function tokenModeLeaksToTrackedFile(scope: AttachScope, tokenMode: TokenMode): boolean {
  return scope === "project" && tokenMode === "literal";
}

/**
 * daemon を起動し settings を配線する。
 * - 二重起動防止 (pid 生存)。stale は掃除。
 * - dry-run は preview のみ (daemon 起動・書込なし)。
 * - literal token を settings に書き、state file には **値を記録しない**。
 */
export async function runStart(
  args: DaemonArgs,
  env: { wsUrl: string; dbPath: string; ingestToken?: string; hookToken?: string },
  rt: DaemonRuntime,
): Promise<StartOutcome> {
  const home = rt.home ?? homedir();
  const settingsPath = resolveSettingsPath(args.scope, args.cwd, home);
  const statePath = stateFilePath(settingsPath, home);

  if (args.dryRun) {
    // dry-run は daemon を起動しないため endpoint/token はプレースホルダ。書き込まない。
    const preview = previewAttachHooks({
      settingsPath,
      endpoint: "http://127.0.0.1:<port>/hook",
      tokenMode: args.tokenMode,
      ...(args.tokenMode === "literal"
        ? { token: env.hookToken ?? "<nonce-assigned-on-start>" }
        : {}),
    });
    rt.log(`[attach] dry-run: ${settingsPath} に ${preview.events.length} hooks を配線予定`);
    return { status: "dry-run", settingsPath, statePath, previewSettings: preview.settings };
  }

  // SEC-2: project scope (tracked `.claude/settings.json`) で literal token-mode は nonce 平文を
  // **commit され共有される file** に着地させる = 秘匿漏洩。tracked file には nonce を書かず、
  // env token-mode ($VAR + allowedEnvVars, 非リテラル) を要求して中止する (daemon 起動・write 前)。
  if (tokenModeLeaksToTrackedFile(args.scope, args.tokenMode)) {
    rt.log(
      `[attach] project scope は tracked file (${settingsPath}) です。literal token-mode は nonce 平文を ` +
        `commit へ漏らすため拒否します。--token-mode env を使うか --scope project-local を選んでください。`,
    );
    return { status: "denied-token-leak", settingsPath, statePath };
  }

  // SEC-1: user/project scope は共有/グローバル設定への write = 高リスク。--yes も
  // confirm() の承認も無ければ **安全側 deny** で中止する (daemon 起動・write をしない)。
  // project-local (gitignore 既定) は従来どおり無確認。security.md: 承認は ask/deny 安全側。
  if (scopeNeedsConfirm(args.scope) && !args.yes) {
    const approved = rt.confirm
      ? await rt.confirm(
          `${args.scope} scope は共有/グローバル設定 (${settingsPath}) を変更します。続行しますか?`,
        )
      : false; // 既定 deny (非対話/フラグ無し時は自動実行しない)。
    if (!approved) {
      rt.log(
        `[attach] ${args.scope} scope の設定変更は確認が必要です。--yes を付けるか確認に応じてください ` +
          `(deny で中止: ${settingsPath} は未変更)。`,
      );
      return { status: "denied-needs-confirm", settingsPath, statePath };
    }
  }

  // 二重起動防止 + stale 掃除。
  const existing = checkExistingDaemon(statePath);
  if (existing.alive) {
    rt.log(
      `[attach] 既に稼働中 (pid=${existing.state?.pid}, endpoint=${existing.state?.endpoint})`,
    );
    return {
      status: "already-running",
      statePath,
      settingsPath,
      ...(existing.state?.endpoint !== undefined ? { hookEndpoint: existing.state.endpoint } : {}),
    };
  }
  if (existing.stale) {
    rt.log(`[attach] stale state を掃除 (pid=${existing.state?.pid} 死亡)`);
    removeDaemonState(statePath);
  }

  // daemon を起動して安定 endpoint (OS 割当 port) と実 nonce を得る。
  const { daemon, hookEndpoint, hookToken } = await rt.startDaemon({
    wsUrl: env.wsUrl,
    dbPath: env.dbPath,
    ...(env.ingestToken !== undefined ? { ingestToken: env.ingestToken } : {}),
    ...(env.hookToken !== undefined && env.hookToken.length > 0
      ? { hookToken: env.hookToken }
      : {}),
    tokenMode: args.tokenMode,
  });
  void daemon; // 常駐ループは呼び元 (CLI main) が保持。

  // settings を非破壊配線 (実 endpoint + daemon が検証に使う実 nonce を書く)。
  const merge = mergeAttachHooks({
    settingsPath,
    endpoint: hookEndpoint,
    tokenMode: args.tokenMode,
    ...(args.tokenMode === "literal" ? { token: hookToken } : {}),
  });

  // state file を 0600 で記録 (**token 値は書かない** — env-mode は変数名のみ)。
  const state: DaemonState = {
    pid: process.pid,
    endpoint: hookEndpoint,
    ...(args.tokenMode === "env" ? { hookTokenEnvVar: HOOK_TOKEN_ENV_VAR } : {}),
    wiredSettingsPaths: [settingsPath],
    scope: args.scope,
    startedAt: new Date().toISOString(),
  };
  writeDaemonState(statePath, state);

  rt.log(
    `[attach] daemon 起動 pid=${process.pid} endpoint=${hookEndpoint} scope=${args.scope} ` +
      `settings=${settingsPath}${merge.backupPath ? ` backup=${merge.backupPath}` : ""}`,
  );
  return {
    status: "started",
    hookEndpoint,
    settingsPath,
    statePath,
    ...(merge.backupPath !== undefined ? { backupPath: merge.backupPath } : {}),
  };
}

export interface StopOutcome {
  readonly status: "stopped" | "not-running";
  readonly detached: boolean;
  readonly settingsPaths: readonly string[];
  readonly killedPid?: number;
}

/**
 * daemon を停止し settings から ActraDeck hooks を reversible detach する。
 * 別プロセスの daemon が記録されていれば SIGTERM で停止を試みる。
 */
export function runStop(args: DaemonArgs, rt: DaemonRuntime): StopOutcome {
  const home = rt.home ?? homedir();
  const settingsPath = resolveSettingsPath(args.scope, args.cwd, home);
  const statePath = stateFilePath(settingsPath, home);
  const state = readDaemonState(statePath);
  if (state === undefined) {
    rt.log(`[attach] 稼働中の daemon がありません (${statePath})`);
    return { status: "not-running", detached: false, settingsPaths: [] };
  }

  // 配線済み settings をすべて detach (ユーザー hooks は温存)。
  let detached = false;
  for (const p of state.wiredSettingsPaths) {
    const res = detachAttachHooks(p);
    if (res.removed) detached = true;
  }

  // 別プロセスの daemon を停止 (自プロセスなら呼び元が shutdown)。
  let killedPid: number | undefined;
  if (state.pid !== process.pid) {
    try {
      process.kill(state.pid, "SIGTERM");
      killedPid = state.pid;
    } catch {
      /* 既に死亡 (stale) → state 削除のみ */
    }
  }

  removeDaemonState(statePath);
  rt.log(`[attach] daemon 停止 + detach (settings ${state.wiredSettingsPaths.length} 件復元)`);
  return {
    status: "stopped",
    detached,
    settingsPaths: state.wiredSettingsPaths,
    ...(killedPid !== undefined ? { killedPid } : {}),
  };
}

export interface StatusOutcome {
  readonly running: boolean;
  readonly state?: DaemonState;
  readonly statePath: string;
}

/** daemon の稼働状態を返す (status 表示)。 */
export function runStatus(args: DaemonArgs, rt: DaemonRuntime): StatusOutcome {
  const home = rt.home ?? homedir();
  const settingsPath = resolveSettingsPath(args.scope, args.cwd, home);
  const statePath = stateFilePath(settingsPath, home);
  const existing = checkExistingDaemon(statePath);
  if (existing.alive && existing.state) {
    rt.log(
      `[attach] 稼働中 pid=${existing.state.pid} endpoint=${existing.state.endpoint} ` +
        `scope=${existing.state.scope} since=${existing.state.startedAt}`,
    );
    return { running: true, state: existing.state, statePath };
  }
  if (existing.stale) {
    rt.log(`[attach] stale state (pid=${existing.state?.pid} 死亡)。daemon は稼働していません。`);
  } else {
    rt.log(`[attach] daemon は稼働していません (${statePath})`);
  }
  return existing.state !== undefined
    ? { running: false, state: existing.state, statePath }
    : { running: false, statePath };
}
