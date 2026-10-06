/**
 * daemon-state — Attach daemon の state file 管理 (ADR 019ea476 D1・state 信用規則 = Triangle ADR 01a10ddb D3)。
 *
 * state file: `~/.actradeck/daemon/<scopeKey>.json` (0600)。
 * - **token 値は記録しない** (token mode だけを記録する)。
 * - 二重起動防止・stale 判定 (同一性は process-identity.ts)・OS 割当 port を記録する。
 *
 * **state 信用規則 (1 本)**:
 * - scope の artifact の path (state / lock / token file) は settings path から**導出**する
 *   ({@link scopeArtifacts})。state の中身から path を取り出して読み書きしない。
 * - state の読み取りは {@link readState} 1 本で、結果は `absent | corrupt | state` の 3 値。形の検証は
 *   {@link asDaemonState} 1 か所。記録された `settingsPath` と `scope` は導出値との**整合検査**にだけ使い、
 *   一致しなければ corrupt (pid も信用しない)。scope ラベルは、導出した settings file が user の settings
 *   file と同じ (cwd が home の project・または user) ときだけ project / user の両方を受け入れる。
 * - 旧い dist は state path を symlink を解決しない settings path から導出していた。新しい path に state が
 *   無いときだけ、reader の中で旧い path を読む (symlink を含まない path では同じ path なので何もしない)。
 */
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

import { writeJson0600 } from "./fs-atomic.js";
import type { ProcIdentity } from "./process-identity.js";
import { HOOK_TOKEN_ENV_VAR, isDaemonHookEndpoint, type TokenMode } from "./settings-merge.js";

export type AttachScope = "project-local" | "project" | "user";

export interface DaemonState {
  readonly pid: number;
  /** 安定 hook endpoint (`http://127.0.0.1:<port>/hook`)。 */
  readonly endpoint: string;
  /** 配線 scope。読む側が受け入れるラベル集合 (StateExpectation.scopes) に属さなければ corrupt。 */
  readonly scope: AttachScope;
  /** 配線した settings file の正規化済み絶対 path ({@link scopeArtifacts} の canonicalSettingsPath)。整合検査用。 */
  readonly settingsPath: string;
  readonly startedAt: string;
  /** token の配線方式 (値は書かない)。 */
  readonly tokenMode: TokenMode;
  /** 書いた daemon プロセスの同一性 (Linux のみ・無ければ etime で照合する)。 */
  readonly procIdentity?: ProcIdentity;
}

/** daemon state ディレクトリ (~/.actradeck/daemon)。 */
export function daemonStateDir(home: string = homedir()): string {
  return join(home, ".actradeck", "daemon");
}

/**
 * 絶対パスの 12 桁短縮 sha256 (lexical・realpath を通さない)。approval の repo scope と、
 * {@link scopeArtifacts} の scopeKey (正規化済み path に掛ける) が使う。
 */
export function scopeHash(path: string): string {
  return createHash("sha256").update(resolve(path)).digest("hex").slice(0, 12);
}

/**
 * directory の path を物理 path へ正規化する: 存在する最長の祖先を realpath で解決し、存在しない残りの
 * 成分は lexical に足す。symlink を含まない path では `resolve(path)` と同じ文字列になる。
 */
function canonicalDir(path: string): string {
  const abs = resolve(path);
  const tail: string[] = [];
  let head = abs;
  for (;;) {
    try {
      const real = realpathSync(head);
      return tail.length === 0 ? real : join(real, ...tail.reverse());
    } catch {
      const parent = dirname(head);
      if (parent === head) return abs;
      tail.push(basename(head));
      head = parent;
    }
  }
}

