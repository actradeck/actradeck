/**
 * attach-teardown — attach の配線の判定 ({@link inspectStaleWiring}) と後始末 ({@link teardownWiring}) の
 * 単一出所 (Triangle ADR 01a10ddb D2 / D6・task 01a10c42 PR-B1)。
 *
 * 拒否起動の後始末 (daemon-cli の cleanupStaleWiring)・`daemon stop` (runStop)・`daemon status` (runStatus) は、
 * 判定をここの純関数で、後始末をここの 1 本の手順で行う。手順 (detach → state → token file) を呼び出し側に
 * 2 本目として書かない。
 *
 * **lock**: どちらも lock を取らない。{@link teardownWiring} は呼び出し側が attach-scope の `withScopeLock` を
 * 保持している前提で動く (daemon-cli の後始末・runStop・shutdownSelf はすべて lock の中で呼ぶ・PR-B2)。lock の
 * 下では state の比較と削除の間に lock を取る書き手が割り込まないので、`changed` / `absent` と配線の残存
 * (`kept-entries-remain`) は「lock を取らない書き手 (旧い版の daemon・手編集) が居た」ことの fail-loud な信号になる。
 */
import { rmSync } from "node:fs";

import { assertIssuedScopeTarget, type ScopeTarget } from "./attach-scope.js";
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
  readSettingsForInspection,
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
 * removeDaemonStateIfUnchanged と同じ意味。`kept-entries-remain` は detach の後に settings を読み直すと
 * ActraDeck entry が残っていたので消さなかった (R2 ガード・SEC-DC-R2-1: 消すと `daemon stop` がその配線を
 * 見つけられない。範囲 `all` の detach の後に残るのは、lock を取らない書き手が detach の後に書いた場合だけ・
 * 裁定 01a11052 ①で維持)。`untouched` は判定の時点で state が無かった ({@link ExpectedState} の `absent`) ので
 * state の段を通らなかった。
 */
export type StateTeardown =
  | "removed"
  | "changed"
  | "absent"
  | "rm-failed"
  | "kept-entries-remain"
  | "untouched";

/**
 * hook token file の後始末の結果。`kept` は state を消さなかった (別の daemon のものでありうる)・判定の時点で
 * state が無かったので触らなかった。
 */
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

/** state file の 2 つの置き場 (`scopeArtifacts` の statePath / 旧い dist の legacyStatePath)。 */
export type StateSlot = "current" | "legacy";

/**
 * 判定の時点の state (CAS の比較値・判別 union・TDA-TD-8 (ii) / 裁定 01a11052 ②)。
 * - `bytes`: 読めた state のバイト列。いまの中身が同じときだけ消す。
 * - `unreadable`: 読めなかった (corrupt)。いまも読めなければ同じとみなして消す。
 * - `absent`: state が無かった。state の段を通らない (後から現れた state を消さない)・token file にも触らない。
 */
export type ExpectedState =
  | { readonly kind: "bytes"; readonly slot: StateSlot; readonly raw: string }
  | { readonly kind: "unreadable"; readonly slot: StateSlot }
  | { readonly kind: "absent" };

/**
 * readState の結果 (または同じ path / raw を持つ判定) から {@link ExpectedState} を作る。path は target の
 * 2 つの置き場のどちらかでなければ throw する (state の path は導出したものだけ・SEC-TD-R2-3)。
 */
export function expectedStateOf(
  target: ScopeTarget,
  read: { readonly kind: "absent" } | { readonly path: string; readonly raw?: string | undefined },
): ExpectedState {
  if (!("path" in read)) return { kind: "absent" };
  const { statePath, legacyStatePath } = target.artifacts;
  const slot: StateSlot | undefined =
    read.path === statePath ? "current" : read.path === legacyStatePath ? "legacy" : undefined;
  if (slot === undefined) throw new Error("state の path が scope から導出したものではありません");
  return read.raw === undefined
    ? { kind: "unreadable", slot }
    : { kind: "bytes", slot, raw: read.raw };
}

export interface TeardownContext {
  /** scopeTarget() が発行した target (settings / state / token file の path はここから導出する)。 */
  readonly target: ScopeTarget;
  /** 判定の時点の state ({@link expectedStateOf})。 */
  readonly expected: ExpectedState;
  /** detach の範囲 (必須・既定値なし)。 */
  readonly range: DetachRange;
}

/**
 * 配線の後始末 (唯一の手順・ADR 01a10ddb D2)。順序は固定で **detach → state → token file**。呼び出し側は
 * scope lock を保持していること。path はすべて `ctx.target` から導出する (発行していない target は throw・
 * SEC-TD-R2-3)。
 * - detach が throw したら state も token file も触らず `detach-failed` を返す。
 * - 判定の時点で state が無かった (`absent`) なら detach だけで終わる (state は `untouched`・token は `kept`)。
 * - detach の後に settings を**読み直して** ActraDeck entry が残っていれば (読めなければ残っているとみなす)
 *   state を消さない (`kept-entries-remain`・判定の後に state が書き換わっていれば `changed`・既に無ければ
 *   `absent`)。token file も触らない。
 * - state は removeDaemonStateIfUnchanged (CAS) 1 本で消す。`changed` (判定の後に別の書き手が state を
 *   書いた) なら token file はその書き手のものでありうるので触らない。
 * - token file は在れば消す (無ければ `absent`・消せなければ `rm-failed`)。値は読まない。state が `absent` /
 *   `rm-failed` でも消して結果を返す (SEC-TD-4: 呼び出し側はどの枝でも token の失敗を報告する)。
 */
export function teardownWiring(ctx: TeardownContext): TeardownResult {
  const { target, expected } = ctx;
  assertIssuedScopeTarget(target);
  const { settingsPath } = target;
  let detached: boolean;
  try {
    detached = detachAttachHooks(settingsPath, ctx.range).removed;
  } catch (error) {
    return { kind: "detach-failed", error };
  }
  if (expected.kind === "absent") {
    return { kind: "done", detached, state: "untouched", token: "kept" };
  }
  const statePath =
    expected.slot === "current" ? target.artifacts.statePath : target.artifacts.legacyStatePath;
  const expectedRaw = expected.kind === "bytes" ? expected.raw : undefined;
  const after = readSettingsForInspection(settingsPath);
  if (after === undefined || hasActradeckHookInSettings(after)) {
    const now = compareDaemonState(statePath, expectedRaw);
    return {
      kind: "done",
      detached,
      state: now === "same" ? "kept-entries-remain" : now,
      token: "kept",
    };
  }
  const state = removeDaemonStateIfUnchanged(statePath, expectedRaw);
  const token = state === "changed" ? "kept" : removeTokenFile(target.artifacts.tokenPath);
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
