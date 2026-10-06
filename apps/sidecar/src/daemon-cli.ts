/**
 * daemon-cli — `agentmon daemon start|stop|status` / `agentmon attach` の制御ロジック
 * (ADR 019ea476 D1)。CLI 引数のパースと、daemon lifecycle + settings 配線/解除 + state file を結ぶ。
 *
 * これは I/O オーケストレーションの薄い層。純ロジック (scope 解決・引数パース) は export して
 * テスト可能にし、実 daemon 起動 (常駐ループ) は startDaemon が担う。
 */
import { homedir } from "node:os";
import { resolve } from "node:path";

import { AttachDaemon } from "./attach-daemon.js";
import {
  assertIssuedScopeTarget,
  ScopeLockUnavailableError,
  scopeTarget,
  type ScopeTarget,
  withScopeLock,
} from "./attach-scope.js";
import {
  expectedStateOf,
  inspectStaleWiring,
  type StateTeardown,
  teardownWiring,
  type TokenTeardown,
  type WiringEntries,
  type WiringInspection,
} from "./attach-teardown.js";
import {
  assertDaemonStateShape,
  type AttachScope,
  type DaemonState,
  readState,
  removeDaemonStateIfUnchanged,
  scopeArtifacts,
  writeDaemonState,
} from "./daemon-state.js";
import {
  captureSelfIdentity,
  type IdentitySources,
  isDaemonProcess,
  type ProcessLiveness,
} from "./process-identity.js";
import {
  type ClaudeSettingsFile,
  mergeAttachHooks,
  previewAttachHooks,
  readSettingsForInspection,
  type TokenMode,
} from "./settings-merge.js";

export type { AttachScope } from "./daemon-state.js";
// scope の対象と scope lock は attach-scope.ts が単一出所 (PR-B2 で移した・既存の import 先を保つ)。
export {
  resolveSettingsPath,
  ScopeLockUnavailableError,
  scopeTarget,
  type ScopeTarget,
  withScopeLock,
} from "./attach-scope.js";

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
export type DeniedStatus =
  | "denied-needs-confirm"
  | "denied-token-leak"
  | "denied-env-token-missing"
  | "denied-hook-token-invalid"
  | "denied-env-token-mismatch";

interface StartOutcomeFields {
  readonly hookEndpoint?: string;
  readonly settingsPath: string;
  readonly statePath: string;
  readonly backupPath?: string;
  readonly previewSettings?: unknown;
}

/** 拒否以外の start の結果。`cleanup` を持たない (終了コードは `cleanup` の有無 = union の所属で決まる)。 */
export interface ProceededOutcome extends StartOutcomeFields {
  readonly status: "started" | "already-running" | "dry-run";
  readonly cleanup?: never;
}

/**
 * 拒否された start の結果 (ADR 01a10ddb D4)。`cleanup` は**必須**で、{@link StaleCleanup} は daemon-cli.ts の
 * module の外では {@link cleanupStaleWiring} の戻り値としてしか得られない (brand・module 内の `cleanupResult`
 * は例外・SEC-TD-3)。よって deny() を通さず直に返す拒否は型検査 (`tsc -p tsconfig.test.json`・CI の
 * type-check) で落ちる (TDA-DC-2: 規約頼みだった後始末を型の床にする)。
 * **限界 (SEC-TD-R2-4 (a))**: module の外でも暗黙の any を経由すると `cleanup` を埋めて直に返せる。
 * 例: `JSON.parse` の戻り値の項目を `cleanup` に入れた `DeniedOutcome` のリテラルは `tsc -p tsconfig.test.json`
 * も eslint も通る (実測)。床が止めるのは型の付いた値で書いた直 return だけ。
 */
export interface DeniedOutcome extends StartOutcomeFields {
  readonly status: DeniedStatus;
  readonly cleanup: StaleCleanup;
}

export type StartOutcome = ProceededOutcome | DeniedOutcome;

type IsTrue<T extends true> = T;
/**
 * 型床 (D4): `denied-` で始まる status は {@link DeniedOutcome} にしか置けない。拒否を別の union member
 * (cleanup を持たない形) や {@link ProceededOutcome} の status に足すと、ここが型エラーになる。
 * **綴りに依存する** (`denied-` で始まらない拒否は検査しない・TDA-TD-6)。終了コードはこの floor ではなく
 * union の所属から導出する ({@link startOutcomeExitCode})。test がこの型を参照するので、削除は型検査で落ちる。
 */
export type DeniedStatusFloor = IsTrue<
  [Extract<Exclude<StartOutcome, DeniedOutcome>["status"], `denied-${string}`>] extends [never]
    ? true
    : false
>;

/** 拒否の結果か (union の所属: 後始末の結果 `cleanup` を持つのは {@link DeniedOutcome} だけ)。 */
export function isDeniedOutcome(outcome: StartOutcome): outcome is DeniedOutcome {
  return outcome.cleanup !== undefined;
}

/**
 * start の結果を CLI の終了コードへ写す (TDA-ENV-3 ≡ QA-ENV-4)。拒否 ({@link DeniedOutcome}) はすべて 1
 * (systemd 等から失敗として見える)・それ以外は 0。status の綴りではなく union の所属で決める
 * (TDA-TD-6 ≡ QA-TD-4・裁定 01a11052 ⑤): 拒否は cleanup を必須に持つ型にしか置けないので、新しい拒否 status
 * も自動的に 1 になる。
 */