/**
 * settings file の正規化済み path (唯一の導出・裁定 01a10e44 で改訂した ADR 01a10ddb D3):
 * **親 directory だけ** realpath し ({@link canonicalDir})、最終成分 (file 名) は lexical のまま足す。
 * settings の書込 (`fs-atomic.ts` の tmp + rename) は file 自体の symlink を通常 file に置き換えるので、
 * 最終成分まで解決すると起動の前後で値が変わる。書込が置き換える単位は (物理 dir, 名前) なのでそれに揃える。
 * 親 directory の symlink (symlink 経由の cwd・package の `.claude` dir 自体を root の dir への symlink にした
 * monorepo・symlink の HOME) は同じ値に集約する。settings file 自体だけを別 file への symlink にした場合は
 * 別の値になる (file 名を解決しない)。
 * **残余 (開示・SEC-STA-R2-1)**: 値は導出した時点の親 dir の物理 path で決まる。daemon の起動中 (導出から
 * settings への書込までの数十 ms) に親 dir の symlink を別の dir へ付け替えると、state の値と実際に書いた
 * file がずれ、終了後もその file に配線が残りうる。起動中の付け替えは避けること。
 */
export function canonicalSettingsPath(settingsPath: string): string {
  const abs = resolve(settingsPath);
  return join(canonicalDir(dirname(abs)), basename(abs));
}

export interface ScopeArtifacts {
  /** 正規化済み settings path の 12 桁短縮 sha256 (symlink を含まない path では旧 scopeHash と同値)。 */
  readonly scopeKey: string;
  /** 正規化済み settings path (state の settingsPath と照合する値)。 */
  readonly canonicalSettingsPath: string;
  readonly statePath: string;
  /** symlink を解決しない settings path (`resolve()`)。旧い dist が state に書いた値。 */
  readonly lexicalSettingsPath: string;
  /**
   * 旧い dist の state path (lexical な settings path の scopeHash)。symlink を含まない path では
   * statePath と同じ。新しい path に state が無いときだけ {@link readState} が読む。
   */
  readonly legacyStatePath: string;
  /** scope lock (PR-B で使う・ここでは導出だけ)。 */
  readonly lockPath: string;
  /** hook token file (書くのは T-B・在れば attach-teardown の teardownWiring が消す)。 */
  readonly tokenPath: string;
}

/**
 * settings path から scope の artifact path を導出する (単一出所)。symlink 経由の cwd と物理 cwd は
 * 同じ scopeKey になる。settings file 自体が symlink のときは file 名を解決しないので、symlink が通常 file に
 * 置き換わっても scopeKey は変わらない ({@link canonicalSettingsPath})。
 */
export function scopeArtifacts(settingsPath: string, home: string = homedir()): ScopeArtifacts {
  const canonical = canonicalSettingsPath(settingsPath);
  const lexicalSettingsPath = resolve(settingsPath);
  const scopeKey = scopeHash(canonical);
  const dir = daemonStateDir(home);
  return {
    scopeKey,
    canonicalSettingsPath: canonical,
    statePath: join(dir, `${scopeKey}.json`),
    lexicalSettingsPath,
    legacyStatePath: join(dir, `${scopeHash(lexicalSettingsPath)}.json`),
    lockPath: join(dir, `${scopeKey}.lock`),
    tokenPath: join(dir, `${scopeKey}.hook-token`),
  };
}

/** {@link asDaemonState} が照合する導出値。 */
export interface StateExpectation {
  readonly settingsPath: string;
  /**
   * 受け入れる scope ラベル (daemon-cli の `scopeTarget` が導出する)。
   */
  readonly scopes: readonly AttachScope[];
}

const BOOT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function asProcIdentity(v: unknown): ProcIdentity | undefined {
  if (!isRecord(v)) return undefined;
  const { bootId, startTicks } = v;
  if (typeof bootId !== "string" || !BOOT_ID_RE.test(bootId)) return undefined;
  if (typeof startTicks !== "number" || !Number.isSafeInteger(startTicks) || startTicks < 0) {
    return undefined;
  }
  return { bootId, startTicks };
}

