/**
 * attach-teardown — attach の配線の判定 ({@link inspectStaleWiring}) と後始末 ({@link teardownWiring}) の
 * 単一出所 (Triangle ADR 01a10ddb D2 / D6・task 01a10c42 PR-B1)。
 *
 * 拒否起動の後始末 (daemon-cli の cleanupStaleWiring)・`daemon stop` (runStop)・`daemon status` (runStatus) は、
 * 判定をここの純関数で、後始末をここの 1 本の手順で行う。手順 (detach → state → token file) を呼び出し側に
 * 2 本目として書かない。
 *
 * **lock**: どちらも scope lock を取らない (呼び出し側が保持する前提の形・scope lock 自体は PR-B2)。現状は
 * settings の書込だけが settings lock で直列化され、state の比較と削除の間は原子的でない
 * (daemon-state の removeDaemonStateIfUnchanged の開示)。
 */
import { rmSync } from "node:fs";

import {
  compareDaemonState,
  type DaemonState,
  removeDaemonStateIfUnchanged,
  type StateRead,
} from "./daemon-state.js";
import type { ProcessLiveness } from "./process-identity.js";
import {
  type ClaudeSettingsFile,
  countActradeckEntries,
  detachAttachHooks,
  type DetachRange,
  hasActradeckHookInSettings,
} from "./settings-merge.js";

/** settings の ActraDeck entry の数 (記録 endpoint を向くもの / それ以外)。 */
export interface WiringEntries {
  readonly recorded: number;
  readonly other: number;
}

/**
 * {@link inspectStaleWiring} の結果。
 * - `no-state`: state が無い。
 * - `corrupt`: state を検証できない (pid を信用しない)。
 * - `alive`: 記録した daemon が生きている、または同一性を確かめられない (`liveness: "unknown"` は alive 扱い・
 *   採用 01a10ddc)。
 * - `stale`: 記録した daemon は終了している (pid 不在・pid 再利用)。
 * `entries` は settings を渡したときだけ ({@link countActradeckEntries}・state が無い / corrupt なら全部が other)。
 */
export type WiringInspection =
  | { readonly kind: "no-state"; readonly entries?: WiringEntries }
  | {
      readonly kind: "corrupt";
      readonly path: string;
      readonly raw: string | undefined;
      readonly entries?: WiringEntries;
    }
  | {
      readonly kind: "alive" | "stale";
      readonly path: string;
      readonly raw: string;
      readonly state: DaemonState;
      readonly liveness: ProcessLiveness;
      readonly entries?: WiringEntries;
    };

/**
 * state の読み取り結果と settings から、配線の状態を判定する (**純関数**: fs も lock も持たない・ADR D6)。
 * 生存の判定は注入された `isDaemonProcess` (本番は process-identity の同名関数) に委ね、ここでは `/proc`
 * や settings file を読まない。settings は呼び出し側が読んで渡す (読めない・要らないなら undefined)。
 */
export function inspectStaleWiring(input: {
  readonly read: StateRead;
  readonly settings: ClaudeSettingsFile | undefined;
  readonly isDaemonProcess: (state: DaemonState) => ProcessLiveness;
}): WiringInspection {
  const { read, settings } = input;
  const recordedEndpoint = read.kind === "state" ? read.state.endpoint : undefined;
  const entries =
    settings !== undefined ? { entries: countActradeckEntries(settings, recordedEndpoint) } : {};
  if (read.kind === "absent") return { kind: "no-state", ...entries };
  if (read.kind === "corrupt")
    return { kind: "corrupt", path: read.path, raw: read.raw, ...entries };
  const liveness = input.isDaemonProcess(read.state);
  return {
    kind: liveness === "dead" ? "stale" : "alive",
    path: read.path,
    raw: read.raw,
    state: read.state,
    liveness,
    ...entries,
  };
}

/**
 * state file の後始末の結果。`removed` / `changed` / `absent` / `rm-failed` は daemon-state の
 * removeDaemonStateIfUnchanged と同じ意味。`kept-entries-remain` は detach の後も settings に ActraDeck
 * entry が残っているので消さなかった (SEC-DC-R2-1: 消すと `daemon stop` がその配線を見つけられない・
 * 範囲が `all` の detach では残らないので起きない)。
 */
export type StateTeardown = "removed" | "changed" | "absent" | "rm-failed" | "kept-entries-remain";

/** hook token file の後始末の結果。`kept` は state を消さなかった (別の daemon のものでありうる) ので触らなかった。 */
export type TokenTeardown = "removed" | "absent" | "rm-failed" | "kept";

/**
 * {@link teardownWiring} の結果。`detach-failed` なら state と token file には触っていない
 * (`daemon stop` で再試行できる形を保つ)。
 */
export type TeardownResult =
  | { readonly kind: "detach-failed"; readonly error: unknown }
  | {
      readonly kind: "done";
      /** ActraDeck entry を 1 本でも外したか。 */
      readonly detached: boolean;
      readonly state: StateTeardown;
      readonly token: TokenTeardown;
    };

export interface TeardownContext {
  /** detach する settings (scope から導出した path)。 */
  readonly settingsPath: string;
  /** 消す state file (判定に使った読み取りの path)。 */
  readonly statePath: string;
  /** 消す hook token file (scopeArtifacts の tokenPath)。 */
  readonly tokenPath: string;
  /** 判定に使った読み取りの state のバイト列 (CAS の比較値・読めなかった corrupt は undefined)。 */
  readonly expectedRaw: string | undefined;
  /** detach の範囲 (必須・既定値なし)。 */
  readonly range: DetachRange;
}

/**
 * 配線の後始末 (唯一の手順・ADR 01a10ddb D2)。順序は固定で **detach → state → token file**。
 * - detach が throw したら state も token file も触らず `detach-failed` を返す。
 * - detach の後も settings に ActraDeck entry が残っていれば state を消さない (`kept-entries-remain`・
 *   判定の後に state が書き換わっていれば `changed`・既に無ければ `absent`)。token file も触らない。
 * - state は removeDaemonStateIfUnchanged (CAS) 1 本で消す。`changed` (判定の後に別の daemon が state を
 *   書いた) なら token file はその daemon のものでありうるので触らない。
 * - token file は在れば消す (無ければ `absent`・消せなければ `rm-failed`)。値は読まない。
 */
export function teardownWiring(ctx: TeardownContext): TeardownResult {
  let detached: boolean;
  let remaining: boolean;
  try {
    const res = detachAttachHooks(ctx.settingsPath, ctx.range);
    detached = res.removed;
    remaining = hasActradeckHookInSettings(res.settings);
  } catch (error) {
    return { kind: "detach-failed", error };
  }
  if (remaining) {
    const now = compareDaemonState(ctx.statePath, ctx.expectedRaw);
    return {
      kind: "done",
      detached,
      state: now === "same" ? "kept-entries-remain" : now,
      token: "kept",
    };
  }
  const state = removeDaemonStateIfUnchanged(ctx.statePath, ctx.expectedRaw);
  const token = state === "changed" ? "kept" : removeTokenFile(ctx.tokenPath);
  return { kind: "done", detached, state, token };
}

function removeTokenFile(path: string): "removed" | "absent" | "rm-failed" {
  try {
    rmSync(path);
    return "removed";
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ENOENT" ? "absent" : "rm-failed";
  }
}
