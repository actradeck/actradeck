/**
 * attach-scope — attach の scope ごとの対象 ({@link ScopeTarget}) と scope lock ({@link withScopeLock})
 * (Triangle ADR 01a10ddb D1・task 01a10c42 PR-B2)。
 *
 * 起動 (配線 + state の書込)・拒否起動の後始末・`daemon stop`・daemon 自身の終了は、同じ scope の判定
 * (state の読み取り) と除去 / 書込を {@link withScopeLock} の中で行う。判定と除去が同じ lock の下にあるので、
 * 「判定の後に別の daemon が配線・state を書いた」が lock を取る書き手の間では起きない。
 *
 * **lock の path は settings の lock と別** (`~/.actradeck/daemon/<scopeKey>.lock`・`scopeArtifacts().lockPath`)。
 * file-lock は自 pid の lock を stale として奪うので、同じ path を入れ子で取ると内側の解放の後で外側が lock
 * 無しで走る (ADR の実測)。順序は常に scope → settings (merge / detach が内側で settings の lock を取る)。
 * 同じ process の中で同じ scope の lock を入れ子で取ろうとしたら throw する (自 pid の奪取を無信号にしない)。
 *
 * **守備範囲 (開示)**: lock を取らない書き手 (この lock を持たない旧い版の daemon・手編集) は直列化されない。
 * その書き込みは後始末の結果値 (`changed` / 配線の残存) として報告されるだけで、防げない。
 */
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { type AttachScope, scopeArtifacts, type ScopeArtifacts } from "./daemon-state.js";
import { withFileLock } from "./file-lock.js";

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

declare const scopeTargetBrand: unique symbol;

/**
 * scope の settings path・artifact path・state で受け入れる scope ラベル (args から導出する)。
 * **{@link scopeTarget} だけが作る** (TDA-STA-5): 後始末に手で組み立てた path を渡させない
 * (state の中身や別の file から path を取らない)。brand 型だけでは spread (`{ ...t, artifacts: { ...a, tokenPath } }`)
 * で cast なしに偽造できる (SEC-TD-2 ≡ TDA-TD-1) ので、{@link scopeTarget} は発行した object を module 内の
 * WeakSet に登録して `Object.freeze` し (artifacts と scopes も)、受け取る側は未登録なら throw する
 * ({@link assertIssuedScopeTarget})。受け取る側は daemon-cli の後始末の入口・attach-teardown の
 * teardownWiring・{@link withScopeLock}。
 */
export interface ScopeTarget {
  /** 要求した scope (停止案内に使う)。 */
  readonly scope: AttachScope;
  /** 起動ディレクトリ (project 系の停止案内の `--cwd`)。 */
  readonly cwd: string;
  /** home (artifact の再導出に使う・SEC-STA-R2-1)。 */
  readonly home: string;
  readonly settingsPath: string;
  readonly artifacts: ScopeArtifacts;
  readonly scopes: readonly AttachScope[];
  readonly [scopeTargetBrand]: true;
}

/** {@link scopeTarget} が発行した target (同一性で照合する・spread した複製は含まない)。 */
const issuedScopeTargets = new WeakSet<ScopeTarget>();

/**
 * args の scope / cwd / home から {@link ScopeTarget} を導出する。state の scope ラベルは要求した scope だけを
 * 受け入れる。ただし導出した settings file が **user の settings file と同じ** (正規化した path が一致・
 * cwd が home の project か user) なら project と user の両方を受け入れる: cwd が home のとき project と
 * user は同じ `~/.claude/settings.json` を指すので、どちらで起動した daemon も、どの cwd からでも user で
 * (home からなら project でも) 止められる。state に記録された settings path の一致は別途必須 (asDaemonState)。
 */
export function scopeTarget(scope: AttachScope, cwd: string, home: string): ScopeTarget {
  const settingsPath = resolveSettingsPath(scope, cwd, home);
  const artifacts = scopeArtifacts(settingsPath, home);
  const userCanonical = scopeArtifacts(
    resolveSettingsPath("user", cwd, home),
    home,
  ).canonicalSettingsPath;
  const sharesUserFile =
    scope !== "project-local" && artifacts.canonicalSettingsPath === userCanonical;
  const scopes: readonly AttachScope[] = sharesUserFile ? ["project", "user"] : [scope];
  const target = Object.freeze({
    scope,
    cwd,
    home,
    settingsPath,
    artifacts: Object.freeze(artifacts),
    scopes: Object.freeze(scopes),
  }) as ScopeTarget;
  issuedScopeTargets.add(target);
  return target;
}

/** {@link scopeTarget} が発行した target でなければ throw する (SEC-TD-2: 偽造した path を後始末に渡させない)。 */
export function assertIssuedScopeTarget(target: ScopeTarget): void {
  if (!issuedScopeTargets.has(target)) {
    throw new Error("ScopeTarget は scopeTarget() が発行したものだけを受け取ります");
  }
}

/** scope lock を取得できなかった (別の attach / daemon コマンドが同じ scope の lock を保持している等)。 */
export class ScopeLockUnavailableError extends Error {
  constructor(lockPath: string, options: { cause: unknown }) {
    super(
      `attach の scope lock (${lockPath}) を取得できませんでした ` +
        `(同じ scope で別の attach / daemon コマンドが実行中の可能性があります)`,
      options,
    );
    this.name = "ScopeLockUnavailableError";
  }
}

/** この process が保持中の scope lock (scopeKey)。入れ子の取得を throw にするため。 */
const heldScopeKeys = new Set<string>();

/**
 * scope lock を取って `fn` を実行する (唯一の取得口)。`fn` は同期 (file-lock は同期専用)。
 * - 取得できなければ {@link ScopeLockUnavailableError} を投げる (`fn` は実行しない)。`fn` が投げた例外は
 *   そのまま投げる。
 * - 同じ process の中で同じ scopeKey の lock を保持したまま再び取ろうとしたら throw する (file-lock は自 pid の
 *   lock を奪うので、入れ子にすると外側が無 lock になる)。
 * - lock file の dir (`~/.actradeck/daemon`) は取得の前に 0700 で作る。
 */
export function withScopeLock<T>(target: ScopeTarget, fn: () => T): T {
  assertIssuedScopeTarget(target);
  const { scopeKey, lockPath, statePath } = target.artifacts;
  if (heldScopeKeys.has(scopeKey)) {
    throw new Error(
      `attach の scope lock (${lockPath}) を同じ process の中で入れ子に取ろうとしました`,
    );
  }
  heldScopeKeys.add(scopeKey);
  let entered = false;
  try {
    mkdirSync(dirname(lockPath), { recursive: true, mode: 0o700 });
    return withFileLock(
      statePath,
      () => {
        entered = true;
        return fn();
      },
      { lockPath },
    );
  } catch (err) {
    if (!entered) throw new ScopeLockUnavailableError(lockPath, { cause: err });
    throw err;
  } finally {
    heldScopeKeys.delete(scopeKey);
  }
}