/**
 * state として信用できる形か (唯一の形検証)。信用できれば既知の項目だけを持つ新しい object を返し、
 * そうでなければ undefined (= corrupt)。
 *
 * - pid は正の整数・endpoint は `http://127.0.0.1:<1-65535>/hook` (先頭 0 の無い port・settings-merge の
 *   `isDaemonHookEndpoint` = hook shim と同じ受理集合)・scope は受理ラベル集合に属する・startedAt は
 *   parse 可能・procIdentity は任意 (あるなら形が合うこと)。
 * - 新しい形: `settingsPath` (導出値と一致) + `tokenMode` (`literal` | `env`)。`wiredSettingsPaths` を併せ持つ
 *   state は corrupt。
 * - 旧い形 (legacy): `settingsPath` も `tokenMode` も無く、`wiredSettingsPaths` が**導出値と一致する要素 1 個の
 *   配列**のときだけ受理する (`[]`・複数・非配列・欠落は corrupt)。`hookTokenEnvVar` があれば (値は
 *   `ACTRADECK_HOOK_TOKEN` に限る) `tokenMode: "env"`、無ければ `"literal"` に読み替える。
 */
export function asDaemonState(parsed: unknown, expect: StateExpectation): DaemonState | undefined {
  if (!isRecord(parsed)) return undefined;
  const { pid, endpoint, scope, startedAt } = parsed;
  if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0 || pid > 0x7fffffff) {
    return undefined;
  }
  if (!isDaemonHookEndpoint(endpoint)) return undefined;
  const label = expect.scopes.find((s) => s === scope);
  if (label === undefined) return undefined;
  if (typeof startedAt !== "string" || !Number.isFinite(Date.parse(startedAt))) return undefined;
  let procIdentity: ProcIdentity | undefined;
  if (parsed.procIdentity !== undefined) {
    procIdentity = asProcIdentity(parsed.procIdentity);
    if (procIdentity === undefined) return undefined;
  }

  let tokenMode: TokenMode;
  if ("settingsPath" in parsed || "tokenMode" in parsed) {
    if ("wiredSettingsPaths" in parsed || "hookTokenEnvVar" in parsed) return undefined;
    const sp = parsed.settingsPath;
    if (typeof sp !== "string" || !isAbsolute(sp) || sp !== expect.settingsPath) return undefined;
    if (parsed.tokenMode !== "literal" && parsed.tokenMode !== "env") return undefined;
    tokenMode = parsed.tokenMode;
  } else {
    const wired = parsed.wiredSettingsPaths;
    if (!Array.isArray(wired) || wired.length !== 1 || wired[0] !== expect.settingsPath) {
      return undefined;
    }
    const envVar = parsed.hookTokenEnvVar;
    if (envVar !== undefined && envVar !== HOOK_TOKEN_ENV_VAR) return undefined;
    tokenMode = envVar === undefined ? "literal" : "env";
  }
  return {
    pid,
    endpoint,
    scope: label,
    settingsPath: expect.settingsPath,
    startedAt,
    tokenMode,
    ...(procIdentity !== undefined ? { procIdentity } : {}),
  };
}

/**
 * {@link readState} の結果。`path` は読んだ state file (新しい path か旧い path)・`raw` は判定に使った
 * state の生バイト列 (CAS 削除の比較値)。後始末・stop が消すのは `path` の file。
 */
export type StateRead =
  | { readonly kind: "absent" }
  | { readonly kind: "corrupt"; readonly path: string; readonly raw?: string }
  | {
      readonly kind: "state";
      readonly path: string;
      readonly state: DaemonState;
      readonly raw: string;
    };

/**
 * scope の state を読み、3 値で返す (唯一の reader)。新しい path を読み、そこに state が**無い**ときだけ
 * 旧い dist の path ({@link ScopeArtifacts.legacyStatePath}) を読む (旧い path の state は lexical な
 * settings path と照合する)。新しい path が corrupt なら旧い path は読まない。
 */
