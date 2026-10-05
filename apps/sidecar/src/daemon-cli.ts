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
  assertDaemonStateShape,
  ATTACH_SCOPES,
  type AttachScope,
  canonicalPath,
  type DaemonState,
  isDaemonStateUnchanged,
  readState,
  removeDaemonState,
  removeDaemonStateIfUnchanged,
  scopeArtifacts,
  type ScopeArtifacts,
  writeDaemonState,
} from "./daemon-state.js";
import {
  captureSelfIdentity,
  type IdentitySources,
  isDaemonProcess,
  type ProcessLiveness,
} from "./process-identity.js";
import {
  detachAttachHooks,
  type DetachScope,
  hasActradeckHookInSettings,
  mergeAttachHooks,
  previewAttachHooks,
  type TokenMode,
} from "./settings-merge.js";

export type { AttachScope } from "./daemon-state.js";

/**
 * hook 認証トークンとして使える値か (SEC-ENV-1 ≡ TDA-ENV-4 / SEC-ENV-3・裁定 01a10814)。
 *
 * 受信側 (hook-receiver) はヘッダ値をバイト一致で照合する。HTTP ヘッダとして往復できない値
 * (空白・TAB・前後空白・CR/LF・非 ASCII) は daemon が起動・配線まで済ませても全 hook が 403 になり、
 * 上流 hook 契約では non-2xx は non-blocking ゆえ承認ゲートが黙って外れる (監査 R1 で実測)。
 * 短すぎる値は推測で破れる (ローカル client から数千回/秒・rate limit 無し)。よって構造的な床として
 * **ASCII 英数字と `. _ ~ + / = -` だけ・長さ 32 以上 1024 以下** を要求する。`$` は含めない
 * (上流は header 値の `$VAR` / `${VAR}` を補間し、allowedEnvVars 非列挙なら空文字にするので、literal
 * mode で書いた値が送信時に別の文字列になる)。上限は、検査を通った値が受信側の header 上限で全 hook
 * 431 になるのを防ぐ (20,000 字以上で実測・SEC-ENV-R2-3)。daemon 自前の nonce
 * (`generateHookToken` = 32 バイトの base64url・43 文字) はこの床を満たす。
 */
export function isUsableHookToken(value: string): boolean {
  return /^[A-Za-z0-9._~+/=-]{32,1024}$/.test(value);
}

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
    super(
      'codex は attach 非対応です。Managed 起動 (`./scripts/actradeck codex "<task>"` = 内部 `agentmon codex`) で観測してください。',
    );
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

/** scope の settings path・artifact path・state で受け入れる scope ラベル (args から導出する)。 */
export interface ScopeTarget {
  readonly settingsPath: string;
  readonly artifacts: ScopeArtifacts;
  readonly scopes: readonly AttachScope[];
}

/**
 * args の scope / cwd / home から {@link ScopeTarget} を導出する。state の scope ラベルは、要求した scope と、
 * **同じ物理 settings file** (正規化した path が一致) を指す scope だけを受け入れる (cwd が home のとき
 * project と user は同じ `~/.claude/settings.json` を指し、どちらで起動した daemon もどちらで止められる)。
 */
export function scopeTarget(scope: AttachScope, cwd: string, home: string): ScopeTarget {
  const settingsPath = resolveSettingsPath(scope, cwd, home);
  const artifacts = scopeArtifacts(settingsPath, home);
  const scopes = ATTACH_SCOPES.filter(
    (s) =>
      s === scope ||
      canonicalPath(resolveSettingsPath(s, cwd, home)) === artifacts.canonicalSettingsPath,
  );
  return { settingsPath, artifacts, scopes };
}

/** start 実行の依存注入 (テスト・実機で差し替え)。 */
export interface DaemonRuntime {
  /**
   * 安定 hook endpoint を確立し endpoint を返す daemon を起動する。
   * `hookToken` は daemon が実際に検証に使う nonce (settings へ literal で書くのはこの値)。
   * env override が無ければ daemon が自前採番した hookAuthToken を返すこと。
   * **契約**: `opts.hookToken` が渡されたら daemon はその値で照合し、同じ値を返すこと。env token-mode は
   * この値と CC 側の値が一致することで成立し、runStart は返却値が渡した値と違えば daemon を止めて
   * `denied-env-token-mismatch` を返す (QA-ENV-1 ≡ TDA-ENV-1)。
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
  /**
   * state の pid が記録した daemon かを判定する OS 情報の源 (process-identity.ts)。未提供なら本番の
   * `/proc` / `ps`。test が unknown 等を注入するための口。
   */
  identity?: IdentitySources;
}

