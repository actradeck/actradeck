/**
 * INV-ATTACH-TEARDOWN (task 01a10c42 PR-B1・Triangle ADR 01a10ddb D2 / D4 / D6)。
 *
 * - D2 `teardownWiring`: 配線の後始末は 1 本の手順で、順序は detach → state → hook token file。detach が
 *   失敗したら state も token file も触らない。範囲は必須の判別 union。detach の後も ActraDeck entry が
 *   残るなら state と token file を残す。判定の後に state が書き換わっていたら token file も残す。
 *   拒否起動の後始末 (cleanupStaleWiring) と `daemon stop` (runStop) が共有し、token file の slot
 *   (`scopeArtifacts().tokenPath`) もここで消す。runStop は state / token file が残ったら「停止しました」と
 *   報告しない。
 * - D4 型床: 拒否の結果 (DeniedOutcome) は後始末の結果 (cleanupStaleWiring だけが作る brand 型) を必須で
 *   持つ。直に返す拒否は型検査 (tsc -p tsconfig.test.json) で落ちる。
 * - D6 `inspectStaleWiring`: 判定は純関数 (state の読み取り結果 + settings + 生存の述語)。
 * - TDA-STA-6 (a): state が受け入れる endpoint の形は hook shim と同じ受理集合。
 *
 * すべて temp HOME / temp cwd で動かす (実 ~/.claude・~/.actradeck に触れない)。
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
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
  type StartOutcome,
} from "../src/daemon-cli.js";
import {
  asDaemonState,
  canonicalSettingsPath,
  type DaemonState,
  scopeArtifacts,
  type StateRead,
  writeDaemonState,
} from "../src/daemon-state.js";
import { parseHookShimArgs } from "../src/hook-shim-core.js";
import { captureSelfIdentity, type ProcessLiveness } from "../src/process-identity.js";
import {
  ACTRADECK_MARKER,
  countActradeckEntries,
  detachAttachHooks,
  endpointOfEntry,
  isActradeckEntry,
  isDaemonHookEndpoint,
  mergeAttachHooks,
} from "../src/settings-merge.js";

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
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "actradeck-teardown-home-"));
  cwd = mkdtempSync(join(tmpdir(), "actradeck-teardown-cwd-"));
});
afterEach(() => {
  race.fire = undefined;
  rmSync(home, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});

function deadPid(): number {
  const pid = spawnSync(process.execPath, ["-e", ""]).pid;
  expect(() => process.kill(pid, 0)).toThrow(/ESRCH/);
  return pid;
}

function stateFor(settingsPath: string, pid: number, endpoint = DEAD_ENDPOINT): DaemonState {
  const identity = captureSelfIdentity();
  return {
    pid,
    endpoint,
    scope: "project-local",
    settingsPath: canonicalSettingsPath(settingsPath),
    startedAt: new Date().toISOString(),
    tokenMode: "literal",
    ...(identity !== undefined ? { procIdentity: identity } : {}),
  };
}

function entries(settingsPath: string): unknown[] {
  const s = JSON.parse(readFileSync(settingsPath, "utf8")) as {
    hooks?: Record<string, Array<{ hooks?: unknown[] }>>;
  };
  return Object.values(s.hooks ?? {})
    .flat()
    .flatMap((g) => g.hooks ?? [])
    .filter(isActradeckEntry);
}

/** 本番 merge で別 file に作った entry を event ごとに settings へ連結する (self-heal を避けて 2 endpoint を並べる)。 */
function appendEntriesFor(settingsPath: string, endpoint: string): void {
  const other = join(dirname(settingsPath), `other-${Date.now()}.json`);
  mergeAttachHooks({ settingsPath: other, endpoint, tokenMode: "literal", token: TOKEN });
  const a = JSON.parse(readFileSync(settingsPath, "utf8")) as { hooks: Record<string, unknown[]> };
  const b = JSON.parse(readFileSync(other, "utf8")) as { hooks: Record<string, unknown[]> };
  for (const [ev, groups] of Object.entries(b.hooks))
    a.hooks[ev] = [...(a.hooks[ev] ?? []), ...groups];
  writeFileSync(settingsPath, JSON.stringify(a));
  rmSync(other, { force: true });
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

function ctxOf(p: Planted, range: TeardownContext["range"]): TeardownContext {
  return {
    settingsPath: p.settingsPath,
    statePath: p.statePath,
    tokenPath: p.tokenPath,
    expectedRaw: p.stateRaw,
    range,
  };
}

function rt(logs: string[]): DaemonRuntime {
  return {
    home,
    log: (m) => logs.push(m),
    startDaemon: () => Promise.reject(new Error("unused")),
  };
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
    expect(teardownWiring({ ...ctxOf(p, { kind: "all" }), expectedRaw: rewritten })).toMatchObject({
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
      // @ts-expect-error 拒否は cleanup (cleanupStaleWiring だけが作る) を持たないと返せない
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
      teardownWiring({ settingsPath: "/s", statePath: "/p", tokenPath: "/t", expectedRaw: "" });
    expect(typeof noRange).toBe("function");
    expect(typeof noTeardownRange).toBe("function");
    // 対照 (POSITIVE): 範囲を渡せば通る (settings が無いので何も外さない)。
    expect(detachAttachHooks(join(cwd, "absent.json"), { kind: "all" }).removed).toBe(false);
  });
});