export function readState(art: ScopeArtifacts, scopes: readonly AttachScope[]): StateRead {
  const primary = readStateAt(art.statePath, { settingsPath: art.canonicalSettingsPath, scopes });
  if (primary.kind !== "absent" || art.legacyStatePath === art.statePath) return primary;
  return readStateAt(art.legacyStatePath, { settingsPath: art.lexicalSettingsPath, scopes });
}

/**
 * state file を 1 回だけ読み、3 値で返す。判定に使う state と CAS の比較値 (`raw`) は同じ 1 回の読み取り
 * から取る。無ければ absent、読めない・JSON でない・形が合わない・導出値と整合しないなら corrupt。
 */
function readStateAt(statePath: string, expect: StateExpectation): StateRead {
  let raw: string;
  try {
    raw = readFileSync(statePath, "utf8");
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ENOENT"
      ? { kind: "absent" }
      : { kind: "corrupt", path: statePath };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: "corrupt", path: statePath, raw };
  }
  const state = asDaemonState(parsed, expect);
  return state === undefined
    ? { kind: "corrupt", path: statePath, raw }
    : { kind: "state", path: statePath, state, raw };
}

/**
 * state file を 0600 で atomic 書込する。**token 値を含めてはならない** (型で token mode のみ許可)。
 * 読む側と同じ {@link asDaemonState} を通らない state は書かずに throw する (書いた state が次の読み取りで
 * corrupt になる経路を作らない)。
 */
export function writeDaemonState(path: string, state: DaemonState): void {
  assertDaemonStateShape(state);
  writeJson0600(path, state, { dirMode: 0o700 });
}

/** {@link writeDaemonState} が書ける形か (読む側と同じ検証)。配線より前に呼んで、配線だけ残る経路を作らない。 */
export function assertDaemonStateShape(state: DaemonState): void {
  if (
    asDaemonState(state, { settingsPath: state.settingsPath, scopes: [state.scope] }) === undefined
  ) {
    throw new Error("daemon state の形が不正なため書き込みません");
  }
}

/**
 * state file のいまの中身を、判定に使った読み取りのバイト列 `expectedRaw` と比べる (CAS の比較だけ・削除
 * しない)。`expectedRaw` が undefined なのは「判定のときに読めなかった (corrupt)」で、いまも読めなければ
 * 同じ (`same`) とみなす。無ければ `absent`。
 */
export function compareDaemonState(
  path: string,
  expectedRaw: string | undefined,
): "same" | "changed" | "absent" {
  let current: string | undefined;
  try {
    current = readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return "absent";
    current = undefined;
  }
  return current === expectedRaw ? "same" : "changed";
}

/**
 * state file を、いまの中身が判定に使ったバイト列 `expectedRaw` と同じときだけ削除する (CAS・state の
 * **唯一の削除**・SEC-ENV-4 R1 / QA-DC-1 ≡ TDA-DC-1・ADR 01a10ddb D2)。stale と判定した後で別の daemon が
 * 同じ scope に state を書いていたら消さない。
 *
 * **比較と削除の間は原子的でない**: 比較した直後・削除の直前に別の daemon が state を書くと、その state を
 * 消す (lock の外・開示済みの残余・scope lock で閉じるのは PR-B2)。結果は 消した (`removed`)・中身が
 * 変わっていた (`changed`)・既に無かった (`absent`)・削除に失敗した (`rm-failed`・SEC-DC-R2-2 /
 * TDA-DC-R3-2: 失敗を「消した」と報告しないため区別する)。
 */
export function removeDaemonStateIfUnchanged(
  path: string,
  expectedRaw: string | undefined,
): "removed" | "changed" | "absent" | "rm-failed" {
  const now = compareDaemonState(path, expectedRaw);
  if (now !== "same") return now;
  try {
    rmSync(path, { force: true });
    return "removed";
  } catch {
    return "rm-failed";
  }
}
