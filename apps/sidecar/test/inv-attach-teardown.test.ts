/**
 * INV-ATTACH-TEARDOWN (task 01a10c42 PR-B1・Triangle ADR 01a10ddb D2 / D4 / D6)。
 *
 * - D2 `teardownWiring`: 配線の後始末は 1 本の手順で、順序は detach → state → hook token file。detach が
 *   失敗したら state も token file も触らない。範囲は必須の判別 union。detach の後も ActraDeck entry が
 *   残るなら state と token file を残す。判定の後に state が書き換わっていたら token file も残す。
 *   拒否起動の後始末 (cleanupStaleWiring) と `daemon stop` (runStop) が共有し、token file の slot
 *   (`scopeArtifacts().tokenPath`) もここで消す。runStop は state / token file が残ったら「停止しました」と
 *   報告しない。
 * - D4 型床: 拒否の結果 (DeniedOutcome) は後始末の結果 (module の外では cleanupStaleWiring の戻り値でしか得られない brand 型) を必須で
 *   持つ。直に返す拒否は型検査 (tsc -p tsconfig.test.json) で落ちる。
 * - D6 `inspectStaleWiring`: 判定は純関数 (state の読み取り結果 + settings + 生存の述語)。
 * - TDA-STA-6 (a): state が受け入れる endpoint の形は hook shim と同じ受理集合。
 *
 * すべて temp HOME / temp cwd で動かす (実 ~/.claude・~/.actradeck に触れない)。
 */
import { type ChildProcess, spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  expectedStateOf,
  inspectStaleWiring,
  type TeardownContext,
  teardownWiring,
} from "../src/attach-teardown.js";
import {
  cleanupStaleWiring,
  type DaemonRuntime,
  parseDaemonArgs,
  resolveSettingsPath,
  runStatus,
  runStop,
  scopeTarget,
  type ScopeTarget,
  type StartOutcome,
  stopOutcomeExitCode,
} from "../src/daemon-cli.js";
import {
  asDaemonState,
  type DaemonState,
  scopeArtifacts,
  type StateRead,
  writeDaemonState,
} from "../src/daemon-state.js";
import { parseHookShimArgs } from "../src/hook-shim-core.js";
import {
  defaultIdentitySources,
  type IdentitySources,
  type ProcessLiveness,
} from "../src/process-identity.js";
import {
  ACTRADECK_MARKER,
  countActradeckEntries,
  detachAttachHooks,
  endpointOfEntry,
  isDaemonHookEndpoint,
  mergeAttachHooks,
} from "../src/settings-merge.js";

import {
  actradeckEntries,
  appendEntriesFor as appendEntriesForFixture,
  daemonStateFor,
  deadPid,
  stubRuntime,
} from "./helpers/attach-fixtures.js";

/** runStop の判定 (readState) の直後に 1 回だけ同期実行する注入点 (未設定なら素通し)。 */
const race = vi.hoisted(() => ({ fire: undefined as undefined | (() => void), fired: 0 }));
vi.mock("../src/daemon-state.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../src/daemon-state.js")>();
  return {
    ...orig,
    readState: (...a: Parameters<typeof orig.readState>) => {
      const r = orig.readState(...a);
      const f = race.fire;
      if (f !== undefined) {
        race.fire = undefined;
        race.fired += 1;
        f();
      }
      return r;
    },
  };
});

/**
 * detachAttachHooks が返った直後に 1 回だけ同期実行する注入点 (lock を取らない書き手が detach の後に配線を
 * 書く形・未設定なら素通し)。
 */
const bypass = vi.hoisted(() => ({ afterDetach: undefined as undefined | (() => void), fired: 0 }));
vi.mock("../src/settings-merge.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../src/settings-merge.js")>();
  return {
    ...orig,
    detachAttachHooks: (...a: Parameters<typeof orig.detachAttachHooks>) => {
      const r = orig.detachAttachHooks(...a);
      const f = bypass.afterDetach;
      if (f !== undefined) {
        bypass.afterDetach = undefined;
        bypass.fired += 1;
        f();
      }
      return r;
    },
  };
});

const LINUX = process.platform === "linux";
const TOKEN = "tok-teardown-0123456789abcdef0123456789";
const DEAD_ENDPOINT = "http://127.0.0.1:9/hook";
const OTHER_ENDPOINT = "http://127.0.0.1:10/hook";
/** runStop が完全に片付いたときの文言 (incomplete 行の negative と stopped 行の POSITIVE で同じ literal)。 */
const STOPPED_MSG = "daemon 停止 + detach";
/** token file を消せなかったときの文言 (同上の対)。 */
const TOKEN_LEFT_MSG = "hook token file";
/** 後始末が stale state を消したときの文言 (token file が残った行の negative と消せた行の POSITIVE で同じ literal)。 */
const DETACHED_MSG = "stale state を消しました";
/** state が判定の後に書き換わっていたときの文言 (同上の対)。 */
const CHANGED_MSG = "判定の後に書き換わっていた";