export function startOutcomeExitCode(outcome: StartOutcome): 0 | 1 {
  return isDeniedOutcome(outcome) ? 1 : 0;
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
 * 配線を外すための停止コマンド (案内文の単一出所・QA-DC-2 ≡ TDA-DC-3)。project / project-local の
 * state は起動したディレクトリの settings に紐づくので、別ディレクトリから打っても届くよう常に `--cwd`
 * を付ける。user scope は cwd に依存しないので付けない。
 */
export function stopCommandHint(scope: AttachScope, cwd: string): string {
  return `agentmon daemon stop --scope ${scope}${scope === "user" ? "" : ` --cwd ${cwd}`}`;
}

/**
 * 拒否経路の後始末の結果の値 (テストと監査向けに返す・CLI は使わない)。`detached-*` は teardownWiring の
 * state / token file の結果に対応する (`detached-entries-remain` = kept-entries-remain・`detached-state-changed`
 * = changed・`detached-state-absent` = absent・`detached-state-rm-failed` = rm-failed・
 * `detached-token-rm-failed` = state は消せたが token file を消せなかった)。`detached-entries-remain` は記録
 * endpoint 以外の ActraDeck entry (記録外の死骸か、lock を共有しない daemon の配線) が残ったとき、
 * `detached-state-changed` / `detached-state-absent` は判定の後に state が書き換わった / 消えたとき、
 * `*-rm-failed` は削除に失敗したとき。`lock-unavailable` は scope lock を取得できず何も確かめていない
 * (settings にも state にも触っていない)。
 */
export type StaleCleanupKind =
  | "no-state"
  | "state-invalid"
  | "alive-untouched"
  | "detached"
  | "detached-entries-remain"
  | "detached-state-changed"
  | "detached-state-absent"
  | "detached-state-rm-failed"
  | "detached-token-rm-failed"
  | "left-needs-confirm"
  | "detach-failed"
  | "lock-unavailable";

declare const staleCleanupBrand: unique symbol;
/**
 * 後始末の結果 ({@link StaleCleanupKind} に brand を付けた型)。daemon-cli.ts の module の外では
 * {@link cleanupStaleWiring} の戻り値としてしか得られず、リテラルを直に書いても型が合わない
 * ({@link DeniedOutcome} の型床・ADR 01a10ddb D4)。module の中では `cleanupResult` でも作れる (SEC-TD-3)。
 * 値は文字列のまま。
 */
export type StaleCleanup = StaleCleanupKind & { readonly [staleCleanupBrand]: true };

const cleanupResult = (kind: StaleCleanupKind): StaleCleanup => kind as StaleCleanup;

/** scope の state を読み、配線の状態を判定する (読み取りは readState 1 本・判定は inspectStaleWiring 1 本)。 */
function inspectScope(
  target: ScopeTarget,
  identity: IdentitySources | undefined,
  settings?: ClaudeSettingsFile,
): WiringInspection {
  return inspectStaleWiring({
    read: readState(target.artifacts, target.scopes),
    settings,
    isDaemonProcess: (s) => isDaemonProcess(s, identity),
  });
}

/**
 * 拒否経路の後始末 (SEC-ENV-4・task 01a10831-8102・scope lock の下で行う = ADR 01a10ddb D1 / D4)。
 *
 * daemon が crash (SIGKILL 等) で落ちると、settings の hook は死んだ port を向いたまま残る。その port を
 * 別プロセスが bind すると hook payload と token を受け取れる。起動が成功すれば lock2 の merge の self-heal が
 * 上書きするが、拒否された起動と起動の失敗 (startDaemon の throw) はそこまで進まないので、ここで片付ける。
 *
 * - **scope lock** (attach-scope の withScopeLock) を取ってから判定と除去を行う。runStart の lock2 (merge +
 *   state 書込) も同じ lock の下なので、同じ HOME・同じ path から lock を取る daemon が判定の後に配線・state を
 *   書くことはない。lock を取得できなければ何も確かめずに `lock-unavailable` を返す (throw しない)。
 * - 判定は attach-teardown の `inspectStaleWiring` (runStop / runStatus / runStart と共有) と
 *   `isDaemonProcess` (pid の生存 + 開始時刻の照合・pid 再利用は stale)。state が**記録した daemon ではない
 *   (stale)** ときだけ動く。同一性を確かめられない (unknown) ときは生きているとみなして何もしない。
 * - state が検証できない (corrupt) ときは pid を信用できないので書かずに `state-invalid` を返し、`daemon stop` を
 *   案内する。
 * - 外すのは attach-teardown の `teardownWiring` (detach → state → token file の唯一の手順) で、範囲は
 *   **stale state に記録された endpoint を向く ActraDeck entry だけ** (`{ kind: "endpoint" }`・裁定 01a110b2)。
 *   lock を共有しない daemon (別 HOME・別 path・旧い版) の生きた配線は別の endpoint なので残る。
 * - state は**判定に使ったバイト列と同じとき**で、かつ detach の後に読み直した settings に ActraDeck entry が
 *   1 本も残っていないときだけ消す (teardownWiring の R2 ガード・裁定 01a11052 ①)。残っていれば state を残して
 *   {@link stopCommandHint} を出す (`detached-entries-remain`)。
 * - `writeApproved` が false (user / project scope で --yes も confirm の承認も無い) なら書かない。
 *   共有/グローバル settings への書込は confirm ゲート (SEC-1) の対象なので、拒否経路でも同じ線を守り、
 *   残っていることと {@link stopCommandHint} だけをログに出す。state は消さない
 *   (消すと `daemon stop` が配線を見つけられなくなる)。
 * - detach する settings と消す state / token file は {@link scopeTarget} が導出した path だけ (state の中身
 *   から path を取らない)。発行していない target (spread で path を差し替えた複製等) は入口で throw する。
 * - detach が失敗したら state も token file も残す (`daemon stop` で再試行できる形を保つ)。値はログに出さない。
 * - token file の削除に失敗したら、state の結果がどの値でもログに書く (SEC-TD-4)。
 * - **残る穴 (開示・base 同値)**: stale state に記録されていない死んだ entry (別 endpoint の残骸) は外さない。
 *   残っていれば state を残して案内するので、`daemon stop` (範囲は全 ActraDeck entry) か次の成功起動の
 *   self-heal で外れる。lock を共有しない daemon が配線を持つ間に案内どおり `daemon stop` を打つと、その
 *   daemon の配線も外れる (stop は利用者が明示した全外し)。
 */
export function cleanupStaleWiring(opts: {
  readonly target: ScopeTarget;
  readonly writeApproved: boolean;
  readonly log: (msg: string) => void;
  readonly identity?: IdentitySources;
}): StaleCleanup {
  const { target } = opts;
  assertIssuedScopeTarget(target);
  try {
    return withScopeLock(target, () => cleanupLocked(opts));
  } catch (err) {
    if (!(err instanceof ScopeLockUnavailableError)) throw err;
    opts.log(
      `[attach] scope lock (${target.artifacts.lockPath}) を取得できなかったため、前回の daemon の hook 配線は` +
        `確認していません。同じ scope の attach / daemon コマンドが終わってから ` +
        `\`${stopCommandHint(target.scope, target.cwd)}\` か \`agentmon daemon status\` で確認してください。`,
    );
    return cleanupResult("lock-unavailable");
  }
}

/** {@link cleanupStaleWiring} の本体 (scope lock の中で呼ぶ)。 */
function cleanupLocked(opts: {
  readonly target: ScopeTarget;
  readonly writeApproved: boolean;
  readonly log: (msg: string) => void;
  readonly identity?: IdentitySources;
}): StaleCleanup {
  const { target } = opts;
  const hint = stopCommandHint(target.scope, target.cwd);
  const inspection = inspectScope(target, opts.identity);
  if (inspection.kind === "no-state") return cleanupResult("no-state");
  if (inspection.kind === "corrupt") {
    opts.log(
      `[attach] 前回の daemon の state (${inspection.path}) を検証できないため、hook 配線には触れていません。` +
        `外すには \`${hint}\` を実行してください。`,
    );
    return cleanupResult("state-invalid");
  }
  if (inspection.kind === "alive") return cleanupResult("alive-untouched");
  const { state } = inspection;
  if (!opts.writeApproved) {
    opts.log(
      `[attach] 前回の daemon (pid=${state.pid}) は終了していますが、その hook 配線 ` +
        `(${target.settingsPath}) は外されていません。死んだ port を向いたままです。` +
        `外すには \`${hint}\` を実行してください ` +
        `(${target.scope} scope の設定は --yes か確認の承認なしには書き換えないため、ここでは外しません)。`,
    );
    return cleanupResult("left-needs-confirm");
  }
  const td = teardownWiring({
    target,
    expected: expectedStateOf(target, inspection),
    range: { kind: "endpoint", endpoint: state.endpoint },
  });
  if (td.kind === "detach-failed") {
    opts.log(
      `[attach] 前回の daemon (pid=${state.pid}) の hook 配線を外せませんでした。` +
        `\`${hint}\` で再試行してください。`,
    );
    return cleanupResult("detach-failed");
  }
  // 実際に外したかで文言を分ける (SEC-DC-R2-2 ≡ QA-DC-R2-1 ≡ TDA-DC-R2-2: 0 本なら「外しました」と言わない)。
  const what =
    `前回の daemon (pid=${state.pid}) の endpoint (${state.endpoint}) を向いた hook 配線` +
    (td.detached ? "を外しました" : "は既に無くなっていました");
  // SEC-TD-4: token file の削除失敗は state の結果がどの値でも報告する。
  const tokenNote =
    td.token === "rm-failed"
      ? `hook token file (${target.artifacts.tokenPath}) は削除できませんでした。権限を確認して手動で削除してください。`
      : "";
  switch (td.state) {
    case "kept-entries-remain":
      // 記録 endpoint 以外の ActraDeck entry が残る (記録外の死骸か、lock を共有しない daemon の配線)。
      // state を消すと `daemon stop` がその配線を見つけられなくなるので残す (R2 ガード・SEC-DC-R2-1)。
      opts.log(
        `[attach] ${what}。ただし ${target.settingsPath} にはほかの ActraDeck hook 配線が` +
          `残っているため、state は残します。外すには \`${hint}\` を実行してください。`,
      );
      return cleanupResult("detached-entries-remain");
    case "changed":
      opts.log(
        `[attach] ${what}。state は判定の後に書き換わっていたため消していません (scope lock を共有しない` +
          `書き手が居る可能性があります)。\`agentmon daemon status\` で確認してください。`,
      );
      return cleanupResult("detached-state-changed");
    case "absent":
      opts.log(`[attach] ${what}。state は判定の後に無くなっていました。${tokenNote}`);
      return cleanupResult("detached-state-absent");
    case "rm-failed":
      opts.log(
        `[attach] ${what}。stale state は削除できませんでした。\`${hint}\` を実行してください。${tokenNote}`,
      );
      return cleanupResult("detached-state-rm-failed");
    case "removed":
    case "untouched":
      break;
  }
  if (td.token === "rm-failed") {
    opts.log(`[attach] ${what}。stale state は消しましたが、${tokenNote}`);
    return cleanupResult("detached-token-rm-failed");
  }
  opts.log(`[attach] ${what}。stale state を消しました。`);
  return cleanupResult("detached");
}

/**
 * daemon を起動し settings を配線する (二段の transaction・ADR 01a10ddb D1)。
 * - 拒否の判定 (token-leak / env / invalid / confirm) は lock の外。拒否は deny() の後始末 (scope lock の下) を通る。
 * - **lock1** (scope lock): state を読み inspectStaleWiring で判定し、記録した daemon が生きていれば
 *   (同一性を確かめられない unknown も) `already-running`。lock1 は早期拒否の最適化で、正は lock2。
 * - startDaemon は lock の外 (async)。throw したら同じ後始末 (stale のみ・lock の下) を走らせてから元の例外を
 *   投げ直す。env token-mode の不一致は daemon を止めて deny()。
 * - **lock2** (scope lock): state を読み直して判定し直す。別の daemon が生きていれば自分の daemon を止めて
 *   `already-running`。stale / 無い / corrupt (TDA-STA-4 (3): lock2 で読み直した上で上書き = base 同値) なら
 *   merge → artifact を再導出して (SEC-STA-R2-1) state を書く → (T-B) hook token file。
 * - lock1 / lock2 を取得できなければ ScopeLockUnavailableError を投げる (CLI は exit 1)。lock1 では何も変えて
 *   いない。lock2 では起動した daemon を止めてから投げ、settings も state も書かない。
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

  // SEC-ENV-4: 拒否経路はすべてここを通して返す (DeniedOutcome の cleanup が必須なので、通さない拒否は
  // 型検査で落ちる・D4)。stale (pid 死亡) な前回 daemon の配線を片付けてから返す (判定の時点で生きている
  // daemon には触らない・判定後の並走は cleanupStaleWiring の docstring・confirm が要る scope は承認が
  // 無ければ書かず案内だけ)。writeApproved は confirm ゲートを通過した時点で true に上がる。
  let writeApproved = !scopeNeedsConfirm(args.scope) || args.yes;
  const deny = (status: DeniedStatus): DeniedOutcome => {
    const cleanup = cleanupStaleWiring({
      target,
      writeApproved,
      log: rt.log,
      ...(rt.identity !== undefined ? { identity: rt.identity } : {}),
    });
    return { status, cleanup, settingsPath, statePath };
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

  // lock1: 二重起動の早期判定。同一性を確かめられない (unknown) ときは生きているとみなす (base 同値・
  // ADR 01a10ddc)。判定は inspectStaleWiring 1 本 (TDA-TD-4)。stale / corrupt な state はここでは消さない:
  // 先に消すと、拒否や startDaemon の失敗で「state だけ失われ配線が残る」(daemon stop で外せない)。
  const early = withScopeLock(target, () => inspectScope(target, rt.identity));
  if (early.kind === "alive") {
    rt.log(
      `[attach] 既に稼働中 (pid=${early.state.pid}, endpoint=${early.state.endpoint}` +
        `${early.liveness === "unknown" ? "・同一性は未確認" : ""})`,
    );
    return {
      status: "already-running",
      statePath,
      settingsPath,
      hookEndpoint: early.state.endpoint,
    };
  }
  if (early.kind === "stale") {
    // TDA-DC-6: 実測どおりの文言 (成功なら lock2 で置き換え・失敗 / 拒否なら後始末が片付ける)。
    rt.log(
      `[attach] stale state を検出 (pid=${early.state.pid} 死亡)。起動に成功すればこの daemon の配線と ` +
        `state に置き換え、起動に失敗・拒否した場合は前回の配線と state を片付けます。`,
    );
  } else if (early.kind === "corrupt") {
    rt.log(
      `[attach] state (${early.path}) を検証できません。起動に成功すれば上書きします (起動に失敗・拒否した` +
        `場合は書き換えずに案内します)。`,
    );
  }

  // daemon を起動して安定 endpoint (OS 割当 port) と実 nonce を得る (lock の外)。
  let started: Awaited<ReturnType<DaemonRuntime["startDaemon"]>>;
  try {
    started = await rt.startDaemon({
      wsUrl: env.wsUrl,
      dbPath: env.dbPath,
      ...(env.ingestToken !== undefined ? { ingestToken: env.ingestToken } : {}),
      ...(env.hookToken !== undefined && env.hookToken.length > 0
        ? { hookToken: env.hookToken }
        : {}),
      tokenMode: args.tokenMode,
    });
  } catch (err) {
    // ADR D4 の throw 経路: 拒否と同じ後始末 (stale のみ・scope lock の下) を走らせてから元の例外を投げ直す
    // (fail-loud は保つ・exit 1 は cli の main().catch)。後始末自体の失敗で元の例外を隠さない。
    try {
      cleanupStaleWiring({
        target,
        writeApproved,
        log: rt.log,
        ...(rt.identity !== undefined ? { identity: rt.identity } : {}),
      });
    } catch {
      rt.log(`[attach] 起動の失敗の後で前回の配線の後始末にも失敗しました。`);
    }
    throw err;
  }
  const { daemon, hookEndpoint, hookToken } = started;

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
  const draft: DaemonState = {
    pid: process.pid,
    endpoint: hookEndpoint,
    scope: args.scope,
    settingsPath: artifacts.canonicalSettingsPath,
    startedAt: new Date().toISOString(),
    tokenMode: args.tokenMode,
    ...(identity !== undefined ? { procIdentity: identity } : {}),
  };
  assertDaemonStateShape(draft);

  // lock2: 判定し直してから配線と state を書く (lock1 の後に別の daemon が起動していれば負けた側が止まる)。
  let wired:
    | { readonly kind: "lost"; readonly other: DaemonState; readonly unknown: boolean }
    | { readonly kind: "wired"; readonly backupPath?: string; readonly statePath: string };
  try {
    wired = withScopeLock(target, () => {
      const now = inspectScope(target, rt.identity);
      if (now.kind === "alive") {
        return { kind: "lost", other: now.state, unknown: now.liveness === "unknown" } as const;
      }
      // settings を非破壊配線 (実 endpoint + daemon が検証に使う実 nonce を書く)。
      const merge = mergeAttachHooks({
        settingsPath,
        endpoint: hookEndpoint,
        tokenMode: args.tokenMode,
        ...(args.tokenMode === "literal" ? { token: hookToken } : {}),
      });
      // SEC-STA-R2-1: merge の後で artifact を再導出し、merge が実際に書いた settings の物理 path で state を
      // 書く (起動中に親 dir の symlink が付け替わっても、state の同一性と配線の書込先を揃える)。
      const post = scopeArtifacts(settingsPath, target.home);
      writeDaemonState(post.statePath, { ...draft, settingsPath: post.canonicalSettingsPath });
      // 別の path (旧い dist の path・付け替え前の path) で判定した state は、判定に使ったバイト列と同じときだけ
      // 消す (残すと、この daemon の state を消した後に旧い state が再び読まれる)。
      if (now.kind !== "no-state" && now.path !== post.statePath && now.raw !== undefined) {
        removeDaemonStateIfUnchanged(now.path, now.raw);
      }
      // (T-B) hook token file はここで `post.tokenPath` に書く: settings merge の後・lock2 の中 (逆順だと
      // settings が旧 port を向く間に生きた token が旧 port へ送られる・ADR D2)。
      return {
        kind: "wired",
        statePath: post.statePath,
        ...(merge.backupPath !== undefined ? { backupPath: merge.backupPath } : {}),
      } as const;
    });
  } catch (err) {
    // lock2 を取れない / 配線か state の書込に失敗: 起動した daemon を止めて投げ直す。
    await daemon.shutdown();
    throw err;
  }
  if (wired.kind === "lost") {
    await daemon.shutdown();
    rt.log(
      `[attach] 起動の間に別の daemon (pid=${wired.other.pid}, endpoint=${wired.other.endpoint}` +
        `${wired.unknown ? "・同一性は未確認" : ""}) が稼働を始めたため、この daemon は止めました。`,
    );
    return {
      status: "already-running",
      statePath,
      settingsPath,
      hookEndpoint: wired.other.endpoint,
    };
  }

  rt.log(
    `[attach] daemon 起動 pid=${process.pid} endpoint=${hookEndpoint} scope=${args.scope} ` +
      `settings=${settingsPath}${wired.backupPath ? ` backup=${wired.backupPath}` : ""}`,
  );
  return {
    status: "started",
    hookEndpoint,
    settingsPath,
    statePath: wired.statePath,
    ...(wired.backupPath !== undefined ? { backupPath: wired.backupPath } : {}),
  };
}

/**
 * runStop が記録 pid に SIGTERM を送ったか (D7)。送るのは記録した daemon と同一だと確かめられたとき
 * (`isDaemonProcess` が alive) だけ。
 * - `sent`: 送った。`send-failed`: 送ろうとして失敗した (その間に終了した等)。
 * - `self`: 記録 pid が自プロセス (呼び元が shutdown する)。
 * - `skipped-dead`: 記録した daemon は終了済み (pid 不在・start ticks / boot_id の不一致・Linux 以外の旧形
 *   state で etime が許容より後の起動を示す)。
 * - `skipped-identity-unknown`: 同一か確かめられない (権限が無い・`/proc` / `ps` が読めない・Linux の旧形
 *   state (procIdentity 無し) で etime が許容より後の起動を示す = pid 再利用と時計の前進を区別できない)。
 *   送らない。
 * - `skipped-corrupt`: state を検証できず pid を信用できない。送らない。
 * - `no-state`: state が無い。
 * - `skipped-lock-unavailable`: scope lock を取得できず、何も確かめていない。送らない。
 */
export type StopKill =
  | "sent"
  | "send-failed"
  | "self"
  | "skipped-dead"
  | "skipped-identity-unknown"
  | "skipped-corrupt"
  | "no-state"
  | "skipped-lock-unavailable";

export interface StopOutcome {
  /**
   * - `stopped`: 配線を外し、state と hook token file も片付いた (消した・既に無かった)。
   * - `incomplete`: 配線は外したが、state か token file が残っている (削除に失敗した・判定の後に書き換わって
   *   いた)。「停止しました」とは報告しない (TDA-DC-R3-2 / SEC-DC-R3-2(f))。
   * - `not-running`: state が無い (何もしない)。
   * - `lock-unavailable`: scope lock を取得できなかった (何も確かめず・何も変えていない)。
   * 終了コードは {@link stopOutcomeExitCode} (`incomplete` / `lock-unavailable` は 1・裁定 01a11052 ③)。
   */
  readonly status: "stopped" | "incomplete" | "not-running" | "lock-unavailable";
  readonly detached: boolean;
  readonly settingsPaths: readonly string[];
  readonly killedPid?: number;
  readonly kill: StopKill;
  /** state file の後始末 (teardownWiring の結果・state が無ければ undefined)。 */
  readonly state?: StateTeardown;
  /** hook token file の後始末 (teardownWiring の結果・state が無ければ undefined)。 */
  readonly token?: TokenTeardown;
  /** state を検証できなかった (pid を信用せず kill しない)。 */
  readonly corrupt?: boolean;
}

/**
 * `daemon stop` の結果を CLI の終了コードへ写す。後始末が終わっていない (`incomplete`: state か hook token file が
 * 残った) と scope lock を取得できなかった (`lock-unavailable`) は 1 (fail-loud・利用者が手で片付ける必要がある・
 * 裁定 01a11052 ③)。`stopped` / `not-running` は 0。
 */
export function stopOutcomeExitCode(outcome: StopOutcome): 0 | 1 {
  return outcome.status === "incomplete" || outcome.status === "lock-unavailable" ? 1 : 0;
}

/**
 * daemon を停止し settings から ActraDeck hooks を reversible detach する (利用者が明示した停止)。
 * **scope lock の中で** 判定 (inspectStaleWiring) と後始末 (teardownWiring・範囲は endpoint を問わず全
 * ActraDeck entry) を行い、lock を外した後で、別プロセスの daemon が記録されていて記録した daemon と同一だと
 * 確かめられたときだけ SIGTERM を送る (送る直前にもう一度確かめる・SEC-TD-1)。終了は待たない。
 * detach する settings は args から導出した path (state の中身からは取らない)。state を検証できない (corrupt)
 * ときは pid を信用せず、signal は送らない。detach が失敗したら state と token file に触らず、signal も
 * 送らずに例外をそのまま投げる (再試行できる形を保つ)。scope lock を取得できなければ何もせず
 * `lock-unavailable` を返す。
 */
export function runStop(args: DaemonArgs, rt: DaemonRuntime): StopOutcome {
  const home = rt.home ?? homedir();
  const target = scopeTarget(args.scope, args.cwd, home);
  const { settingsPath, artifacts } = target;
  let locked:
    | { readonly inspection: WiringInspection & { readonly kind: "no-state" } }
    | {
        readonly inspection: Exclude<WiringInspection, { readonly kind: "no-state" }>;
        readonly td: Extract<ReturnType<typeof teardownWiring>, { readonly kind: "done" }>;
      };
  try {
    locked = withScopeLock(target, () => {
      const inspection = inspectScope(target, rt.identity);
      if (inspection.kind === "no-state") return { inspection };
      // 配線済み settings を detach (ユーザー hooks は温存) → state → token file。
      const td = teardownWiring({
        target,
        expected: expectedStateOf(target, inspection),
        range: { kind: "all" },
      });
      if (td.kind === "detach-failed") throw td.error;
      return { inspection, td };
    });
  } catch (err) {
    if (!(err instanceof ScopeLockUnavailableError)) throw err;
    rt.log(
      `[attach] scope lock (${artifacts.lockPath}) を取得できなかったため、停止していません。同じ scope の ` +
        `attach / daemon コマンドが終わってから再実行してください。`,
    );
    return {
      status: "lock-unavailable",
      detached: false,
      settingsPaths: [],
      kill: "skipped-lock-unavailable",
    };
  }
  if (!("td" in locked)) {
    rt.log(`[attach] 稼働中の daemon がありません (${artifacts.statePath})`);
    return { status: "not-running", detached: false, settingsPaths: [], kill: "no-state" };
  }
  const { inspection, td } = locked;

  // 別プロセスの daemon を停止 (自プロセスなら呼び元が shutdown)。同一性を確かめてから送る。
  let kill: StopKill;
  if (inspection.kind === "corrupt") {
    kill = "skipped-corrupt";
  } else if (inspection.state.pid === process.pid) {
    kill = "self";
  } else {
    // SEC-TD-1: 後始末の間 (と lock の解放の後) に daemon が終了し pid が再利用されうるので、判定の時点で alive
    // でも送る直前に同じ述語で再判定し、alive のときだけ送る。後始末には settings lock の取得待ちが入る
    // (withFileLock の既定 100 回 × 20ms ≈ 2s。この値は lock 待ちだけで、settings の読み書きと同一性判定の時間は
    // 含まない)。
    const liveness =
      inspection.liveness === "alive"
        ? isDaemonProcess(inspection.state, rt.identity)
        : inspection.liveness;
    if (liveness === "alive") {
      try {
        process.kill(inspection.state.pid, "SIGTERM");
        kill = "sent";
      } catch {
        kill = "send-failed";
      }
    } else {
      kill = liveness === "dead" ? "skipped-dead" : "skipped-identity-unknown";
    }
  }

  const complete =
    (td.state === "removed" || td.state === "absent") &&
    (td.token === "removed" || td.token === "absent");
  const leftovers: string[] = [];
  if (td.state === "rm-failed") {
    leftovers.push(
      `state (${inspection.path}) を削除できませんでした。権限を確認して手動で削除してください。`,
    );
  } else if (td.state === "changed") {
    leftovers.push(
      `state (${inspection.path}) は判定の後に書き換わっていたため消していません (別の daemon が起動した` +
        `可能性があります)。\`agentmon daemon status\` で確認してください。`,
    );
  } else if (td.state === "kept-entries-remain") {
    leftovers.push(
      `ActraDeck の hook 配線が残っているため state (${inspection.path}) は残しました。`,
    );
  }
  if (td.token === "rm-failed") {
    leftovers.push(
      `hook token file (${artifacts.tokenPath}) を削除できませんでした。権限を確認して手動で削除してください。`,
    );
  }

  if (inspection.kind === "corrupt") {
    rt.log(
      `[attach] state (${inspection.path}) を検証できないため pid には signal を送っていません。` +
        (complete
          ? `hook 配線を外し、state を消しました。`
          : `hook 配線は外しましたが、${leftovers.join("")}`) +
        `daemon がまだ動いていれば手動で止めてください。`,
    );
  } else {
    if (kill === "skipped-identity-unknown") {
      rt.log(
        `[attach] pid=${inspection.state.pid} が記録した daemon と同一か確かめられないため、signal は送っていません。` +
          `daemon がまだ動いていれば手動で止めてください。`,
      );
    }
    rt.log(
      complete
        ? `[attach] daemon 停止 + detach (settings 1 件復元)`
        : `[attach] hook 配線は外しましたが、停止の後始末が終わっていません。${leftovers.join("")}`,
    );
  }
  return {
    status: complete ? "stopped" : "incomplete",
    detached: td.detached,
    settingsPaths: [settingsPath],
    kill,
    ...(kill === "sent" && inspection.kind !== "corrupt"
      ? { killedPid: inspection.state.pid }
      : {}),
    state: td.state,
    token: td.token,
    ...(inspection.kind === "corrupt" ? { corrupt: true } : {}),
  };
}

/**
 * {@link shutdownSelf} の結果。
 * - `torn-down`: state は自分 (pid が自プロセス) のもの。範囲 all で外し、state と hook token file を片付けた
 *   (`state` / `token` は teardownWiring の結果)。
 * - `own-endpoint-detached`: state が無かった (`record: "absent"`)・検証できなかった (`record: "corrupt"`)。
 *   自分の endpoint を向く entry だけを外した (state にも token file にも触らない・corrupt なら `daemon stop` を
 *   案内する)。
 * - `untouched-other`: state は別の daemon (別 pid) のもの。何も触らない。
 * - `detach-failed` / `lock-unavailable`: 外せなかった / scope lock を取得できなかった (ログで案内する)。
 */
export type ShutdownSelfOutcome =
  | {
      readonly kind: "torn-down";
      readonly detached: boolean;
      readonly state: StateTeardown;
      readonly token: TokenTeardown;
    }
  | {
      readonly kind: "own-endpoint-detached";
      readonly detached: boolean;
      readonly record: "absent" | "corrupt";
    }
  | { readonly kind: "untouched-other" }
  | { readonly kind: "detach-failed" }
  | { readonly kind: "lock-unavailable" };

/**
 * attach daemon 自身の終了 (SIGINT / SIGTERM / SIGHUP の handler・ADR 01a10ddb D1)。runStop (利用者の停止) とは
 * 別の経路で、**kill は決してしない** (INV-ATTACH-NO-KILL と整合)。scope lock の中で state を読み:
 * - state の pid が自プロセス → teardownWiring (範囲 all・state と hook token file も片付ける)。
 * - state が無い / corrupt → 自分の endpoint (`ownEndpoint`) を向く ActraDeck entry だけを外す (範囲 endpoint)。
 *   自分の endpoint は自プロセスが bind しているので、判定なしに自分の配線だと言える。state には触らない (判定の
 *   後に現れた state を消さない・corrupt は pid を信用できない・裁定 01a11052 ② / 01a110b2)。token file にも
 *   触らない。corrupt なら `daemon stop` を案内する。
 * - state が別の pid → 何も触らない (後から起動した daemon の配線と state を消さない)。
 * - scope lock を取得できない・detach に失敗した → 外さずに `daemon stop` を案内する。
 * 失敗しても throw しない (handler は daemon の shutdown を続ける)。
 */
export function shutdownSelf(
  args: DaemonArgs,
  rt: DaemonRuntime,
  ownEndpoint: string,
): ShutdownSelfOutcome {
  const home = rt.home ?? homedir();
  const target = scopeTarget(args.scope, args.cwd, home);
  const hint = stopCommandHint(target.scope, target.cwd);
  let out: ShutdownSelfOutcome;
  try {
    out = withScopeLock(target, (): ShutdownSelfOutcome => {
      const read = readState(target.artifacts, target.scopes);
      if (read.kind === "state" && read.state.pid !== process.pid)
        return { kind: "untouched-other" };
      const own = read.kind === "state";
      const td = teardownWiring({
        target,
        expected: own ? expectedStateOf(target, read) : { kind: "absent" },
        range: own ? { kind: "all" } : { kind: "endpoint", endpoint: ownEndpoint },
      });
      if (td.kind === "detach-failed") return { kind: "detach-failed" };
      return own
        ? { kind: "torn-down", detached: td.detached, state: td.state, token: td.token }
        : { kind: "own-endpoint-detached", detached: td.detached, record: read.kind };
    });
  } catch (err) {
    if (!(err instanceof ScopeLockUnavailableError)) {
      rt.log(`[attach] 終了時の hook 配線の後始末に失敗しました。\`${hint}\` で外してください。`);
      return { kind: "detach-failed" };
    }
    out = { kind: "lock-unavailable" };
  }
  switch (out.kind) {
    case "torn-down":
      rt.log(`[attach] detach (state ${out.state}・hook token file ${out.token})`);
      break;
    case "own-endpoint-detached":
      rt.log(
        out.record === "absent"
          ? `[attach] state が無いため、この daemon の endpoint を向く hook 配線だけを外しました。`
          : `[attach] state を検証できないため、この daemon の endpoint を向く hook 配線だけを外し、state には` +
              `触れていません。\`${hint}\` で確認してください。`,
      );
      break;
    case "untouched-other":
      rt.log(`[attach] state は別の daemon のものなので、hook 配線と state には触れていません。`);
      break;
    case "detach-failed":
    case "lock-unavailable":
      rt.log(
        `[attach] 終了時に hook 配線を外せませんでした (${out.kind})。\`${hint}\` で外してください。`,
      );
      break;
  }
  return out;
}

export interface StatusOutcome {
  readonly running: boolean;
  readonly state?: DaemonState;
  readonly statePath: string;
  /** state の pid が記録した daemon か (state があるときだけ)。 */
  readonly liveness?: ProcessLiveness;
  /** state を検証できなかった。 */
  readonly corrupt?: boolean;
  /**
   * settings の ActraDeck entry の数 (記録 endpoint を向くもの / それ以外・inspectStaleWiring)。settings を
   * 読めなければ undefined。表示はしない (T-B の wired-but-down 警告が使う)。
   */
  readonly entries?: WiringEntries;
}

/** daemon の稼働状態を返す (status 表示)。同一性を確かめられない (unknown) ときは稼働中として表示する。 */
export function runStatus(args: DaemonArgs, rt: DaemonRuntime): StatusOutcome {
  const home = rt.home ?? homedir();
  const target = scopeTarget(args.scope, args.cwd, home);
  const statePath = target.artifacts.statePath;
  const inspection = inspectScope(
    target,
    rt.identity,
    readSettingsForInspection(target.settingsPath),
  );
  const entries = inspection.entries !== undefined ? { entries: inspection.entries } : {};
  if (inspection.kind === "no-state") {
    rt.log(`[attach] daemon は稼働していません (${statePath})`);
    return { running: false, statePath, ...entries };
  }
  if (inspection.kind === "corrupt") {
    rt.log(
      `[attach] state (${inspection.path}) を検証できません。\`${stopCommandHint(args.scope, args.cwd)}\` で` +
        `配線を外し state を消せます。`,
    );
    return { running: false, statePath, corrupt: true, ...entries };
  }
  const { state, liveness } = inspection;
  if (inspection.kind === "alive") {
    rt.log(
      `[attach] 稼働中 pid=${state.pid} endpoint=${state.endpoint} ` +
        `scope=${state.scope} since=${state.startedAt}${liveness === "unknown" ? " (同一性は未確認)" : ""}`,
    );
    return { running: true, state, statePath, liveness, ...entries };
  }
  rt.log(`[attach] stale state (pid=${state.pid} 死亡)。daemon は稼働していません。`);
  return { running: false, state, statePath, liveness, ...entries };
}
