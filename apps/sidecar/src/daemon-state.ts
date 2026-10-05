/**
 * daemon-state — Attach daemon の PID/endpoint state file 管理 (ADR 019ea476 D1)。
 *
 * state file: `~/.actradeck/daemon/<scope-hash>.json` (0600)。
 * - **token 値は記録しない** (env 変数名の参照のみ)。
 * - 二重起動防止 (pid 生存判定) / stale 判定 (削除は CAS) / OS 割当 port を記録。
 *
 * scope は「どの settings file に配線したか」で一意化する。scope-hash は settings の絶対パスの
 * sha256 短縮。複数 project は (MVP では) それぞれ別 scope = 別 state file になりうるが、
 * 単一 daemon に scope を束ねる拡張 (--isolated 等) は forward-compat。
 */
import { createHash } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
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
  return asDaemonState(readJsonObject(path));
}

/** state として使える形か (JSON object + pid:number + endpoint:string)。readDaemonState と CAS 経路の単一出所。 */
function asDaemonState(parsed: unknown): DaemonState | undefined {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
  const s = parsed as Partial<DaemonState>;
  if (typeof s.pid !== "number" || typeof s.endpoint !== "string") return undefined;
  return parsed as DaemonState;
}

/** state file の生バイト列 (無い・読めないなら undefined)。CAS 削除の比較用。 */
function readStateRaw(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

/** state file を 0600 で atomic 書込する。**token 値を含めてはならない** (型で env 名のみ許可)。 */
export function writeDaemonState(path: string, state: DaemonState): void {
  writeJson0600(path, state, { dirMode: 0o700 });
}

/** state file のいまの中身が `expectedRaw` と同じか (CAS の比較だけを行う・削除しない)。 */
export function isDaemonStateUnchanged(path: string, expectedRaw: string): boolean {
  return readStateRaw(path) === expectedRaw;
}

/**
 * state file を、いまの中身が `expectedRaw` と同じときだけ削除する (CAS・SEC-ENV-4 R1 / QA-DC-1 ≡
 * TDA-DC-1)。stale と判定した後で別の daemon が同じ scope に state を書いていたら消さない。
 *
 * **比較と削除の間は原子的でない**: 比較した直後・削除の直前に別の daemon が state を書くと、その state を
 * 消す (lock の外・開示済みの残余)。結果は 消した (`removed`)・中身が変わっていた (`changed`)・削除に
 * 失敗した (`rm-failed`・SEC-DC-R2-2: 失敗を「消した」と報告しないため区別する)。
 */
export function removeDaemonStateIfUnchanged(
  path: string,
  expectedRaw: string,
): "removed" | "changed" | "rm-failed" {
  if (!isDaemonStateUnchanged(path, expectedRaw)) return "changed";
  try {
    rmSync(path, { force: true });
    return "removed";
  } catch {
    return "rm-failed";
  }
}

/** state file を無条件に削除する (現在の呼び出し元は runStop のみ・拒否経路の後始末は CAS 版の removeDaemonStateIfUnchanged を使う)。 */
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
 * - state 有り + pid 死亡 → stale (alive=false, stale=true)。起動可。stale state は起動が成功して
 *   上書きされるか、拒否経路の後始末 (`cleanupStaleWiring`) か `daemon stop` が消す。
 *
 * `raw` は判定に使った state の生バイト列 (`removeDaemonStateIfUnchanged` の比較に渡す)。判定と同じ
 * 1 回の読み取りから取るので、判定した state と比較する state がずれない。
 */
export function checkExistingDaemon(path: string): {
  alive: boolean;
  stale: boolean;
  state?: DaemonState;
  raw?: string;
} {
  const raw = readStateRaw(path);
  const state = raw === undefined ? undefined : parseDaemonState(raw);
  if (state === undefined || raw === undefined) return { alive: false, stale: false };
  if (isPidAlive(state.pid)) return { alive: true, stale: false, state, raw };
  // pid 死亡 = stale。
  return { alive: false, stale: true, state, raw };
}

/** 生バイト列を readDaemonState と同じ検査に掛ける。 */
function parseDaemonState(raw: string): DaemonState | undefined {
  try {
    return asDaemonState(JSON.parse(raw));
  } catch {
    return undefined;
  }
}