let home: string;
let cwd: string;
/** この file が起動した子プロセス (afterEach で残さず止める)。 */
const children: ChildProcess[] = [];
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "actradeck-teardown-home-"));
  cwd = mkdtempSync(join(tmpdir(), "actradeck-teardown-cwd-"));
});
afterEach(() => {
  race.fire = undefined;
  bypass.afterDetach = undefined;
  for (const c of children.splice(0)) {
    if (c.exitCode === null && c.signalCode === null) c.kill("SIGKILL");
  }
  rmSync(home, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});

function stateFor(settingsPath: string, pid: number, endpoint = DEAD_ENDPOINT): DaemonState {
  return daemonStateFor(settingsPath, { pid, endpoint });
}

const entries = actradeckEntries;

/** 本番 merge で別 file に作った entry を event ごとに settings へ連結する (self-heal を避けて 2 endpoint を並べる)。 */
function appendEntriesFor(settingsPath: string, endpoint: string): void {
  appendEntriesForFixture(settingsPath, endpoint, { token: TOKEN });
}

interface Planted {
  readonly settingsPath: string;
  readonly statePath: string;
  readonly tokenPath: string;
  readonly stateRaw: string;
}

/** 死んだ pid の state + その endpoint を向いた配線 + hook token file (中身は値ではない印)。 */
function plant(pid = deadPid()): Planted {
  const settingsPath = resolveSettingsPath("project-local", cwd, home);
  mkdirSync(dirname(settingsPath), { recursive: true });
  writeFileSync(settingsPath, "{}");
  mergeAttachHooks({ settingsPath, endpoint: DEAD_ENDPOINT, tokenMode: "literal", token: TOKEN });
  const art = scopeArtifacts(settingsPath, home);
  writeDaemonState(art.statePath, stateFor(settingsPath, pid));
  writeFileSync(art.tokenPath, "token-file-marker", { mode: 0o600 });
  return {
    settingsPath,
    statePath: art.statePath,
    tokenPath: art.tokenPath,
    stateRaw: readFileSync(art.statePath, "utf8"),
  };
}

function ctxOf(
  _p: Planted,
  range: TeardownContext["range"],
  raw: string = _p.stateRaw,
): TeardownContext {
  return {
    target: scopeTarget("project-local", cwd, home),
    expected: { kind: "bytes", slot: "current", raw },
    range,
  };
}

function rt(logs: string[]): DaemonRuntime {
  return stubRuntime(home, logs);
}

describe("INV-ATTACH-TEARDOWN: teardownWiring は detach → state → token file の 1 本の手順 (D2)", () => {
  it("detach が失敗したら state も token file も触らない (V5: 対照 = settings が読めれば両方消える)", () => {
    const p = plant();
    writeFileSync(p.settingsPath, "{ not json");
    const res = teardownWiring(ctxOf(p, { kind: "all" }));
    expect(res.kind).toBe("detach-failed");
    expect(readFileSync(p.statePath, "utf8")).toBe(p.stateRaw);
    expect(readFileSync(p.tokenPath, "utf8")).toBe("token-file-marker");
    // 対照 (POSITIVE): 同じ形で settings が読めれば state と token file は消える。
    const q = plant();
    expect(teardownWiring(ctxOf(q, { kind: "all" }))).toEqual({
      kind: "done",
      detached: true,
      state: "removed",
      token: "removed",
    });
    expect(existsSync(q.statePath)).toBe(false);
    expect(existsSync(q.tokenPath)).toBe(false);
    expect(entries(q.settingsPath)).toEqual([]);
  });

  it("範囲 endpoint で記録外の entry が残るなら state と token file を残す (対照: 範囲 all は全部外して両方消す)", () => {
    const p = plant();
    appendEntriesFor(p.settingsPath, OTHER_ENDPOINT);
    const before = readFileSync(p.settingsPath, "utf8");
    expect(teardownWiring(ctxOf(p, { kind: "endpoint", endpoint: DEAD_ENDPOINT }))).toEqual({
      kind: "done",
      detached: true,
      state: "kept-entries-remain",
      token: "kept",
    });
    expect(entries(p.settingsPath).map(endpointOfEntry)).not.toContain(DEAD_ENDPOINT);
    expect(entries(p.settingsPath).map(endpointOfEntry)).toContain(OTHER_ENDPOINT);
    expect(readFileSync(p.statePath, "utf8")).toBe(p.stateRaw);
    expect(existsSync(p.tokenPath)).toBe(true);
    // 対照 (POSITIVE): 同じ settings を範囲 all で外すと 0 本になり、state と token file も消える。
    writeFileSync(p.settingsPath, before);
    expect(entries(p.settingsPath).map(endpointOfEntry)).toContain(DEAD_ENDPOINT);
    expect(teardownWiring(ctxOf(p, { kind: "all" }))).toMatchObject({
      state: "removed",
      token: "removed",
    });
    expect(entries(p.settingsPath)).toEqual([]);
  });

  it("判定の後に state が書き換わっていたら state も token file も残す (changed・対照: 同じ中身なら消す)", () => {
    const p = plant();
    writeDaemonState(p.statePath, stateFor(p.settingsPath, process.pid, OTHER_ENDPOINT));
    const rewritten = readFileSync(p.statePath, "utf8");
    expect(rewritten).not.toBe(p.stateRaw);
    expect(teardownWiring(ctxOf(p, { kind: "all" }))).toMatchObject({
      kind: "done",
      state: "changed",
      token: "kept",
    });
    expect(readFileSync(p.statePath, "utf8")).toBe(rewritten);
    expect(readFileSync(p.tokenPath, "utf8")).toBe("token-file-marker");
    // 対照 (POSITIVE): 比較値をいまの中身にすれば消える。
    expect(teardownWiring(ctxOf(p, { kind: "all" }, rewritten))).toMatchObject({
      state: "removed",
      token: "removed",
    });
  });

  it("state / token file が既に無ければ absent・token file を消せなければ rm-failed (対照: 通常 file は removed)", () => {
    const p = plant();
    rmSync(p.statePath);
    rmSync(p.tokenPath);
    expect(teardownWiring(ctxOf(p, { kind: "all" }))).toMatchObject({
      state: "absent",
      token: "absent",
    });
    // token file の位置に中身のある directory (rmSync は再帰しないので消せない)。
    const q = plant();
    rmSync(q.tokenPath);
    mkdirSync(join(q.tokenPath, "x"), { recursive: true });
    expect(teardownWiring(ctxOf(q, { kind: "all" }))).toMatchObject({
      state: "removed",
      token: "rm-failed",
    });
    expect(existsSync(q.tokenPath)).toBe(true);
  });
});

describe("INV-ATTACH-TEARDOWN: 後始末と daemon stop は token file の slot も片付ける・残ったら停止と報告しない (D2)", () => {
  it("拒否起動の後始末は stale なら token file を消し、生きている daemon なら触らない", () => {
    const p = plant();
    const target = scopeTarget("project-local", cwd, home);
    expect(target.artifacts.tokenPath).toBe(p.tokenPath);
    const logs: string[] = [];
    expect(cleanupStaleWiring({ target, writeApproved: true, log: (m) => logs.push(m) })).toBe(
      "detached",
    );
    expect(existsSync(p.tokenPath)).toBe(false);
    expect(logs.join("\n")).toContain(DETACHED_MSG);
    expect(logs.join("\n")).not.toContain(TOKEN_LEFT_MSG);
    // 対照: 記録 pid が自プロセス (生きている daemon) なら token file に触らない。
    const q = plant(process.pid);
    expect(cleanupStaleWiring({ target, writeApproved: true, log: () => undefined })).toBe(
      "alive-untouched",
    );
    expect(readFileSync(q.tokenPath, "utf8")).toBe("token-file-marker");
  });

  it("拒否起動の後始末: token file を消せなければ detached-token-rm-failed (「消しました」と言わない)", () => {
    const p = plant();
    rmSync(p.tokenPath);
    mkdirSync(join(p.tokenPath, "x"), { recursive: true });
    const logs: string[] = [];
    const target = scopeTarget("project-local", cwd, home);
    expect(cleanupStaleWiring({ target, writeApproved: true, log: (m) => logs.push(m) })).toBe(
      "detached-token-rm-failed",
    );
    expect(existsSync(p.statePath)).toBe(false);
    expect(logs.join("\n")).toContain(TOKEN_LEFT_MSG);
    expect(logs.join("\n")).not.toContain(DETACHED_MSG);
  });

  it("daemon stop: token file を消し stopped (対照: token file を消せなければ incomplete で「停止」と言わない)", () => {
    const p = plant();
    const logs: string[] = [];
    const stop = runStop(parseDaemonArgs(["daemon", "stop"], cwd), rt(logs));
    expect(stop).toMatchObject({ status: "stopped", state: "removed", token: "removed" });
    expect(existsSync(p.tokenPath)).toBe(false);
    expect(logs.join("\n")).toContain(STOPPED_MSG);
    expect(logs.join("\n")).not.toContain(TOKEN_LEFT_MSG);

    const q = plant();
    rmSync(q.tokenPath);
    mkdirSync(join(q.tokenPath, "x"), { recursive: true });
    const logs2: string[] = [];
    const stop2 = runStop(parseDaemonArgs(["daemon", "stop"], cwd), rt(logs2));
    expect(stop2).toMatchObject({ status: "incomplete", state: "removed", token: "rm-failed" });
    expect(entries(q.settingsPath)).toEqual([]);
    expect(logs2.join("\n")).toContain(TOKEN_LEFT_MSG);
    expect(logs2.join("\n")).not.toContain(STOPPED_MSG);
  });

  it("daemon stop: 判定の後に state が書き換わっていたら消さず incomplete (対照: 書き換えが無ければ stopped)", () => {
    const p = plant();
    let rewritten = "";
    race.fired = 0;
    race.fire = () => {
      writeDaemonState(p.statePath, stateFor(p.settingsPath, process.pid, OTHER_ENDPOINT));
      rewritten = readFileSync(p.statePath, "utf8");
    };
    const logs: string[] = [];
    const stop = runStop(parseDaemonArgs(["daemon", "stop"], cwd), rt(logs));
    expect(race.fired).toBe(1);
    expect(stop).toMatchObject({ status: "incomplete", state: "changed", token: "kept" });
    expect(readFileSync(p.statePath, "utf8")).toBe(rewritten);
    expect(readFileSync(p.tokenPath, "utf8")).toBe("token-file-marker");
    expect(logs.join("\n")).toContain(CHANGED_MSG);
    expect(logs.join("\n")).not.toContain(STOPPED_MSG);
    // 対照 (POSITIVE): 注入なしの同じ形は stopped。
    const q = plant();
    const logs2: string[] = [];
    expect(runStop(parseDaemonArgs(["daemon", "stop"], cwd), rt(logs2)).status).toBe("stopped");
    expect(existsSync(q.statePath)).toBe(false);
    expect(logs2.join("\n")).toContain(STOPPED_MSG);
    expect(logs2.join("\n")).not.toContain(CHANGED_MSG);
  });
});

describe("INV-ATTACH-TEARDOWN: inspectStaleWiring は純関数の判定 (D6)", () => {
  const SP = "/tmp/inspect-settings.json";
  const state: DaemonState = {
    pid: 4242,
    endpoint: DEAD_ENDPOINT,
    scope: "project-local",
    settingsPath: SP,
    startedAt: new Date(0).toISOString(),
    tokenMode: "literal",
  };
  const read: StateRead = { kind: "state", path: "/s.json", state, raw: "{raw}" };
  const entry = (endpoint: string, marker = true): Record<string, unknown> => ({
    type: "http",
    url: endpoint,
    ...(marker ? { [ACTRADECK_MARKER]: true } : { headers: { "X-ActraDeck-Hook-Token": "t" } }),
  });
  const settings = {
    hooks: {
      PreToolUse: [
        { hooks: [entry(DEAD_ENDPOINT), { type: "command", command: "echo user" }] },
        { hooks: [entry(OTHER_ENDPOINT, false)] },
      ],
      Stop: [{ hooks: [entry(DEAD_ENDPOINT)] }],
    },
  };

  interface InspectRow {
    readonly name: string;
    readonly read: StateRead;
    readonly liveness?: ProcessLiveness;
    readonly kind: "no-state" | "corrupt" | "alive" | "stale";
    readonly entries: { recorded: number; other: number };
  }
  const ROWS: readonly InspectRow[] = [
    {
      name: "absent",
      read: { kind: "absent" },
      kind: "no-state",
      entries: { recorded: 0, other: 3 },
    },
    {
      name: "corrupt",
      read: { kind: "corrupt", path: "/s.json", raw: "{" },
      kind: "corrupt",
      entries: { recorded: 0, other: 3 },
    },
    { name: "alive", read, liveness: "alive", kind: "alive", entries: { recorded: 2, other: 1 } },
    {
      name: "unknown",
      read,
      liveness: "unknown",
      kind: "alive",
      entries: { recorded: 2, other: 1 },
    },
    { name: "dead", read, liveness: "dead", kind: "stale", entries: { recorded: 2, other: 1 } },
  ];
  let executed = 0;
  afterAll(() => {
    expect(executed).toBe(ROWS.length);
  });

  for (const row of ROWS) {
    it(`${row.name} → ${row.kind} (生存の述語は state があるときだけ 1 回・件数は記録 endpoint とそれ以外)`, () => {
      const calls: DaemonState[] = [];
      const res = inspectStaleWiring({
        read: row.read,
        settings,
        isDaemonProcess: (s) => {
          calls.push(s);
          return row.liveness ?? "alive";
        },
      });
      expect(res.kind).toBe(row.kind);
      expect(res.entries).toEqual(row.entries);
      expect(calls).toEqual(row.read.kind === "state" ? [row.read.state] : []);
      if (res.kind === "alive" || res.kind === "stale") {
        expect(res.liveness).toBe(row.liveness);
        expect(res.raw).toBe("{raw}");
      }
      // settings を渡さなければ件数を出さない (読めない settings を 0 本と言わない)。
      expect(
        inspectStaleWiring({ read: row.read, settings: undefined, isDaemonProcess: () => "dead" }),
      ).not.toHaveProperty("entries");
      executed += 1;
    });
  }

  it("件数は endpointOfEntry と同じ取り出し (countActradeckEntries・legacy 署名も ActraDeck entry として数える)", () => {
    expect(countActradeckEntries(settings, DEAD_ENDPOINT)).toEqual({ recorded: 2, other: 1 });
    expect(countActradeckEntries(settings, undefined)).toEqual({ recorded: 0, other: 3 });
    expect(endpointOfEntry(entry(OTHER_ENDPOINT, false))).toBe(OTHER_ENDPOINT);
    expect(endpointOfEntry({ type: "command", command: "x" })).toBeUndefined();
  });

  it("daemon status は件数を返す (settings を読む・表示は変えない)", () => {
    const p = plant();
    appendEntriesFor(p.settingsPath, OTHER_ENDPOINT);
    const all = entries(p.settingsPath);
    const recorded = all.filter((e) => endpointOfEntry(e) === DEAD_ENDPOINT).length;
    expect(recorded).toBeGreaterThan(0);
    const status = runStatus(parseDaemonArgs(["daemon", "status"], cwd), rt([]));
    expect(status).toMatchObject({
      running: false,
      liveness: "dead",
      entries: { recorded, other: all.length - recorded },
    });
  });
});

describe("INV-ATTACH-TEARDOWN: state の endpoint の受理集合は hook shim と同じ (TDA-STA-6 (a))", () => {
  const VECTORS = [
    "http://127.0.0.1:1/hook",
    "http://127.0.0.1:65535/hook",
    "http://127.0.0.1:41234/hook",
    "http://127.0.0.1:0/hook",
    "http://127.0.0.1:65536/hook",
    "http://127.0.0.1:080/hook",
    "http://127.0.0.1:00080/hook",
    "http://127.0.0.1:099999/hook",
    "http://127.0.0.1/hook",
    "http://localhost:8080/hook",
    "http://[::1]:8080/hook",
    "http://127.0.0.2:8080/hook",
    "https://127.0.0.1:8080/hook",
    "http://127.0.0.1:8080/hook/x",
    "http://127.0.0.1:8080/hook?",
    "xhttp://127.0.0.1:8080/hook",
    "http://127x0x0x1:8080/hook",
  ] as const;
  const shimAccepts = (endpoint: string): boolean => {
    try {
      parseHookShimArgs([
        "--endpoint",
        endpoint,
        "--event",
        "PreToolUse",
        "--deadline-ms",
        "1000",
        "--token-env",
        "ACTRADECK_HOOK_TOKEN",
      ]);
      return true;
    } catch {
      return false;
    }
  };

  it("vector ごとに daemon 側 (isDaemonHookEndpoint・state の検証) と shim の受理が一致する", () => {
    expect(new Set(VECTORS).size).toBe(VECTORS.length);
    let accepted = 0;
    for (const v of VECTORS) {
      expect(isDaemonHookEndpoint(v), v).toBe(shimAccepts(v));
      const st = asDaemonState(
        { ...stateFor("/tmp/s.json", 4242), endpoint: v, settingsPath: "/tmp/s.json" },
        { settingsPath: "/tmp/s.json", scopes: ["project-local"] },
      );
      expect(st !== undefined, v).toBe(shimAccepts(v));
      if (shimAccepts(v)) accepted += 1;
    }
    // 両側に受理と拒否の両方がある (恒真・恒偽の述語で一致しないように)。
    expect(accepted).toBe(3);
    // 先頭 0 の port は両側とも拒否 (旧 state 検証は受理していた・同一リテラルの POSITIVE は 80)。
    expect(isDaemonHookEndpoint("http://127.0.0.1:080/hook")).toBe(false);
    expect(isDaemonHookEndpoint("http://127.0.0.1:80/hook")).toBe(true);
  });
});

describe("INV-ATTACH-TEARDOWN: 拒否の結果は後始末の結果を型で必須に持つ (D4 型床)", () => {
  it("cleanup の無い拒否・リテラルの cleanup は型検査で落ちる (tsc -p tsconfig.test.json・実行はしない)", () => {
    const directDeny = (): StartOutcome =>
      // @ts-expect-error 拒否は cleanup (module の外では cleanupStaleWiring の戻り値) を持たないと返せない
      ({ status: "denied-token-leak", settingsPath: "/s", statePath: "/p" });
    const literalCleanup = (): StartOutcome => ({
      status: "denied-token-leak",
      // @ts-expect-error StaleCleanup は brand 付きで、リテラルからは作れない
      cleanup: "detached",
      settingsPath: "/s",
      statePath: "/p",
    });
    expect(typeof directDeny).toBe("function");
    expect(typeof literalCleanup).toBe("function");
    // 対照 (POSITIVE): cleanupStaleWiring が返した値なら拒否の結果に載せられる。
    const target = scopeTarget("project-local", cwd, home);
    const cleanup = cleanupStaleWiring({ target, writeApproved: true, log: () => undefined });
    const ok: StartOutcome = {
      status: "denied-token-leak",
      cleanup,
      settingsPath: target.settingsPath,
      statePath: target.artifacts.statePath,
    };
    expect(ok.status).toBe("denied-token-leak");
    expect(cleanup).toBe("no-state");
  });

  it("detach の範囲は必須 (既定値なし・TDA-DC-R2-4・実行はしない)", () => {
    const noRange = (): unknown =>
      // @ts-expect-error detach の範囲を渡し忘れた呼び出しは型検査で落ちる
      detachAttachHooks("/x");
    const noTeardownRange = (): unknown =>
      // @ts-expect-error teardownWiring の範囲も必須
      teardownWiring({
        target: scopeTarget("project-local", cwd, home),
        expected: { kind: "absent" },
      });
    expect(typeof noRange).toBe("function");
    expect(typeof noTeardownRange).toBe("function");
    // 対照 (POSITIVE): 範囲を渡せば通る (settings が無いので何も外さない)。
    expect(detachAttachHooks(join(cwd, "absent.json"), { kind: "all" }).removed).toBe(false);
  });
});

/** 生きている子プロセス (記録 daemon の代役)。自分で起動したものだけを止める。 */
async function spawnChild(): Promise<{ pid: number; exited: Promise<void> }> {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
  children.push(child);
  const exited = new Promise<void>((r) => child.once("exit", () => r()));
  await new Promise((r) => setTimeout(r, 200));
  expect(child.pid).toBeGreaterThan(0);
  return { pid: child.pid as number, exited };
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** 子プロセスを記録 daemon とした state (子の同一性つき) + その endpoint の配線 + token file。 */
function plantFor(pid: number): Planted {
  const p = plant(pid);
  const bootId = defaultIdentitySources.readBootId();
  const startTicks = defaultIdentitySources.readStartTicks(pid);
  const { procIdentity: _self, ...rest } = stateFor(p.settingsPath, pid);
  void _self;
  writeDaemonState(p.statePath, {
    ...rest,
    ...(bootId !== undefined && startTicks !== undefined
      ? { procIdentity: { bootId, startTicks } }
      : {}),
  });
  return { ...p, stateRaw: readFileSync(p.statePath, "utf8") };
}

/** 後始末が配線を外した後だけ「記録 pid は終了した」と答える同一性の源 (detach の間の終了 / pid 再利用)。 */
function diesDuringDetach(settingsPath: string): IdentitySources {
  return {
    ...defaultIdentitySources,
    signal0: (pid) =>
      entries(settingsPath).length > 0 ? defaultIdentitySources.signal0(pid) : "esrch",
  };
}

/**
 * 後始末が配線を外した後だけ start ticks の答えを `after` に変える同一性の源 (SEC-TD-1 の R1 evidence と同じ形:
 * `after = ticks + 1` は pid 再利用、`after = undefined` は ticks が読めない = 同一性 unknown)。
 */
function ticksChangeDuringDetach(
  settingsPath: string,
  ticks: number,
  after: number | undefined,
): IdentitySources {
  return {
    ...defaultIdentitySources,
    readStartTicks: (pid) =>
      pid === "self"
        ? defaultIdentitySources.readStartTicks(pid)
        : entries(settingsPath).length > 0
          ? ticks
          : after,
  };
}

describe("INV-ATTACH-TEARDOWN: daemon stop の SIGTERM は後始末の後・送る直前に同一性を確かめ直す (SEC-TD-1 / QA-TD-1)", () => {
  it.runIf(LINUX)(
    "後始末の間に pid が再利用された (start ticks +1)・同一性を確かめられなくなった (ticks が読めない) なら送らない (SEC-TD-R2-1: R1 の evidence の形・対照: 変わらなければ送る)",
    async () => {
      const child = await spawnChild();
      const ticks = defaultIdentitySources.readStartTicks(child.pid);
      expect(ticks).toBeTypeOf("number");
      const t = ticks as number;
      const stop = (identity: IdentitySources) =>
        runStop(parseDaemonArgs(["daemon", "stop"], cwd), { ...rt([]), identity });

      const p = plantFor(child.pid);
      const reused = stop(ticksChangeDuringDetach(p.settingsPath, t, t + 1));
      expect(reused).toMatchObject({ status: "stopped", kill: "skipped-dead" });
      expect(reused.killedPid).toBeUndefined();

      const q = plantFor(child.pid);
      const unknown = stop(ticksChangeDuringDetach(q.settingsPath, t, undefined));
      expect(unknown).toMatchObject({ status: "stopped", kill: "skipped-identity-unknown" });
      expect(unknown.killedPid).toBeUndefined();
      await new Promise((r) => setTimeout(r, 200));
      expect(isRunning(child.pid)).toBe(true);

      // 対照 (POSITIVE): 同じ注入の形で ticks が変わらなければ送り、子は終了する。
      const r = plantFor(child.pid);
      const same = stop(ticksChangeDuringDetach(r.settingsPath, t, t));
      expect(same).toMatchObject({ status: "stopped", kill: "sent", killedPid: child.pid });
      await child.exited;
      expect(isRunning(child.pid)).toBe(false);
    },
  );

  it("後始末の間に記録 daemon が終了したら送らない (対照: 終了していなければ送る)", async () => {
    const child = await spawnChild();
    const p = plantFor(child.pid);
    const stop = runStop(parseDaemonArgs(["daemon", "stop"], cwd), {
      ...rt([]),
      identity: diesDuringDetach(p.settingsPath),
    });
    expect(stop).toMatchObject({ status: "stopped", kill: "skipped-dead" });
    expect(stop.killedPid).toBeUndefined();
    await new Promise((r) => setTimeout(r, 200));
    expect(isRunning(child.pid)).toBe(true);
    // 対照 (POSITIVE): 同じ子・同じ形で、同一性が変わらなければ送り、子は終了する。
    plantFor(child.pid);
    const stop2 = runStop(parseDaemonArgs(["daemon", "stop"], cwd), rt([]));
    expect(stop2).toMatchObject({ status: "stopped", kill: "sent", killedPid: child.pid });
    await child.exited;
    expect(isRunning(child.pid)).toBe(false);
  });

  it("detach が失敗したら投げ、記録 daemon には送らず state / token file / settings も変えない (対照: 読めれば stopped で送る)", async () => {
    const child = await spawnChild();
    const p = plantFor(child.pid);
    writeFileSync(p.settingsPath, "{ not json");
    expect(() => runStop(parseDaemonArgs(["daemon", "stop"], cwd), rt([]))).toThrow();
    await new Promise((r) => setTimeout(r, 200));
    expect(isRunning(child.pid)).toBe(true);
    expect(readFileSync(p.statePath, "utf8")).toBe(p.stateRaw);
    expect(readFileSync(p.tokenPath, "utf8")).toBe("token-file-marker");
    expect(readFileSync(p.settingsPath, "utf8")).toBe("{ not json");
    // 対照 (POSITIVE): settings が読めれば同じ子に対して stopped で送る。
    const q = plantFor(child.pid);
    const stop = runStop(parseDaemonArgs(["daemon", "stop"], cwd), rt([]));
    expect(stop).toMatchObject({
      status: "stopped",
      kill: "sent",
      state: "removed",
      token: "removed",
    });
    expect(entries(q.settingsPath)).toEqual([]);
    await child.exited;
    expect(isRunning(child.pid)).toBe(false);
  });
});

describe("INV-ATTACH-TEARDOWN: 判定の後に state が無くなっていた場合の結果値 (TDA-TD-2 ≡ QA-TD-2)", () => {
  /** 後始末が state を消せなかった (無くなっていた) ときの文言。 */
  const ABSENT_MSG = "state は判定の後に無くなっていました";

  it("拒否起動の後始末は detached-state-absent を返す (detached / changed と言わない)", () => {
    const p = plant();
    race.fired = 0;
    race.fire = () => rmSync(p.statePath);
    const logs: string[] = [];
    const target = scopeTarget("project-local", cwd, home);
    expect(cleanupStaleWiring({ target, writeApproved: true, log: (m) => logs.push(m) })).toBe(
      "detached-state-absent",
    );
    expect(race.fired).toBe(1);
    expect(entries(p.settingsPath)).toEqual([]);
    expect(existsSync(p.tokenPath)).toBe(false);
    const log = logs.join("\n");
    expect(log).toContain(ABSENT_MSG);
    expect(log).not.toContain(DETACHED_MSG);
    expect(log).not.toContain(CHANGED_MSG);
  });

  it("daemon stop は state が既に無くても後始末を終えたら stopped (incomplete と言わない)", () => {
    const p = plant();
    race.fired = 0;
    race.fire = () => rmSync(p.statePath);
    const logs: string[] = [];
    const stop = runStop(parseDaemonArgs(["daemon", "stop"], cwd), rt(logs));
    expect(race.fired).toBe(1);
    expect(stop).toMatchObject({ status: "stopped", state: "absent", token: "removed" });
    expect(logs.join("\n")).toContain(STOPPED_MSG);
  });
});

describe("INV-ATTACH-TEARDOWN: 後始末は scopeTarget() が発行した target だけを受け取る (SEC-TD-2 ≡ TDA-TD-1)", () => {
  it("artifacts はそのまま settingsPath だけ差し替えた target・凍結し直した spread も拒否する (SEC-TD-R2-2: R1 の vector・対照: 発行した target は通る)", () => {
    const p = plant();
    const real = scopeTarget("project-local", cwd, home);
    // R1 の vector 2: 別の settings を detach させる。
    const other = join(cwd, "other-settings.json");
    writeFileSync(other, "{}");
    mergeAttachHooks({
      settingsPath: other,
      endpoint: DEAD_ENDPOINT,
      tokenMode: "literal",
      token: TOKEN,
    });
    const otherBefore = readFileSync(other, "utf8");
    expect(otherBefore).toContain(DEAD_ENDPOINT);
    const sameArtifacts: ScopeTarget = { ...real, settingsPath: other };
    expect(sameArtifacts.artifacts).toBe(real.artifacts);
    expect(() =>
      cleanupStaleWiring({ target: sameArtifacts, writeApproved: true, log: () => undefined }),
    ).toThrow("scopeTarget() が発行したもの");
    expect(readFileSync(other, "utf8")).toBe(otherBefore);
    // 凍結した spread (凍結しているかでは見分けない)。
    const victim = join(cwd, "victim-frozen.txt");
    writeFileSync(victim, "precious");
    const frozenForged: ScopeTarget = Object.freeze({
      ...real,
      artifacts: Object.freeze({ ...real.artifacts, tokenPath: victim }),
    });
    expect(Object.isFrozen(frozenForged)).toBe(true);
    expect(() =>
      cleanupStaleWiring({ target: frozenForged, writeApproved: true, log: () => undefined }),
    ).toThrow("scopeTarget() が発行したもの");
    expect(readFileSync(victim, "utf8")).toBe("precious");
    expect(readFileSync(p.statePath, "utf8")).toBe(p.stateRaw);
    // 対照 (POSITIVE): 発行した target は通り、自分の settings だけを外す (other と victim は残る)。
    expect(cleanupStaleWiring({ target: real, writeApproved: true, log: () => undefined })).toBe(
      "detached",
    );
    expect(entries(p.settingsPath)).toEqual([]);
    expect(readFileSync(other, "utf8")).toBe(otherBefore);
    expect(readFileSync(victim, "utf8")).toBe("precious");
  });

  it("spread で path を差し替えた target は throw で拒否し、導出外の file に触れない (対照: 発行した target は通る)", () => {
    const p = plant();
    const victim = join(cwd, "victim.txt");
    writeFileSync(victim, "precious");
    const real = scopeTarget("project-local", cwd, home);
    // brand 型だけなら cast なしに書ける形 (型検査は通る)。
    const forged: ScopeTarget = { ...real, artifacts: { ...real.artifacts, tokenPath: victim } };
    expect(forged.artifacts.tokenPath).toBe(victim);
    expect(() =>
      cleanupStaleWiring({ target: forged, writeApproved: true, log: () => undefined }),
    ).toThrow("scopeTarget() が発行したもの");
    expect(readFileSync(victim, "utf8")).toBe("precious");
    expect(readFileSync(p.statePath, "utf8")).toBe(p.stateRaw);
    // 発行した target は凍結されていて、書き換えて偽造することもできない (artifacts / scopes も)。
    expect(() => {
      (real.artifacts as { tokenPath: string }).tokenPath = victim;
    }).toThrow(TypeError);
    expect(() => {
      (real as { settingsPath: string }).settingsPath = victim;
    }).toThrow(TypeError);
    expect(Object.isFrozen(real.scopes)).toBe(true);
    expect(real.artifacts.tokenPath).not.toBe(victim);
    expect(real.settingsPath).not.toBe(victim);
    // 対照 (POSITIVE): 発行した target は通り (stale なので detached)、token slot は導出した path だけを消す。
    expect(cleanupStaleWiring({ target: real, writeApproved: true, log: () => undefined })).toBe(
      "detached",
    );
    expect(existsSync(p.tokenPath)).toBe(false);
    expect(readFileSync(victim, "utf8")).toBe("precious");
  });
});

describe("INV-ATTACH-TEARDOWN: detach の後に lock を共有しない書き手が書いた配線・判定の後の state の変化は結果値で報告する・入力は発行した target から導出する (裁定 01a11052 ① / ② / SEC-TD-R2-3 / SEC-TD-4)", () => {
  it("範囲 all の detach の後に配線が書かれたら、settings を読み直して state と token file を残す (R2 ガード・対照: 書かれなければ消す)", () => {
    const p = plant();
    bypass.fired = 0;
    bypass.afterDetach = () => appendEntriesFor(p.settingsPath, OTHER_ENDPOINT);
    expect(teardownWiring(ctxOf(p, { kind: "all" }))).toEqual({
      kind: "done",
      detached: true,
      state: "kept-entries-remain",
      token: "kept",
    });
    expect(bypass.fired).toBe(1);
    expect(readFileSync(p.statePath, "utf8")).toBe(p.stateRaw);
    expect(readFileSync(p.tokenPath, "utf8")).toBe("token-file-marker");
    // 拒否起動の後始末も同じ値を返し、state を残して案内する。
    const q = plant();
    bypass.afterDetach = () => appendEntriesFor(q.settingsPath, OTHER_ENDPOINT);
    const logs: string[] = [];
    const target = scopeTarget("project-local", cwd, home);
    expect(cleanupStaleWiring({ target, writeApproved: true, log: (m) => logs.push(m) })).toBe(
      "detached-entries-remain",
    );
    expect(readFileSync(q.statePath, "utf8")).toBe(q.stateRaw);
    expect(logs.join("\n")).toContain("ActraDeck hook 配線が残っているため、state は残します");
    expect(logs.join("\n")).not.toContain(DETACHED_MSG);
    // 対照 (POSITIVE): 書き手が居なければ同じ形で消し、「消しました」と言う。
    plant();
    const logs2: string[] = [];
    expect(cleanupStaleWiring({ target, writeApproved: true, log: (m) => logs2.push(m) })).toBe(
      "detached",
    );
    expect(logs2.join("\n")).toContain(DETACHED_MSG);
    expect(logs2.join("\n")).not.toContain("ActraDeck hook 配線が残っているため、state は残します");
  });

  it("daemon stop: 範囲 all の detach の後に配線が書かれたら state を残し incomplete (終了コード 1 の列挙の根拠・対照: 書かれなければ stopped)", () => {
    const p = plant();
    bypass.fired = 0;
    bypass.afterDetach = () => appendEntriesFor(p.settingsPath, OTHER_ENDPOINT);
    const logs: string[] = [];
    const stop = runStop(parseDaemonArgs(["daemon", "stop"], cwd), rt(logs));
    expect(bypass.fired).toBe(1);
    expect(stop).toMatchObject({
      status: "incomplete",
      state: "kept-entries-remain",
      token: "kept",
    });
    expect(stopOutcomeExitCode(stop)).toBe(1);
    expect(readFileSync(p.statePath, "utf8")).toBe(p.stateRaw);
    expect(logs.join("\n")).not.toContain(STOPPED_MSG);
    // 対照 (POSITIVE): 書き手が居なければ同じ形で stopped (終了コード 0)。
    const q = plant();
    const logs2: string[] = [];
    const ok = runStop(parseDaemonArgs(["daemon", "stop"], cwd), rt(logs2));
    expect(ok).toMatchObject({ status: "stopped", state: "removed" });
    expect(stopOutcomeExitCode(ok)).toBe(0);
    expect(existsSync(q.statePath)).toBe(false);
    expect(logs2.join("\n")).toContain(STOPPED_MSG);
  });

  it("判定の時点で absent なら state の段を通らない (後から現れた state を消さない)・unreadable は読めるようになった state を消さない", () => {
    const p = plant();
    const target = scopeTarget("project-local", cwd, home);
    // absent: detach はするが、その後に在る state も token file も消さない。
    expect(
      teardownWiring({ target, expected: { kind: "absent" }, range: { kind: "all" } }),
    ).toEqual({ kind: "done", detached: true, state: "untouched", token: "kept" });
    expect(readFileSync(p.statePath, "utf8")).toBe(p.stateRaw);
    expect(readFileSync(p.tokenPath, "utf8")).toBe("token-file-marker");
    // unreadable: いま読める state は「判定の時点で読めなかった」ものと違うので changed (消さない)。
    const q = plant();
    expect(
      teardownWiring({
        target,
        expected: { kind: "unreadable", slot: "current" },
        range: { kind: "all" },
      }),
    ).toMatchObject({ state: "changed", token: "kept" });
    expect(readFileSync(q.statePath, "utf8")).toBe(q.stateRaw);
    // 対照 (POSITIVE): bytes で判定したバイト列なら消す。
    expect(
      teardownWiring({
        target,
        expected: { kind: "bytes", slot: "current", raw: q.stateRaw },
        range: { kind: "all" },
      }),
    ).toMatchObject({ state: "removed", token: "removed" });
  });

  it("expectedStateOf は target の 2 つの置き場 (current / legacy) だけを受け入れる・teardownWiring は発行していない target を拒否する", () => {
    const target = scopeTarget("project-local", cwd, home);
    expect(expectedStateOf(target, { path: target.artifacts.statePath, raw: "x" })).toEqual({
      kind: "bytes",
      slot: "current",
      raw: "x",
    });
    expect(expectedStateOf(target, { path: target.artifacts.statePath })).toEqual({
      kind: "unreadable",
      slot: "current",
    });
    expect(expectedStateOf(target, { kind: "absent" })).toEqual({ kind: "absent" });
    expect(() => expectedStateOf(target, { path: join(cwd, "elsewhere.json"), raw: "x" })).toThrow(
      "導出したものではありません",
    );
    // 旧い dist の置き場 (symlink 経由の cwd では statePath と別 path)。
    const link = join(home, "cwd-link");
    symlinkSync(cwd, link);
    const viaLink = scopeTarget("project-local", link, home);
    expect(viaLink.artifacts.legacyStatePath).not.toBe(viaLink.artifacts.statePath);
    expect(expectedStateOf(viaLink, { path: viaLink.artifacts.legacyStatePath, raw: "y" })).toEqual(
      { kind: "bytes", slot: "legacy", raw: "y" },
    );
    // 発行していない target (spread) は teardownWiring の入口で throw し、settings にも触らない。
    const p = plant();
    const before = readFileSync(p.settingsPath, "utf8");
    const forged: ScopeTarget = { ...target };
    expect(() =>
      teardownWiring({ target: forged, expected: { kind: "absent" }, range: { kind: "all" } }),
    ).toThrow("scopeTarget() が発行したもの");
    expect(readFileSync(p.settingsPath, "utf8")).toBe(before);
  });

  it("後始末: state が判定の後に無くなり token file も消せなかったら、token の失敗も報告する (SEC-TD-4・対照: token が消せれば言わない)", () => {
    const p = plant();
    rmSync(p.tokenPath);
    mkdirSync(join(p.tokenPath, "x"), { recursive: true });
    race.fired = 0;
    race.fire = () => rmSync(p.statePath);
    const logs: string[] = [];
    const target = scopeTarget("project-local", cwd, home);
    expect(cleanupStaleWiring({ target, writeApproved: true, log: (m) => logs.push(m) })).toBe(
      "detached-state-absent",
    );
    expect(race.fired).toBe(1);
    expect(logs.join("\n")).toContain(TOKEN_LEFT_MSG);
    // 対照 (POSITIVE): token file が消せれば同じ枝で token の文言を出さない。
    rmSync(p.tokenPath, { recursive: true, force: true });
    const q = plant();
    race.fire = () => rmSync(q.statePath);
    const logs2: string[] = [];
    expect(cleanupStaleWiring({ target, writeApproved: true, log: (m) => logs2.push(m) })).toBe(
      "detached-state-absent",
    );
    expect(existsSync(q.tokenPath)).toBe(false);
    expect(logs2.join("\n")).not.toContain(TOKEN_LEFT_MSG);
  });
});

describe("INV-ATTACH-TEARDOWN: daemon status の件数は state が無くても返し、読めない settings を 0 本と言わない (QA-TD-3)", () => {
  it("state が無い: settings の ActraDeck entry を other として数える (対照: entry が無ければ 0 本)", () => {
    const p = plant();
    rmSync(p.statePath);
    const n = entries(p.settingsPath).length;
    expect(n).toBeGreaterThan(0);
    const status = runStatus(parseDaemonArgs(["daemon", "status"], cwd), rt([]));
    expect(status).toMatchObject({ running: false, entries: { recorded: 0, other: n } });
    expect(status).not.toHaveProperty("state");
    // 対照 (POSITIVE): state があれば status は state を返す。
    const q = plant();
    expect(runStatus(parseDaemonArgs(["daemon", "status"], cwd), rt([]))).toHaveProperty("state");
    rmSync(q.statePath);
    writeFileSync(p.settingsPath, "{}");
    expect(runStatus(parseDaemonArgs(["daemon", "status"], cwd), rt([]))).toMatchObject({
      running: false,
      entries: { recorded: 0, other: 0 },
    });
  });

  it("settings が読めない (JSON でない) なら entries を返さない (対照: 読めれば返す)", () => {
    const p = plant();
    writeFileSync(p.settingsPath, "{ not json");
    const unreadable = runStatus(parseDaemonArgs(["daemon", "status"], cwd), rt([]));
    expect(unreadable).toMatchObject({ running: false, liveness: "dead" });
    expect(unreadable).not.toHaveProperty("entries");
    rmSync(p.statePath);
    expect(runStatus(parseDaemonArgs(["daemon", "status"], cwd), rt([]))).not.toHaveProperty(
      "entries",
    );
    // 対照 (POSITIVE): 同じ形で settings が読めれば entries を返す。
    writeFileSync(p.settingsPath, "{}");
    expect(runStatus(parseDaemonArgs(["daemon", "status"], cwd), rt([]))).toHaveProperty("entries");
  });
});