/** runStart の拒否 status (すべて deny() を通る)。 */
type DeniedStatus = Extract<StartOutcome["status"], `denied-${string}`>;

export interface StartOutcome {
  readonly status:
    | "started"
    | "already-running"
    | "dry-run"
    | "denied-needs-confirm"
    | "denied-token-leak"
    | "denied-env-token-missing"
    | "denied-hook-token-invalid"
    | "denied-env-token-mismatch";
  readonly hookEndpoint?: string;
  readonly settingsPath: string;
  readonly statePath: string;
  readonly backupPath?: string;
  readonly previewSettings?: unknown;
}

/**
 * start の結果を CLI の終了コードへ写す (TDA-ENV-3 ≡ QA-ENV-4)。拒否はすべて 1 (systemd 等から失敗として
 * 見える)。網羅 switch なので status を足すと型検査がここでの扱いを要求する。
 */
export function startOutcomeExitCode(status: StartOutcome["status"]): 0 | 1 {
  switch (status) {
    case "started":
    case "already-running":
    case "dry-run":
      return 0;
    case "denied-needs-confirm":
    case "denied-token-leak":
    case "denied-env-token-missing":
    case "denied-hook-token-invalid":
    case "denied-env-token-mismatch":
      return 1;
    default: {
      const unreachable: never = status;
      return unreachable;
    }
  }
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
 * scope の settings file (args から導出した path・state の中身からは取らない) の配線を detach する。
 * runStop と拒否経路の後始末 (cleanupStaleWiring) の単一出所。detach 自体は `detachAttachHooks`
 * (withFileLock で直列化・ユーザー hooks は温存) に委ねる。`scope.onlyEndpoint` を渡すとその endpoint を
 * 向く entry だけを外す (runStop は渡さず全 ActraDeck entry を外す)。
 * `detached` は 1 件でも外したか。`remaining` は detach 後 (lock 内で書いた / 読んだ settings) に
 * ActraDeck entry が 1 本でも残っているか (SEC-DC-R2-1)。
 */
function detachWiredSettings(
  settingsPath: string,
  scope: DetachScope = {},
): { detached: boolean; remaining: boolean } {
  const res = detachAttachHooks(settingsPath, undefined, scope);
  return { detached: res.removed, remaining: hasActradeckHookInSettings(res.settings) };
}

/**
 * 配線を外すための停止コマンド (案内文の単一出所・QA-DC-2 ≡ TDA-DC-3)。project / project-local の
 * state は起動したディレクトリの settings に紐づくので、別ディレクトリから打っても届くよう常に `--cwd`
 * を付ける。user scope は cwd に依存しないので付けない。
 */
export function stopCommandHint(scope: AttachScope, cwd: string): string {
  return `agentmon daemon stop --scope ${scope}${scope === "user" ? "" : ` --cwd ${cwd}`}`;
}

/** 拒否経路の後始末の結果 (テストと監査向けに返す・CLI は使わない)。 */
export type StaleCleanup =
  | "no-state"
  | "state-invalid"
  | "alive-untouched"
  | "detached"
  | "detached-entries-remain"
  | "detached-state-changed"
  | "detached-state-rm-failed"
  | "left-needs-confirm"
  | "detach-failed";

/**
 * 拒否経路の後始末 (SEC-ENV-4・task 01a10831-8102)。
 *
 * daemon が crash (SIGKILL 等) で落ちると、settings の hook は死んだ port を向いたまま残る。その port を
 * 別プロセスが bind すると hook payload と token を受け取れる。起動が成功すれば mergeAttachHooks の
 * self-heal が上書きするが、拒否された起動はそこまで進まないので、ここで片付ける。
 *
 * - state の pid が**記録した daemon ではない (stale)** ときだけ動く。判定は `readState` の 1 回の
 *   読み取り (lock の外) と `isDaemonProcess` (pid の生存 + 開始時刻の照合・pid 再利用は stale)。同一性を
 *   確かめられない (unknown) ときは生きているとみなして何もしない。判定の時点で生きている daemon の
 *   state なら何もしない (判定の後に起動した daemon の扱いは下の endpoint 限定と残る穴を参照)。
 * - state が検証できない (corrupt: 壊れた JSON・形の不一致・導出した settings path / scope と整合しない)
 *   ときは pid を信用できないので書かずに `state-invalid` を返し、`daemon stop` を案内する。
 * - 外すのは **stale state に記録された endpoint を向く ActraDeck entry だけ** (`onlyEndpoint`)。
 *   判定の後で同じ scope に別の daemon が起動し、別の endpoint で配線していても、その entry は残る。
 * - state は**判定に使ったバイト列と同じとき**で、かつ detach 後に ActraDeck entry が 1 本も残って
 *   いないときだけ消す (`removeDaemonStateIfUnchanged`)。判定の後で別の daemon が state を書いていたら
 *   消さない。
 * - **残る穴 (実測に bound・R1 unblock の開示)**:
 *   ① 新しい daemon が死んだ daemon と**同じ port** を得て、その endpoint で配線した場合、その entry は
 *   endpoint で区別できず外れる (state の CAS は効くので state は残る)。
 *   ② state の比較と削除の間は原子的でない (lock の外)。比較の直後・削除の直前に別の daemon が state を
 *   書くと、その state を消す (配線は endpoint が違えば残る)。
 *   ③ stale state に記録されていない死んだ entry (別の endpoint の残骸) は外さない。外した後も
 *   ActraDeck entry が残っていれば state を消さず {@link stopCommandHint} を出す (SEC-DC-R2-1) ので、
 *   `daemon stop` か次の成功起動の self-heal で外れる。判定の後に state が書き換わっていた場合は
 *   案内を出さない (CAS が `changed` を返す)。
 *   ④ (実装記録の残余⑧) ただし、判定の後に並走起動した daemon が merge を終え、まだ state を書いていない
 *   間に後始末が走ると (race R1 の形)、その daemon の entry を「残っている」と数えて案内を出す。案内
 *   どおり `daemon stop` を打つと、その時点で state を書き終えたその daemon を止め、全 entry を外す
 *   (daemon だけ動き続けて配線が無い、という半開にはならない・SEC R3 の probe p8 で実測)。
 * - `writeApproved` が false (user / project scope で --yes も confirm の承認も無い) なら書かない。
 *   共有/グローバル settings への書込は confirm ゲート (SEC-1) の対象なので、拒否経路でも同じ線を守り、
 *   残っていることと {@link stopCommandHint} だけをログに出す。state は消さない
 *   (消すと `daemon stop` が配線を見つけられなくなる)。
 * - detach する settings は args から導出した path だけ (state の中身から path を取らない)。当該 scope 以外の
 *   path を記録した state は corrupt として上の `state-invalid` に落ちる。
 * - detach が失敗したら state を残す (`daemon stop` で再試行できる形を保つ)。値はログに出さない。
 */
export function cleanupStaleWiring(opts: {
  readonly statePath: string;
  readonly settingsPath: string;
  readonly scope: AttachScope;
  readonly cwd: string;
  readonly home: string;
  readonly writeApproved: boolean;
  readonly log: (msg: string) => void;
  readonly identity?: IdentitySources;
}): StaleCleanup {
  const target = scopeTarget(opts.scope, opts.cwd, opts.home);
  if (target.settingsPath !== opts.settingsPath || target.artifacts.statePath !== opts.statePath) {
    throw new Error(
      "cleanupStaleWiring: statePath / settingsPath は scope から導出した値を渡すこと",
    );
  }
  const hint = stopCommandHint(opts.scope, opts.cwd);
  const existing = readState(target.artifacts, target.scopes);
  if (existing.kind === "absent") return "no-state";
  if (existing.kind === "corrupt") {
    opts.log(
      `[attach] 前回の daemon の state (${existing.path}) を検証できないため、hook 配線には触れていません。` +
        `外すには \`${hint}\` を実行してください。`,
    );
    return "state-invalid";
  }
  const state = existing.state;
  if (isDaemonProcess(state, opts.identity) !== "dead") return "alive-untouched";
  if (!opts.writeApproved) {
    opts.log(
      `[attach] 前回の daemon (pid=${state.pid}) は終了していますが、その hook 配線 ` +
        `(${opts.settingsPath}) は外されていません。死んだ port を向いたままです。` +
        `外すには \`${hint}\` を実行してください ` +
        `(${opts.scope} scope の設定は --yes か確認の承認なしには書き換えないため、ここでは外しません)。`,
    );
    return "left-needs-confirm";
  }
  let res: { detached: boolean; remaining: boolean };
  try {
    res = detachWiredSettings(opts.settingsPath, { onlyEndpoint: state.endpoint });
  } catch {
    opts.log(
      `[attach] 前回の daemon (pid=${state.pid}) の hook 配線を外せませんでした。` +
        `\`${hint}\` で再試行してください。`,
    );
    return "detach-failed";
  }
  // 実際に外したかで文言を分ける (SEC-DC-R2-2 ≡ QA-DC-R2-1 ≡ TDA-DC-R2-2: 0 本なら「外しました」と言わない)。
  const what =
    `前回の daemon (pid=${state.pid}) の endpoint (${state.endpoint}) を向いた hook 配線` +
    (res.detached ? "を外しました" : "は既に無くなっていました");
  // SEC-DC-R2-1: 記録 endpoint 以外の ActraDeck entry がまだ残るなら state を消さない。消すと
  // `daemon stop` がその配線を見つけられなくなる。判定の後に state が書き換わっていたら (別の daemon が
  // 起動した可能性) 停止案内は出さず、下の CAS 枝に任せる。
  if (res.remaining && isDaemonStateUnchanged(existing.path, existing.raw)) {
    opts.log(
      `[attach] ${what}。ただし ${opts.settingsPath} にはほかの ActraDeck hook 配線が` +
        `残っているため、state は残します。外すには \`${hint}\` を実行してください。`,
    );
    return "detached-entries-remain";
  }
  // remaining かつ state が変わっていた場合も、ここで CAS が "changed" を返すので消さない。
  const removal = removeDaemonStateIfUnchanged(existing.path, existing.raw);
  if (removal === "changed") {
    opts.log(
      `[attach] ${what}。state は判定の後に書き換わっていたため消していません (別の daemon が` +
        `起動した可能性があります)。`,
    );
    return "detached-state-changed";
  }
  if (removal === "rm-failed") {
    opts.log(
      `[attach] ${what}。stale state は削除できませんでした。\`${hint}\` を実行してください。`,
    );
    return "detached-state-rm-failed";
  }
  opts.log(
    `[attach] ${what} (${opts.settingsPath})。daemon は終了していたため ` +
      `stale state を消しました。`,
  );
  return "detached";
}

/**
 * daemon を起動し settings を配線する。
 * - 二重起動防止 (pid の生存と開始時刻の照合・process-identity.ts)。stale / corrupt な state は起動が成功すれば
 *   上書きし、拒否なら deny() の後始末が扱う。
 * - dry-run は preview のみ (daemon 起動・書込なし)。
 * - literal token を settings に書き、state file には **値を記録しない**。
 */
export async function runStart(
  args: DaemonArgs,
  env: { wsUrl: string; dbPath: string; ingestToken?: string; hookToken?: string },
  rt: DaemonRuntime,
): Promise<StartOutcome> {
  const home = rt.home ?? homedir();
  const target = scopeTarget(args.scope, args.cwd, home);
  const { settingsPath, artifacts } = target;
  const statePath = artifacts.statePath;

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

  // SEC-ENV-4: 拒否経路はすべてここを通して返す。stale (pid 死亡) な前回 daemon の配線を片付けてから
  // 返す (判定の時点で生きている daemon には触らない・判定後の並走は cleanupStaleWiring の docstring・
  // confirm が要る scope は承認が無ければ書かず案内だけ)。
  // writeApproved は confirm ゲートを通過した時点で true に上がる。
  let writeApproved = !scopeNeedsConfirm(args.scope) || args.yes;
  const deny = (status: DeniedStatus): StartOutcome => {
    cleanupStaleWiring({
      statePath,
      settingsPath,
      scope: args.scope,
      cwd: args.cwd,
      home,
      writeApproved,
      log: rt.log,
      ...(rt.identity !== undefined ? { identity: rt.identity } : {}),
    });
    return { status, settingsPath, statePath };
  };

  // SEC-2: project scope (tracked `.claude/settings.json`) で literal token-mode は nonce 平文を
  // **commit され共有される file** に着地させる = 秘匿漏洩。tracked file には nonce を書かず、
  // env token-mode ($VAR + allowedEnvVars, 非リテラル) を要求して中止する (daemon 起動・write 前)。
  if (tokenModeLeaksToTrackedFile(args.scope, args.tokenMode)) {
    rt.log(
      `[attach] project scope は tracked file (${settingsPath}) です。literal token-mode は nonce 平文を ` +
        `commit へ漏らすため拒否します。--token-mode env を使うか --scope project-local を選んでください。`,
    );
    return deny("denied-token-leak");
  }

  // SEC-FC-2: env token-mode は settings に値を書かず `$ACTRADECK_HOOK_TOKEN` を参照させる。daemon が
  // 同じ値を知らずに自前の nonce で起動すると、CC 側はその nonce を知りようがなく**全 hook が 403** に
  // なる。上流 hook 契約では non-2xx は non-blocking (ツールはそのまま実行) なので、承認ゲートが黙って
  // 外れる。daemon 起動・settings write の前に値ベースで拒否する (fail-loud・SEC-R3-3 と同じ形)。
  if (args.tokenMode === "env" && (env.hookToken === undefined || env.hookToken.length === 0)) {
    rt.log(
      `[attach] --token-mode env には ACTRADECK_HOOK_TOKEN が必要です (daemon と Claude Code の双方の ` +
        `環境に同じ値を export してください)。未設定のまま起動すると全 hook が認証に失敗し、承認ゲートが ` +
        `働きません。起動を中止します。`,
    );
    return deny("denied-env-token-missing");
  }

  // SEC-ENV-1: 与えられた値 (env mode の必須値・literal mode の上書き値の両方) がヘッダで往復できない /
  // 短すぎるなら、起動しても全 hook が 403 になるか推測で破れる。値は表示しない (NO-RAW)。
  if (
    env.hookToken !== undefined &&
    env.hookToken.length > 0 &&
    !isUsableHookToken(env.hookToken)
  ) {
    rt.log(
      `[attach] ACTRADECK_HOOK_TOKEN の値が使えません (英数字と . _ ~ + / = - のみ・空白なし・32 文字以上が ` +
        `必要です。例: openssl rand -hex 32)。起動を中止します。`,
    );
    return deny("denied-hook-token-invalid");
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
      return deny("denied-needs-confirm");
    }
    writeApproved = true;
  }

  // 二重起動防止。同一性を確かめられない (unknown) ときは生きているとみなす (base 同値・ADR 01a10ddc)。
  // stale / corrupt な state はここでは消さない (下のコメント)。
  const existing = readState(artifacts, target.scopes);
  if (existing.kind === "state") {
    const liveness = isDaemonProcess(existing.state, rt.identity);
    if (liveness !== "dead") {
      rt.log(
        `[attach] 既に稼働中 (pid=${existing.state.pid}, endpoint=${existing.state.endpoint}` +
          `${liveness === "unknown" ? "・同一性は未確認" : ""})`,
      );
      return {
        status: "already-running",
        statePath,
        settingsPath,
        hookEndpoint: existing.state.endpoint,
      };
    }
    // stale state はここでは消さない (SEC-ENV-4)。起動が成功すれば mergeAttachHooks の self-heal と
    // writeDaemonState が上書きし、起動後に拒否 (mismatch) されたら deny() が state を手掛かりに配線を外す。
    // 先に消すと、拒否や startDaemon の失敗で「state だけ失われ配線が残る」(daemon stop で外せない)。
    rt.log(
      `[attach] stale state を検出 (pid=${existing.state.pid} 死亡)。起動に成功したら上書きします。`,
    );
  } else if (existing.kind === "corrupt") {
    // 検証できない state は pid を信用しない。起動に成功したら上書きする (拒否なら deny() は書かずに案内)。
    rt.log(`[attach] state (${existing.path}) を検証できません。起動に成功したら上書きします。`);
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

  // QA-ENV-1 ≡ TDA-ENV-1: env mode では settings に値を書かず、CC は自分の環境の
  // ACTRADECK_HOOK_TOKEN を送る。daemon が別の値 (自前の nonce 等) で照合していると全 hook が 403 に
  // なり承認ゲートが黙って外れるので、起動直後に値で一致を確かめ、違えば daemon を止めて中止する
  // (settings write の前)。runtime 側の受け渡しが壊れても無言の 403 へは戻らず起動失敗になる。
  // ただし CI は cli.ts の本番 runtime を実行しないので、その配線の退行で CI が RED になるわけではない
  // (実プロセスで exit 1 になることを監査 R2 で確認・QA-ENV-R2-3)。
  if (args.tokenMode === "env" && hookToken !== env.hookToken) {
    await daemon.shutdown();
    rt.log(
      `[attach] daemon が ACTRADECK_HOOK_TOKEN と異なる値で起動しました。env token-mode の hook は認証に ` +
        `失敗するため、起動を中止します。`,
    );
    return deny("denied-env-token-mismatch");
  }

  // state file に記録する内容 (**token 値は書かない** — token mode だけ)。読む側と同じ形検証を配線の前に
  // 通す (配線だけ書いて state を書けない経路を作らない)。
  const identity = captureSelfIdentity(rt.identity);
  const state: DaemonState = {
    pid: process.pid,
    endpoint: hookEndpoint,
    scope: args.scope,
    settingsPath: artifacts.canonicalSettingsPath,
    startedAt: new Date().toISOString(),
    tokenMode: args.tokenMode,
    ...(identity !== undefined ? { procIdentity: identity } : {}),
  };
  assertDaemonStateShape(state);

  // settings を非破壊配線 (実 endpoint + daemon が検証に使う実 nonce を書く)。
  const merge = mergeAttachHooks({
    settingsPath,
    endpoint: hookEndpoint,
    tokenMode: args.tokenMode,
    ...(args.tokenMode === "literal" ? { token: hookToken } : {}),
  });

  writeDaemonState(statePath, state);
  // 旧い dist の path で読んだ (stale / corrupt の) state は、新しい path に書いたので消す (判定に使った
  // バイト列と同じときだけ)。残すと、この daemon の state を消した後に旧い state が再び読まれる。
  if (existing.kind !== "absent" && existing.path !== statePath && existing.raw !== undefined) {
    removeDaemonStateIfUnchanged(existing.path, existing.raw);
  }

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

/**
 * runStop が記録 pid に SIGTERM を送ったか (D7)。送るのは記録した daemon と同一だと確かめられたとき
 * (`isDaemonProcess` が alive) だけ。
 * - `sent`: 送った。`send-failed`: 送ろうとして失敗した (その間に終了した等)。
 * - `self`: 記録 pid が自プロセス (呼び元が shutdown する)。
 * - `skipped-dead`: 記録した daemon は終了済み (pid 不在・または pid が別のプロセスに再利用されている)。
 * - `skipped-identity-unknown`: 同一か確かめられない (権限が無い・`/proc` / `ps` が読めない)。送らない。
 * - `skipped-corrupt`: state を検証できず pid を信用できない。送らない。
 * - `no-state`: state が無い。
 */
export type StopKill =
  | "sent"
  | "send-failed"
  | "self"
  | "skipped-dead"
  | "skipped-identity-unknown"
  | "skipped-corrupt"
  | "no-state";

export interface StopOutcome {
  readonly status: "stopped" | "not-running";
  readonly detached: boolean;
  readonly settingsPaths: readonly string[];
  readonly killedPid?: number;
  readonly kill: StopKill;
  /** state を検証できなかった (配線を外し、検証できない state を消した・kill はしない)。 */
  readonly state?: "corrupt-removed";
}

/**
 * daemon を停止し settings から ActraDeck hooks を reversible detach する。
 * 別プロセスの daemon が記録されていて、記録した daemon と同一だと確かめられたときだけ SIGTERM を送る。
 * detach する settings は args から導出した path (state の中身からは取らない)。state を検証できない
 * (corrupt) ときは pid を信用せず、配線を外して state を消し、signal は送らない。
 */
export function runStop(args: DaemonArgs, rt: DaemonRuntime): StopOutcome {
  const home = rt.home ?? homedir();
  const target = scopeTarget(args.scope, args.cwd, home);
  const { settingsPath } = target;
  const read = readState(target.artifacts, target.scopes);
  if (read.kind === "absent") {
    rt.log(`[attach] 稼働中の daemon がありません (${target.artifacts.statePath})`);
    return { status: "not-running", detached: false, settingsPaths: [], kill: "no-state" };
  }

  // 配線済み settings を detach (ユーザー hooks は温存)。
  const { detached } = detachWiredSettings(settingsPath);

  if (read.kind === "corrupt") {
    removeDaemonState(read.path);
    rt.log(
      `[attach] state (${read.path}) を検証できないため pid には signal を送っていません。` +
        `hook 配線を外し、state を消しました。daemon がまだ動いていれば手動で止めてください。`,
    );
    return {
      status: "stopped",
      detached,
      settingsPaths: [settingsPath],
      kill: "skipped-corrupt",
      state: "corrupt-removed",
    };
  }

  // 別プロセスの daemon を停止 (自プロセスなら呼び元が shutdown)。同一性を確かめてから送る。
  const state = read.state;
  let kill: StopKill;
  if (state.pid === process.pid) {
    kill = "self";
  } else {
    const liveness: ProcessLiveness = isDaemonProcess(state, rt.identity);
    if (liveness === "alive") {
      try {
        process.kill(state.pid, "SIGTERM");
        kill = "sent";
      } catch {
        kill = "send-failed";
      }
    } else {
      kill = liveness === "dead" ? "skipped-dead" : "skipped-identity-unknown";
    }
  }
  if (kill === "skipped-identity-unknown") {
    rt.log(
      `[attach] pid=${state.pid} が記録した daemon と同一か確かめられないため、signal は送っていません。` +
        `daemon がまだ動いていれば手動で止めてください。`,
    );
  }

  removeDaemonState(read.path);
  rt.log(`[attach] daemon 停止 + detach (settings 1 件復元)`);
  return {
    status: "stopped",
    detached,
    settingsPaths: [settingsPath],
    kill,
    ...(kill === "sent" ? { killedPid: state.pid } : {}),
  };
}

export interface StatusOutcome {
  readonly running: boolean;
  readonly state?: DaemonState;
  readonly statePath: string;
  /** state の pid が記録した daemon か (state があるときだけ)。 */
  readonly liveness?: ProcessLiveness;
  /** state を検証できなかった。 */
  readonly corrupt?: boolean;
}

/** daemon の稼働状態を返す (status 表示)。同一性を確かめられない (unknown) ときは稼働中として表示する。 */
export function runStatus(args: DaemonArgs, rt: DaemonRuntime): StatusOutcome {
  const home = rt.home ?? homedir();
  const target = scopeTarget(args.scope, args.cwd, home);
  const statePath = target.artifacts.statePath;
  const read = readState(target.artifacts, target.scopes);
  if (read.kind === "absent") {
    rt.log(`[attach] daemon は稼働していません (${statePath})`);
    return { running: false, statePath };
  }
  if (read.kind === "corrupt") {
    rt.log(
      `[attach] state (${read.path}) を検証できません。\`${stopCommandHint(args.scope, args.cwd)}\` で` +
        `配線を外し state を消せます。`,
    );
    return { running: false, statePath, corrupt: true };
  }
  const state = read.state;
  const liveness = isDaemonProcess(state, rt.identity);
  if (liveness !== "dead") {
    rt.log(
      `[attach] 稼働中 pid=${state.pid} endpoint=${state.endpoint} ` +
        `scope=${state.scope} since=${state.startedAt}${liveness === "unknown" ? " (同一性は未確認)" : ""}`,
    );
    return { running: true, state, statePath, liveness };
  }
  rt.log(`[attach] stale state (pid=${state.pid} 死亡)。daemon は稼働していません。`);
  return { running: false, state, statePath, liveness };
}
