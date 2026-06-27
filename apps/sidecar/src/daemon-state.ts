/**
 * daemon-state — Attach daemon の PID/endpoint state file 管理 (ADR 019ea476 D1)。
 *
 * state file: `~/.actradeck/daemon/<scope-hash>.json` (0600)。
 * - **token 値は記録しない** (env 変数名の参照のみ)。
 * - 二重起動防止 (pid 生存判定) / stale 掃除 / OS 割当 port を記録。
 *
 * scope は「どの settings file に配線したか」で一意化する。scope-hash は settings の絶対パスの
 * sha256 短縮。複数 project は (MVP では) それぞれ別 scope = 別 state file になりうるが、
 * 単一 daemon に scope を束ねる拡張 (--isolated 等) は forward-compat。
 */
import { createHash } from "node:crypto";
import { rmSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { readJsonObject, writeJson0600 } from "./fs-atomic.js";

export interface DaemonState {
  readonly pid: number;
  /** 安定 hook endpoint (loopback + OS 割当 port)。 */
  readonly endpoint: string;
  /** literal token-mode 時の env 変数名のみ (値は書かない)。env-mode の参照記録。 */
  readonly hookTokenEnvVar?: string;
  /** 配線した settings file の絶対パス群。detach 対象。 */
  readonly wiredSettingsPaths: readonly string[];
  /** 配線 scope (project-local | project | user)。 */
  readonly scope: string;
  readonly startedAt: string;
}

/** daemon state ディレクトリ (~/.actradeck/daemon)。 */
export function daemonStateDir(home: string = homedir()): string {
  return join(home, ".actradeck", "daemon");
}

/** settings file の絶対パスから scope-hash を導出する (12 桁短縮 sha256)。 */
export function scopeHash(settingsPath: string): string {
  return createHash("sha256").update(resolve(settingsPath)).digest("hex").slice(0, 12);
}

/** scope に対応する state file パス。 */
export function stateFilePath(settingsPath: string, home: string = homedir()): string {
  return join(daemonStateDir(home), `${scopeHash(settingsPath)}.json`);
}

/** PID が生存しているか (signal 0 で確認, 権限不足は生存とみなす)。 */
export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // ESRCH = 不在 (死亡)。EPERM = 存在するが権限なし → 生存扱い。
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** state file を読む (無ければ undefined, JSON 不正は undefined)。 */
export function readDaemonState(path: string): DaemonState | undefined {
  const parsed = readJsonObject(path);
  if (parsed === undefined) return undefined;
  const s = parsed as Partial<DaemonState>;
  if (typeof s.pid !== "number" || typeof s.endpoint !== "string") return undefined;
  return parsed as unknown as DaemonState;
}

/** state file を 0600 で atomic 書込する。**token 値を含めてはならない** (型で env 名のみ許可)。 */
export function writeDaemonState(path: string, state: DaemonState): void {
  writeJson0600(path, state, { dirMode: 0o700 });
}

/** state file を削除する (stop / stale 掃除)。 */
export function removeDaemonState(path: string): void {
  try {
    rmSync(path, { force: true });
  } catch {
    /* best-effort */
  }
}

/**
 * 既存 daemon の生存判定。
 * - state 無し → 起動可 (alive=false)。
 * - state 有り + pid 生存 → 二重起動 (alive=true, state を返す)。
 * - state 有り + pid 死亡 → stale。掃除して起動可 (alive=false, stale=true)。
 */
export function checkExistingDaemon(path: string): {
  alive: boolean;
  stale: boolean;
  state?: DaemonState;
} {
  const state = readDaemonState(path);
  if (state === undefined) return { alive: false, stale: false };
  if (isPidAlive(state.pid)) return { alive: true, stale: false, state };
  // pid 死亡 = stale。
  return { alive: false, stale: true, state };
}
