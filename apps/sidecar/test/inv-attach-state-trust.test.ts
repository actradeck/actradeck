/**
 * INV-ATTACH-STATE-TRUST (Triangle ADR 01a10ddb D3 / D7・task 01a10c42 PR-A)。
 *
 * - V9: scope の artifact path は settings path から導出する。正規化は親 dir だけを realpath し file 名は
 *   そのまま (改訂 D3・裁定 01a10e44)。symlink 経由の cwd と物理 cwd は同じ state を指す。symlink を含まない
 *   path では旧 `scopeHash(settingsPath)` と同値 (互換)。
 * - V10: state の形検証は `asDaemonState` 1 か所・reader は `readState` 1 本 (absent | corrupt | state)。
 *   legacy の `wiredSettingsPaths` は導出 settings path と一致する要素 1 個の配列だけを受理する。
 * - corrupt: 拒否起動の後始末は書かずに `state-invalid`・`daemon stop` は全 detach + state 削除で kill しない。
 * - V8: `daemon stop` は記録 pid が記録した daemon と同一だと確かめられたときだけ SIGTERM を送る。生きている
 *   無関係の子プロセス (自分で spawn したもの) の pid を state に入れても、その子は止まらない。
 * - upgrade の窓: 新しい path に state が無いときは、旧い dist の path (symlink を解決しない settings path の
 *   scopeHash) を reader の中で読む。start / stop / status / 拒否起動の後始末がすべて同じ reader を通る。
 * - cwd が home: project と user が同じ settings file を指すときは、どちらの scope ラベルの state も受け入れる
 *   (別 file を指す scope のラベルは corrupt のまま)。user scope はどの cwd からでも project ラベルを受け入れる。
 * - settings file 自体が symlink (dotfiles) でも、正規化は親 dir だけなので起動前後で state path が変わらない
 *   (実 attach CLI で固定・裁定 01a10e44 の D3 改訂)。
 * - 時計ずれ: procIdentity の無い旧 state を etime で「許容より後に起動」と見たとき、Linux では unknown。
 *
 * temp HOME / temp cwd で動かす (実 ~/.claude・~/.actradeck に触れない)。signal は自分で spawn した子にだけ届く。
 */
import { type ChildProcess, spawn } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

import { AttachDaemon } from "../src/attach-daemon.js";
import {
  type AttachScope,
  cleanupStaleWiring,
  type DaemonRuntime,
  parseDaemonArgs,
  resolveSettingsPath,
  runStart,
  runStatus,
  runStop,
  scopeTarget,
} from "../src/daemon-cli.js";
import {
  type DaemonState,
  readState,
  scopeArtifacts,
  scopeHash,
  writeDaemonState,
} from "../src/daemon-state.js";
import {
  defaultIdentitySources,
  type IdentitySources,
  isDaemonProcess,
  parseEtimeSeconds,
  parseStartTicks,
  type ProcIdentity,
  type Signal0Result,
} from "../src/process-identity.js";
import { mergeAttachHooks } from "../src/settings-merge.js";

import {
  actradeckEntries,
  type AttachCli,
  daemonStateFor,
  deadPid as deadPidFixture,
  killAttachCli,
  startAttachCli as startAttachCliFixture,
  stubRuntime,
} from "./helpers/attach-fixtures.js";

const LINUX = process.platform === "linux";
const DEAD_ENDPOINT = "http://127.0.0.1:9/hook";
const TOKEN = "tok-state-trust-0123456789abcdef01234";
/** 同一性を確かめられず signal を送らなかったときの文言 (unknown 行の POSITIVE と alive 行の negative)。 */
const UNKNOWN_MSG = "同一か確かめられないため、signal は送っていません";
/** corrupt な state の後始末・stop・status が出す文言の核。 */
const INVALID_MSG = "を検証できない";

let home: string;
let cwd: string;
const children: ChildProcess[] = [];
beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), "actradeck-trust-home-")));
  cwd = realpathSync(mkdtempSync(join(tmpdir(), "actradeck-trust-cwd-")));
});
afterEach(async () => {
  for (const c of children.splice(0)) {
    if (c.exitCode === null && c.signalCode === null) {
      const gone = new Promise((r) => c.once("exit", r));
      c.kill("SIGKILL");
      await gone;
    }
  }
  rmSync(home, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});

/** 生きている無関係の子プロセス (自分で spawn・afterEach で必ず止める)。 */
async function spawnBystander(): Promise<ChildProcess & { pid: number }> {
  const c = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  children.push(c);
  await new Promise<void>((r, j) => c.once("spawn", r).once("error", j));
  return c as ChildProcess & { pid: number };
}
/** 実 attach CLI (attach-fixtures の startAttachCli)。afterEach でグループごと止める。 */
const clis: AttachCli[] = [];
async function startAttachCli(
  args: readonly string[],
  at: { cwd: string; home: string; env?: Record<string, string> },
): Promise<AttachCli> {
  const cli = await startAttachCliFixture(args, {
    ...at,
    db: join(at.cwd, `cli-${clis.length}.db`),
  });
  clis.push(cli);
  return cli;
}
afterEach(async () => {
  for (const cli of clis.splice(0)) await killAttachCli(cli);
});
function stateFiles(h: string): string[] {
  const d = join(h, ".actradeck", "daemon");
  return existsSync(d) ? readdirSync(d).filter((f) => f.endsWith(".json")) : [];
}

function running(c: ChildProcess): boolean {
  return c.exitCode === null && c.signalCode === null;
}
/** /proc から仕様どおりに読む (実装の parser を使わない)。 */
function bootIdNow(): string {
  return readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
}
function ticksOf(pid: number): number {
  const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  return Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19]);
}

const settingsOf = (scope: AttachScope = "project-local"): string =>
  resolveSettingsPath(scope, cwd, home);

/** settings に死んだ port の配線を書き、state を書く (state は新しい形・必要な項目だけ上書き)。 */
function plant(over: Partial<DaemonState> & { pid: number }): {
  settingsPath: string;
  statePath: string;
} {
  const settingsPath = settingsOf();
  mkdirSync(dirname(settingsPath), { recursive: true });
  mergeAttachHooks({ settingsPath, endpoint: DEAD_ENDPOINT, tokenMode: "literal", token: TOKEN });
  const statePath = scopeArtifacts(settingsPath, home).statePath;
  writeDaemonState(
    statePath,
    daemonStateFor(settingsPath, { endpoint: DEAD_ENDPOINT, ...over }, { identity: false }),
  );
  return { settingsPath, statePath };
}
function entries(settingsPath: string): number {
  return actradeckEntries(settingsPath).length;
}
function rt(logs: string[], identity?: IdentitySources): DaemonRuntime {
  return stubRuntime(home, logs, {
    startDaemon: () => Promise.reject(new Error("would start")),
    ...(identity !== undefined ? { identity } : {}),
  });
}
const withSignal0 = (r: Signal0Result): IdentitySources => ({
  ...defaultIdentitySources,
  signal0: () => r,
});

describe("INV-ATTACH-STATE-TRUST: scope の artifact path は親 dir を realpath した settings path から導出する (V9)", () => {
  it("symlink を含まない path では旧 scopeHash / 旧 state path と同値 (lockPath / tokenPath は同じ dir の別名)", () => {
    for (const scope of ["project-local", "project", "user"] as const) {
      const p = settingsOf(scope);
      const a = scopeArtifacts(p, home);
      expect(a.scopeKey, scope).toBe(scopeHash(p));
      expect(a.canonicalSettingsPath, scope).toBe(p);
      // 旧い dist の path も同じ path (fallback は何もしない)。
      expect(a.lexicalSettingsPath, scope).toBe(p);
      expect(a.legacyStatePath, scope).toBe(a.statePath);
      const dir = join(home, ".actradeck", "daemon");
      expect(a.statePath).toBe(join(dir, `${scopeHash(p)}.json`));
      expect(a.lockPath).toBe(join(dir, `${scopeHash(p)}.lock`));
      expect(a.tokenPath).toBe(join(dir, `${scopeHash(p)}.hook-token`));
    }
  });

  it("symlink 経由の cwd と物理 cwd は同じ scopeKey (settings file の有無を問わず)", () => {
    const link = join(home, "link-to-cwd");
    symlinkSync(cwd, link);
    const viaLink = resolveSettingsPath("project-local", link, home);
    const physical = settingsOf();
    // POSITIVE 対: lexical には別の path (旧 scopeHash は別の値になる)。
    expect(viaLink).not.toBe(physical);
    expect(scopeHash(viaLink)).not.toBe(scopeHash(physical));
    expect(scopeArtifacts(viaLink, home).scopeKey).toBe(scopeArtifacts(physical, home).scopeKey);
    expect(scopeArtifacts(viaLink, home).canonicalSettingsPath).toBe(physical);
    mkdirSync(dirname(physical), { recursive: true });
    writeFileSync(physical, "{}");
    expect(scopeArtifacts(viaLink, home).statePath).toBe(scopeArtifacts(physical, home).statePath);
  });

  it("symlink cwd で起動した daemon を物理 cwd の status / stop が見つける", async () => {
    const link = join(home, "link-to-cwd");
    symlinkSync(cwd, link);
    const daemons: AttachDaemon[] = [];
    const logs: string[] = [];
    const out = await runStart(
      parseDaemonArgs(["attach"], link),
      { wsUrl: "ws://127.0.0.1:1/ingest/ws", dbPath: join(cwd, "v9.db") },
      {
        ...rt(logs),
        startDaemon: async (o) => {
          const d = new AttachDaemon({ wsUrl: o.wsUrl, dbPath: o.dbPath, host: "127.0.0.1" });
          const { hookEndpoint } = await d.start();
          daemons.push(d);
          return { daemon: d, hookEndpoint, hookToken: d.hookAuthToken };
        },
      },
    );
    try {
      expect(out.status).toBe("started");
      // runStart は新しい形で書く: 物理 settings path と、Linux では自プロセスの boot_id + start ticks。
      const written = readState(scopeArtifacts(settingsOf(), home), ["project-local"]);
      expect(written.kind).toBe("state");
      if (written.kind !== "state") throw new Error("unreachable");
      expect(written.state.settingsPath).toBe(settingsOf());
      if (LINUX) {
        expect(written.state.procIdentity).toEqual({
          bootId: bootIdNow(),
          startTicks: ticksOf(process.pid),
        });
      }
      const args = parseDaemonArgs(["daemon", "status"], cwd);
      expect(runStatus(args, rt(logs)).running).toBe(true);
      expect(entries(settingsOf())).toBeGreaterThan(0);
      const stop = runStop(parseDaemonArgs(["daemon", "stop"], cwd), rt(logs));
      expect(stop.status).toBe("stopped");
      expect(stop.kill).toBe("self");
      expect(entries(settingsOf())).toBe(0);
      expect(existsSync(out.statePath)).toBe(false);
    } finally {
      await daemons[0]?.shutdown();
    }
  });
});

describe("INV-ATTACH-STATE-TRUST: state の形検証は 1 か所・legacy は要素 1 個の一致だけ受理 (V10)", () => {
  const OTHER = "/elsewhere/.claude/settings.local.json";
  type Mut = (sp: string) => unknown;
  const valid = (sp: string): Record<string, unknown> => ({
    pid: 4242,
    endpoint: "http://127.0.0.1:4242/hook",
    scope: "project-local",
    settingsPath: sp,
    startedAt: "2026-10-06T00:00:00.000Z",
    tokenMode: "literal",
  });
  const legacy = (sp: string): Record<string, unknown> => {
    const { settingsPath: _s, tokenMode: _t, ...rest } = valid(sp);
    return { ...rest, wiredSettingsPaths: [sp] };
  };
  const ACCEPT: ReadonlyArray<readonly [string, Mut, "literal" | "env"]> = [
    ["新しい形 literal", (sp) => valid(sp), "literal"],
    [
      "新しい形 env + procIdentity",
      (sp) => ({
        ...valid(sp),
        tokenMode: "env",
        procIdentity: { bootId: "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0", startTicks: 7 },
      }),
      "env",
    ],
    ["legacy (hookTokenEnvVar 無し) → literal", (sp) => legacy(sp), "literal"],
    [
      "legacy (hookTokenEnvVar) → env",
      (sp) => ({ ...legacy(sp), hookTokenEnvVar: "ACTRADECK_HOOK_TOKEN" }),
      "env",
    ],
  ];
  const CORRUPT: ReadonlyArray<readonly [string, Mut]> = [
    ["legacy wiredSettingsPaths: []", (sp) => ({ ...legacy(sp), wiredSettingsPaths: [] })],
    ["legacy 要素 2 個 (同じ path)", (sp) => ({ ...legacy(sp), wiredSettingsPaths: [sp, sp] })],
    ["legacy 要素 2 個 (他 path)", (sp) => ({ ...legacy(sp), wiredSettingsPaths: [sp, OTHER] })],
    ["legacy 非配列", (sp) => ({ ...legacy(sp), wiredSettingsPaths: sp })],
    ["legacy 欠落", (sp) => ({ ...legacy(sp), wiredSettingsPaths: undefined })],
    ["legacy 不一致", (sp) => ({ ...legacy(sp), wiredSettingsPaths: [OTHER] })],
    ["legacy hookTokenEnvVar 別名", (sp) => ({ ...legacy(sp), hookTokenEnvVar: "OTHER" })],
    ["新旧混在", (sp) => ({ ...valid(sp), wiredSettingsPaths: [sp] })],
    ["settingsPath 不一致", () => valid(OTHER)],
    ["settingsPath 相対", () => valid(".claude/settings.local.json")],
    ["scope 不一致", (sp) => ({ ...valid(sp), scope: "user" })],
    ["scope enum 外", (sp) => ({ ...valid(sp), scope: "global" })],
    ["endpoint localhost", (sp) => ({ ...valid(sp), endpoint: "http://localhost:4242/hook" })],
    ["endpoint 127.0.0.2", (sp) => ({ ...valid(sp), endpoint: "http://127.0.0.2:4242/hook" })],
    ["endpoint https", (sp) => ({ ...valid(sp), endpoint: "https://127.0.0.1:4242/hook" })],
    ["endpoint 末尾 /", (sp) => ({ ...valid(sp), endpoint: "http://127.0.0.1:4242/hook/" })],
    ["endpoint port 0", (sp) => ({ ...valid(sp), endpoint: "http://127.0.0.1:0/hook" })],
    ["endpoint port 70000", (sp) => ({ ...valid(sp), endpoint: "http://127.0.0.1:70000/hook" })],
    ["pid 0", (sp) => ({ ...valid(sp), pid: 0 })],
    ["pid 負", (sp) => ({ ...valid(sp), pid: -1 })],
    ["pid 小数", (sp) => ({ ...valid(sp), pid: 1.5 })],
    ["pid 文字列", (sp) => ({ ...valid(sp), pid: "4242" })],
    ["pid int32 超", (sp) => ({ ...valid(sp), pid: 2 ** 31 })],
    ["startedAt 不正", (sp) => ({ ...valid(sp), startedAt: "not a date" })],
    ["tokenMode 不正", (sp) => ({ ...valid(sp), tokenMode: "jwt" })],
    ["tokenMode 欠落", (sp) => ({ ...valid(sp), tokenMode: undefined })],
    [
      "procIdentity bootId 不正",
      (sp) => ({ ...valid(sp), procIdentity: { bootId: "x", startTicks: 1 } }),
    ],
    [
      "procIdentity startTicks 負",
      (sp) => ({
        ...valid(sp),
        procIdentity: { bootId: "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0", startTicks: -1 },
      }),
    ],
    ["JSON 配列", () => []],
    ["JSON null", () => null],
  ];
  let rows = 0;
  afterAll(() => {
    expect(rows).toBe(ACCEPT.length + CORRUPT.length + 2);
    expect(new Set([...ACCEPT, ...CORRUPT].map(([n]) => n)).size).toBe(
      ACCEPT.length + CORRUPT.length,
    );
  });

  const read = (body: string): ReturnType<typeof readState> => {
    const sp = settingsOf();
    const { statePath } = scopeArtifacts(sp, home);
    mkdirSync(dirname(statePath), { recursive: true });
    writeFileSync(statePath, body);
    return readState(scopeArtifacts(sp, home), ["project-local"]);
  };

  for (const [name, mut, mode] of ACCEPT) {
    it(`受理: ${name}`, () => {
      const input = { ...(mut(settingsOf()) as object), extra: "dropped" };
      const r = read(JSON.stringify(input));
      expect(r.kind).toBe("state");
      if (r.kind !== "state") throw new Error("unreachable");
      expect(r.state.tokenMode).toBe(mode);
      expect(r.state.settingsPath).toBe(settingsOf());
      // 既知の項目だけを持つ (未知の項目・legacy の項目は持ち越さない)。POSITIVE 対: 入力は持っている。
      expect(Object.keys(input)).toContain("extra");
      expect(Object.keys(r.state)).not.toContain("extra");
      if (name.startsWith("legacy")) expect(Object.keys(input)).toContain("wiredSettingsPaths");
      expect(Object.keys(r.state)).not.toContain("wiredSettingsPaths");
      rows += 1;
    });
  }
  for (const [name, mut] of CORRUPT) {
    it(`corrupt: ${name}`, () => {
      expect(read(JSON.stringify(mut(settingsOf()))).kind).toBe("corrupt");
      rows += 1;
    });
  }
  it("corrupt: JSON でない / absent: file が無い", () => {
    expect(read("{ not json").kind).toBe("corrupt");
    rmSync(scopeArtifacts(settingsOf(), home).statePath);
    expect(readState(scopeArtifacts(settingsOf(), home), ["project-local"]).kind).toBe("absent");
    rows += 2;
  });
  it("書く側も同じ検証を通す (読めない state は書かずに throw)", () => {
    const { statePath } = scopeArtifacts(settingsOf(), home);
    const bad = {
      ...(valid(settingsOf()) as unknown as DaemonState),
      endpoint: "http://localhost:1/hook",
    };
    expect(() => writeDaemonState(statePath, bad)).toThrow("daemon state の形が不正");
    expect(existsSync(statePath)).toBe(false);
    writeDaemonState(statePath, valid(settingsOf()) as unknown as DaemonState);
    expect(existsSync(statePath)).toBe(true);
  });
});

describe("INV-ATTACH-STATE-TRUST: corrupt な state は pid を信用しない (後始末は書かない・stop は kill しない)", () => {
  function plantCorrupt(pid: number): { settingsPath: string; statePath: string; raw: string } {
    const { settingsPath, statePath } = plant({ pid });
    const raw = JSON.stringify({
      pid,
      endpoint: DEAD_ENDPOINT,
      wiredSettingsPaths: [],
      scope: "project-local",
      startedAt: new Date().toISOString(),
    });
    writeFileSync(statePath, raw);
    return { settingsPath, statePath, raw };
  }

  it("拒否起動の後始末: settings も state も触らず state-invalid と停止案内 (対照: 同じ形の valid stale は外す)", () => {
    const deadPid = deadPidFixture();
    const { settingsPath, statePath, raw } = plantCorrupt(deadPid);
    const before = readFileSync(settingsPath, "utf8");
    const logs: string[] = [];
    const base = { target: scopeTarget("project-local", cwd, home), writeApproved: true };
    expect(cleanupStaleWiring({ ...base, log: (m) => logs.push(m) })).toBe("state-invalid");
    expect(readFileSync(settingsPath, "utf8")).toBe(before);
    expect(readFileSync(statePath, "utf8")).toBe(raw);
    expect(logs.join("\n")).toContain(INVALID_MSG);
    expect(logs.join("\n")).toContain(`agentmon daemon stop --scope project-local --cwd ${cwd}`);
    plant({ pid: deadPid });
    const logs2: string[] = [];
    expect(cleanupStaleWiring({ ...base, log: (m) => logs2.push(m) })).toBe("detached");
    expect(entries(settingsPath)).toBe(0);
    expect(logs2.join("\n")).not.toContain(INVALID_MSG);
  });

  it("daemon stop: 配線を全部外し state を消すが、記録 pid (生きている子) には signal を送らない・status は corrupt と表示", async () => {
    const child = await spawnBystander();
    const { settingsPath, statePath } = plantCorrupt(child.pid);
    const logs: string[] = [];
    const status = runStatus(parseDaemonArgs(["daemon", "status"], cwd), rt(logs));
    expect(status).toMatchObject({ running: false, corrupt: true });
    const stop = runStop(parseDaemonArgs(["daemon", "stop"], cwd), rt(logs));
    // 記録が corrupt だったこと (`corrupt`) と state file の後始末 (`state`) は別の項目 (旧: `state:
    // "corrupt-removed"` は削除の失敗も「消した」と報告しえた・TDA-STA-5)。
    expect(stop).toMatchObject({
      status: "stopped",
      kill: "skipped-corrupt",
      corrupt: true,
      state: "removed",
      token: "absent",
    });
    expect(stop.killedPid).toBeUndefined();
    expect(entries(settingsPath)).toBe(0);
    expect(existsSync(statePath)).toBe(false);
    expect(logs.join("\n")).toContain(INVALID_MSG);
    await new Promise((r) => setTimeout(r, 100));
    expect(running(child)).toBe(true);
  });
});

describe("INV-ATTACH-STATE-TRUST: daemon stop は記録した daemon と同一のときだけ SIGTERM を送る (V8・実プロセス)", () => {
  interface StopRow {
    readonly name: string;
    readonly linuxOnly: boolean;
    readonly state: (child: { pid: number }) => Partial<DaemonState>;
    readonly identity?: IdentitySources;
    readonly kill: "sent" | "skipped-dead" | "skipped-identity-unknown";
  }
  const minuteAgo = (): string => new Date(Date.now() - 60_000).toISOString();
  const ident = (pid: number, over: Partial<ProcIdentity> = {}): ProcIdentity => ({
    bootId: bootIdNow(),
    startTicks: ticksOf(pid),
    ...over,
  });
  const ROWS: readonly StopRow[] = [
    {
      name: "start ticks 不一致 (pid 再利用)",
      linuxOnly: true,
      state: (c) => ({ procIdentity: ident(c.pid, { startTicks: ticksOf(c.pid) + 1 }) }),
      kill: "skipped-dead",
    },
    {
      name: "boot_id 不一致",
      linuxOnly: true,
      state: (c) => ({
        procIdentity: ident(c.pid, { bootId: "00000000-0000-4000-8000-000000000000" }),
      }),
      kill: "skipped-dead",
    },
    {
      name: "procIdentity 無し・startedAt が子の起動より 60s 前 (壁時計の前進か pid 再利用・Linux は unknown)",
      linuxOnly: false,
      state: () => ({ startedAt: minuteAgo() }),
      // SEC-STA-2: Linux (boot_id が読める) では時計の前進と区別できないので unknown (kill しない・base 同値)。
      kill: LINUX ? "skipped-identity-unknown" : "skipped-dead",
    },
    {
      name: "同一性 unknown (EPERM 注入)",
      linuxOnly: false,
      state: () => ({}),
      identity: withSignal0("eperm"),
      kill: "skipped-identity-unknown",
    },
    {
      name: "同一性 unknown (start ticks が読めない注入)",
      linuxOnly: true,
      state: (c) => ({ procIdentity: ident(c.pid) }),
      identity: {
        ...defaultIdentitySources,
        readStartTicks: (p) => (p === "self" ? 1 : undefined),
      },
      kill: "skipped-identity-unknown",
    },
    {
      name: "対照: start ticks 一致",
      linuxOnly: true,
      state: (c) => ({ procIdentity: ident(c.pid) }),
      kill: "sent",
    },
    {
      name: "対照: procIdentity 無し・startedAt は子の起動後 (etime 許容内)",
      linuxOnly: false,
      state: () => ({}),
      kill: "sent",
    },
  ];
  let executed = 0;
  afterAll(() => {
    expect(executed).toBe(ROWS.filter((r) => LINUX || !r.linuxOnly).length);
    expect(ROWS.some((r) => r.kill === "sent")).toBe(true);
  });

  for (const row of ROWS) {
    it.runIf(LINUX || !row.linuxOnly)(`${row.name} → ${row.kill}`, async () => {
      const child = await spawnBystander();
      const { settingsPath, statePath } = plant({ pid: child.pid, ...row.state(child) });
      const logs: string[] = [];
      const exited = new Promise<NodeJS.Signals | null>((r) => child.once("exit", (_c, s) => r(s)));
      const stop = runStop(parseDaemonArgs(["daemon", "stop"], cwd), rt(logs, row.identity));
      expect(stop.kill).toBe(row.kill);
      expect(stop.status).toBe("stopped");
      expect(entries(settingsPath)).toBe(0);
      expect(existsSync(statePath)).toBe(false);
      if (row.kill === "sent") {
        expect(stop.killedPid).toBe(child.pid);
        expect(await exited).toBe("SIGTERM");
        expect(logs.join("\n")).not.toContain(UNKNOWN_MSG);
      } else {
        expect(stop.killedPid).toBeUndefined();
        await new Promise((r) => setTimeout(r, 100));
        expect(running(child)).toBe(true);
        if (row.kill === "skipped-identity-unknown") expect(logs.join("\n")).toContain(UNKNOWN_MSG);
        else expect(logs.join("\n")).not.toContain(UNKNOWN_MSG);
      }
      executed += 1;
    });
  }
});

describe("INV-ATTACH-STATE-TRUST: alive 判定は同じ述語・unknown は alive 扱い (V8・実プロセス)", () => {
  it.runIf(LINUX)(
    "pid 再利用 (ticks 不一致) は stale: 後始末は配線を外し、子には触らない・起動は進む・status は停止",
    async () => {
      const child = await spawnBystander();
      const reused = {
        pid: child.pid,
        procIdentity: { bootId: bootIdNow(), startTicks: ticksOf(child.pid) + 1 },
      };
      const { settingsPath } = plant(reused);
      const logs: string[] = [];
      expect(runStatus(parseDaemonArgs(["daemon", "status"], cwd), rt(logs))).toMatchObject({
        running: false,
        liveness: "dead",
      });
      await expect(
        runStart(
          parseDaemonArgs(["attach"], cwd),
          { wsUrl: "ws://x", dbPath: join(cwd, "a.db") },
          rt(logs),
        ),
      ).rejects.toThrow("would start");
      // 起動の失敗 (startDaemon の throw) でも後始末が走り、stale な配線を外す (PR-B2・ADR D4 の throw 経路)。
      expect(entries(settingsPath)).toBe(0);
      expect(running(child)).toBe(true);
      // 拒否起動の後始末も同じ判定 (pid 再利用は stale) で外す: 同じ state を置き直して確かめる。
      plant(reused);
      expect(entries(settingsPath)).toBeGreaterThan(0);
      expect(
        cleanupStaleWiring({
          target: scopeTarget("project-local", cwd, home),
          writeApproved: true,
          log: (m) => logs.push(m),
        }),
      ).toBe("detached");
      expect(entries(settingsPath)).toBe(0);
      expect(running(child)).toBe(true);
    },
  );

  it("同一性 unknown は alive 扱い: 後始末は触らない・起動は already-running・status は稼働中 (対照: 注入なしでは stale)", async () => {
    const child = await spawnBystander();
    // 注入なしなら stale と判定される state (Linux: start ticks 不一致・それ以外: etime 許容超過)。
    const { settingsPath } = plant({
      pid: child.pid,
      ...(LINUX
        ? { procIdentity: { bootId: bootIdNow(), startTicks: ticksOf(child.pid) + 1 } }
        : { startedAt: new Date(Date.now() - 60_000).toISOString() }),
    });
    const before = readFileSync(settingsPath, "utf8");
    const unknown = withSignal0("eperm");
    const logs: string[] = [];
    expect(runStatus(parseDaemonArgs(["daemon", "status"], cwd), rt(logs, unknown))).toMatchObject({
      running: true,
      liveness: "unknown",
    });
    const out = await runStart(
      parseDaemonArgs(["attach"], cwd),
      { wsUrl: "ws://x", dbPath: join(cwd, "b.db") },
      rt(logs, unknown),
    );
    expect(out.status).toBe("already-running");
    // 拒否起動 (env mode・token 未設定) の後始末も同じ述語 (runtime の identity) を使う。
    const denied = await runStart(
      parseDaemonArgs(["attach", "--token-mode", "env"], cwd),
      { wsUrl: "ws://x", dbPath: join(cwd, "c.db") },
      rt(logs, unknown),
    );
    expect(denied.status).toBe("denied-env-token-missing");
    expect(readFileSync(settingsPath, "utf8")).toBe(before);
    expect(
      cleanupStaleWiring({
        target: scopeTarget("project-local", cwd, home),
        writeApproved: true,
        log: (m) => logs.push(m),
        identity: unknown,
      }),
    ).toBe("alive-untouched");
    expect(readFileSync(settingsPath, "utf8")).toBe(before);
    // 対照: 注入なしでは、この state は stale (Linux は ticks 不一致・それ以外は etime) として外れる。
    expect(runStatus(parseDaemonArgs(["daemon", "status"], cwd), rt(logs)).liveness).toBe("dead");
    expect(running(child)).toBe(true);
  });
  it.runIf(LINUX)(
    "時計ずれ (SEC-STA-2): procIdentity の無い旧 state の startedAt が 5s 進んで見えても生きた daemon を dead にしない (後始末は触らない・stop は kill しない)",
    async () => {
      const child = await spawnBystander();
      // 壁時計が state 書込の後に 5s 進んだ = 生きた daemon の起動が startedAt より 5s 後に見える。
      const { settingsPath, statePath } = plant({
        pid: child.pid,
        startedAt: new Date(Date.now() - 5000).toISOString(),
      });
      const before = readFileSync(settingsPath, "utf8");
      const stateBefore = readFileSync(statePath, "utf8");
      const logs: string[] = [];
      expect(runStatus(parseDaemonArgs(["daemon", "status"], cwd), rt(logs))).toMatchObject({
        running: true,
        liveness: "unknown",
      });
      const denied = await runStart(
        parseDaemonArgs(["attach", "--token-mode", "env"], cwd),
        { wsUrl: "ws://x", dbPath: join(cwd, "skew.db") },
        rt(logs),
      );
      expect(denied.status).toBe("denied-env-token-missing");
      expect(readFileSync(settingsPath, "utf8")).toBe(before);
      expect(readFileSync(statePath, "utf8")).toBe(stateBefore);
      const stop = runStop(parseDaemonArgs(["daemon", "stop"], cwd), rt(logs));
      expect(stop.kill).toBe("skipped-identity-unknown");
      await new Promise((r) => setTimeout(r, 100));
      expect(running(child)).toBe(true);
    },
  );
});

describe("INV-ATTACH-STATE-TRUST: 新しい path に state が無ければ旧い dist の path を同じ reader で読む (upgrade の窓)", () => {
  /** symlink cwd で動く旧い dist の daemon の残り方: lexical な path の scopeHash に legacy 形の state。 */
  function plantOld(pid: number, startedAt = new Date().toISOString()) {
    const link = join(home, "link-to-cwd");
    symlinkSync(cwd, link);
    const settingsPath = resolveSettingsPath("project-local", link, home);
    mkdirSync(dirname(settingsPath), { recursive: true });
    mergeAttachHooks({ settingsPath, endpoint: DEAD_ENDPOINT, tokenMode: "literal", token: TOKEN });
    const art = scopeArtifacts(settingsPath, home);
    // POSITIVE 対: symlink を含むので旧い path は新しい path と別。
    expect(art.legacyStatePath).not.toBe(art.statePath);
    const raw = JSON.stringify({
      pid,
      endpoint: DEAD_ENDPOINT,
      wiredSettingsPaths: [art.lexicalSettingsPath],
      scope: "project-local",
      startedAt,
    });
    mkdirSync(dirname(art.legacyStatePath), { recursive: true });
    writeFileSync(art.legacyStatePath, raw);
    return { link, settingsPath, art, raw };
  }

  it("旧い path の生きた daemon: start は already-running・status は稼働中・拒否起動は触らない・stop は止めて外し旧い state を消す", async () => {
    const child = await spawnBystander();
    const { link, settingsPath, art, raw } = plantOld(child.pid);
    const before = readFileSync(settingsPath, "utf8");
    const logs: string[] = [];
    const env = { wsUrl: "ws://x", dbPath: join(cwd, "u.db") };
    expect((await runStart(parseDaemonArgs(["attach"], link), env, rt(logs))).status).toBe(
      "already-running",
    );
    expect(runStatus(parseDaemonArgs(["daemon", "status"], link), rt(logs)).running).toBe(true);
    const denied = await runStart(
      parseDaemonArgs(["attach", "--token-mode", "env"], link),
      env,
      rt(logs),
    );
    expect(denied.status).toBe("denied-env-token-missing");
    expect(readFileSync(settingsPath, "utf8")).toBe(before);
    expect(readFileSync(art.legacyStatePath, "utf8")).toBe(raw);
    const exited = new Promise<NodeJS.Signals | null>((r) =>
      child.once("exit", (_c, sig) => r(sig)),
    );
    const stop = runStop(parseDaemonArgs(["daemon", "stop"], link), rt(logs));
    expect(stop).toMatchObject({ status: "stopped", kill: "sent", killedPid: child.pid });
    expect(await exited).toBe("SIGTERM");
    expect(entries(settingsPath)).toBe(0);
    expect(existsSync(art.legacyStatePath)).toBe(false);
    expect(existsSync(art.statePath)).toBe(false);
  });

  it("旧い path の stale state: 拒否起動の後始末が配線を外し、旧い path の state を消す", async () => {
    const deadPid = deadPidFixture();
    const { link, settingsPath, art } = plantOld(deadPid);
    const logs: string[] = [];
    const out = await runStart(
      parseDaemonArgs(["attach", "--token-mode", "env"], link),
      { wsUrl: "ws://x", dbPath: join(cwd, "s.db") },
      rt(logs),
    );
    expect(out.status).toBe("denied-env-token-missing");
    expect(entries(settingsPath)).toBe(0);
    expect(existsSync(art.legacyStatePath)).toBe(false);
    expect(logs.join("\n")).toContain("stale state を消しました");
  });

  it("旧い path の stale state の上で起動が成功したら、新しい path に書いて旧い path の state を消す", async () => {
    const deadPid = deadPidFixture();
    const { link, art } = plantOld(deadPid);
    const daemons: AttachDaemon[] = [];
    const logs: string[] = [];
    const out = await runStart(
      parseDaemonArgs(["attach"], link),
      { wsUrl: "ws://127.0.0.1:1/ingest/ws", dbPath: join(cwd, "n.db") },
      {
        ...rt(logs),
        startDaemon: async (o) => {
          const d = new AttachDaemon({ wsUrl: o.wsUrl, dbPath: o.dbPath, host: "127.0.0.1" });
          const { hookEndpoint } = await d.start();
          daemons.push(d);
          return { daemon: d, hookEndpoint, hookToken: d.hookAuthToken };
        },
      },
    );
    try {
      expect(out.status).toBe("started");
      expect(logs.join("\n")).toContain(`stale state を検出 (pid=${deadPid} 死亡)`);
      expect(existsSync(art.statePath)).toBe(true);
      expect(existsSync(art.legacyStatePath)).toBe(false);
    } finally {
      await daemons[0]?.shutdown();
      runStop(parseDaemonArgs(["daemon", "stop"], link), rt(logs));
    }
  });

  it("旧い path の corrupt state: stop は配線を外して旧い path の state を消し、kill しない", async () => {
    const child = await spawnBystander();
    const { link, settingsPath, art } = plantOld(child.pid);
    writeFileSync(art.legacyStatePath, "{ not json");
    const stop = runStop(parseDaemonArgs(["daemon", "stop"], link), rt([]));
    expect(stop).toMatchObject({ kill: "skipped-corrupt", corrupt: true, state: "removed" });
    expect(entries(settingsPath)).toBe(0);
    expect(existsSync(art.legacyStatePath)).toBe(false);
    expect(running(child)).toBe(true);
  });

  it("後始末の target は scopeTarget が導出したものだけ (手で組み立てた target は型で渡せない・spread の複製を実行時に拒否するのは inv-attach-teardown の test)", () => {
    const sp = settingsOf();
    // 型の床 (TDA-STA-5): brand の無い手組みの target は渡せない。tsc -p tsconfig.test.json が検査する
    // (brand を外す変異で @ts-expect-error が未使用になり型検査が RED)。実行はしない。
    const handBuilt = (): ReturnType<typeof cleanupStaleWiring> =>
      cleanupStaleWiring({
        // @ts-expect-error ScopeTarget は scopeTarget() だけが作る (brand)
        target: {
          scope: "project-local",
          cwd,
          settingsPath: sp,
          artifacts: { ...scopeArtifacts(sp, home), statePath: join(home, "elsewhere.json") },
          scopes: ["project-local"],
        },
        writeApproved: true,
        log: () => undefined,
      });
    expect(typeof handBuilt).toBe("function");
    // 対照 (POSITIVE): 導出した target は通り (state が無いので no-state)、導出した statePath を指す。
    const target = scopeTarget("project-local", cwd, home);
    expect(target.artifacts.statePath).toBe(scopeArtifacts(sp, home).statePath);
    expect(target.settingsPath).toBe(sp);
    expect(cleanupStaleWiring({ target, writeApproved: true, log: () => undefined })).toBe(
      "no-state",
    );
  });

  it("新しい path に state があれば (corrupt でも) 旧い path は読まない", async () => {
    const child = await spawnBystander();
    const { link, art } = plantOld(child.pid);
    writeFileSync(art.statePath, "{ not json");
    const status = runStatus(parseDaemonArgs(["daemon", "status"], link), rt([]));
    expect(status).toMatchObject({ running: false, corrupt: true });
    // 対照 (POSITIVE): 新しい path を消せば旧い path の生きた daemon が見える。
    rmSync(art.statePath);
    expect(runStatus(parseDaemonArgs(["daemon", "status"], link), rt([])).running).toBe(true);
  });
});

describe("INV-ATTACH-STATE-TRUST: cwd が home のとき project と user は同じ settings file を指し、どちらの scope でも止められる", () => {
  it("実 attach CLI を user scope で home から起動 → `daemon stop --scope project` (cwd = home) が kill して外す", async () => {
    const cli = await startAttachCli(["--scope", "user", "--yes"], { cwd: home, home });
    const userSettings = resolveSettingsPath("user", home, home);
    expect(resolveSettingsPath("project", home, home)).toBe(userSettings);
    expect(entries(userSettings)).toBeGreaterThan(0);
    const logs: string[] = [];
    const status = runStatus(
      parseDaemonArgs(["daemon", "status", "--scope", "project"], home),
      rt(logs),
    );
    expect(status.running).toBe(true);
    expect(status.state?.scope).toBe("user");
    const stop = runStop(parseDaemonArgs(["daemon", "stop", "--scope", "project"], home), rt(logs));
    expect(stop.kill).toBe("sent");
    expect(await cli.groupGone(15_000), `attach CLI survived SIGTERM: ${cli.stderr()}`).toBe(true);
    expect(entries(userSettings)).toBe(0);
    expect(existsSync(scopeArtifacts(userSettings, home).statePath)).toBe(false);
  }, 40_000);

  it("project ラベルの state も `--scope user` で止まる (cwd = home)・別 file を指す scope のラベルは corrupt のまま", async () => {
    const child = await spawnBystander();
    const userSettings = resolveSettingsPath("user", home, home);
    mkdirSync(dirname(userSettings), { recursive: true });
    mergeAttachHooks({ settingsPath: userSettings, endpoint: DEAD_ENDPOINT, tokenMode: "env" });
    const art = scopeArtifacts(userSettings, home);
    const state = (scope: AttachScope, settingsPath: string): DaemonState =>
      daemonStateFor(
        settingsPath,
        { pid: child.pid, endpoint: DEAD_ENDPOINT, scope, tokenMode: "env" },
        { identity: false },
      );
    // 対照 (cwd ≠ home): project の settings file は user と別。user ラベルの state は corrupt で kill しない。
    const projectSettings = resolveSettingsPath("project", cwd, home);
    mkdirSync(dirname(projectSettings), { recursive: true });
    writeFileSync(projectSettings, "{}");
    writeDaemonState(
      scopeArtifacts(projectSettings, home).statePath,
      state("user", projectSettings),
    );
    const foreign = runStop(parseDaemonArgs(["daemon", "stop", "--scope", "project"], cwd), rt([]));
    expect(foreign.kill).toBe("skipped-corrupt");
    expect(running(child)).toBe(true);
    // project-local は home でも別 file (settings.local.json): user ラベルは corrupt。
    const localSettings = resolveSettingsPath("project-local", home, home);
    writeDaemonState(scopeArtifacts(localSettings, home).statePath, state("user", localSettings));
    expect(runStatus(parseDaemonArgs(["daemon", "status"], home), rt([])).corrupt).toBe(true);
    // 同じ file: project ラベルの state を user scope で止める。
    writeDaemonState(art.statePath, state("project", userSettings));
    const exited = new Promise<NodeJS.Signals | null>((r) =>
      child.once("exit", (_c, sig) => r(sig)),
    );
    const stop = runStop(parseDaemonArgs(["daemon", "stop", "--scope", "user"], home), rt([]));
    expect(stop).toMatchObject({ status: "stopped", kill: "sent", killedPid: child.pid });
    expect(await exited).toBe("SIGTERM");
    expect(entries(userSettings)).toBe(0);
  });
});

describe("INV-ATTACH-STATE-TRUST: user scope はどの cwd からでも project ラベルの state を読む・runStart と拒否起動の後始末も同じ規則 (QA-STA-1 / QA-STA-3)", () => {
  const userState = (pid: number, scope: AttachScope): DaemonState =>
    daemonStateFor(
      resolveSettingsPath("user", home, home),
      { pid, endpoint: DEAD_ENDPOINT, scope, tokenMode: "env" },
      { identity: false },
    );
  function wireUser(): { settingsPath: string; statePath: string } {
    const settingsPath = resolveSettingsPath("user", home, home);
    mkdirSync(dirname(settingsPath), { recursive: true });
    mergeAttachHooks({ settingsPath, endpoint: DEAD_ENDPOINT, tokenMode: "env" });
    return { settingsPath, statePath: scopeArtifacts(settingsPath, home).statePath };
  }

  it("cwd = home の project で起動した state を、別の cwd から `--scope user` の status / start / stop が見つける", async () => {
    const child = await spawnBystander();
    const { settingsPath, statePath } = wireUser();
    writeDaemonState(statePath, userState(child.pid, "project"));
    expect(cwd).not.toBe(home);
    const logs: string[] = [];
    const status = runStatus(
      parseDaemonArgs(["daemon", "status", "--scope", "user"], cwd),
      rt(logs),
    );
    expect(status).toMatchObject({ running: true, liveness: "alive" });
    expect(status.state?.scope).toBe("project");
    const again = await runStart(
      parseDaemonArgs(["attach", "--scope", "user", "--yes"], cwd),
      { wsUrl: "ws://x", dbPath: join(cwd, "u.db") },
      rt(logs),
    );
    expect(again.status).toBe("already-running");
    const exited = new Promise<NodeJS.Signals | null>((r) =>
      child.once("exit", (_c, sig) => r(sig)),
    );
    const stop = runStop(parseDaemonArgs(["daemon", "stop", "--scope", "user"], cwd), rt(logs));
    expect(stop).toMatchObject({ status: "stopped", kill: "sent", killedPid: child.pid });
    expect(await exited).toBe("SIGTERM");
    expect(entries(settingsPath)).toBe(0);
  });

  it("cwd = home の `--scope project` 起動は user ラベルの生きた daemon を already-running と見る (runStart が同じ規則を使う)", async () => {
    const child = await spawnBystander();
    const { statePath } = wireUser();
    writeDaemonState(statePath, userState(child.pid, "user"));
    const out = await runStart(
      parseDaemonArgs(["attach", "--scope", "project", "--yes", "--token-mode", "env"], home),
      { wsUrl: "ws://x", dbPath: join(cwd, "p.db"), hookToken: "a".repeat(40) },
      rt([]),
    );
    expect(out.status).toBe("already-running");
    expect(running(child)).toBe(true);
  });

  it("cwd = home の `--scope project` の拒否起動は user ラベルの stale state の配線を外す (後始末が同じ規則を使う)", async () => {
    const deadPid = deadPidFixture();
    const { settingsPath, statePath } = wireUser();
    writeDaemonState(statePath, userState(deadPid, "user"));
    expect(entries(settingsPath)).toBeGreaterThan(0);
    const logs: string[] = [];
    const out = await runStart(
      parseDaemonArgs(["attach", "--scope", "project", "--yes", "--token-mode", "env"], home),
      { wsUrl: "ws://x", dbPath: join(cwd, "d.db") },
      rt(logs),
    );
    expect(out.status).toBe("denied-env-token-missing");
    expect(entries(settingsPath)).toBe(0);
    expect(existsSync(statePath)).toBe(false);
    expect(logs.join("\n")).not.toContain(INVALID_MSG);
  });
});

describe("INV-ATTACH-STATE-TRUST: settings file 自体が symlink でも state は起動の前後で変わらない (SEC-STA-1 ≡ TDA-STA-1・実 attach CLI)", () => {
  /** settings file を別 dir (dotfiles) の実体への symlink にする。 */
  function linkSettings(settingsPath: string): string {
    const real = join(home, "dotfiles", `${basenameOf(settingsPath)}-${Date.now()}`);
    mkdirSync(dirname(real), { recursive: true });
    writeFileSync(real, JSON.stringify({ hooks: {} }));
    mkdirSync(dirname(settingsPath), { recursive: true });
    symlinkSync(real, settingsPath);
    // POSITIVE 対: 起動前は symlink。
    expect(lstatSync(settingsPath).isSymbolicLink()).toBe(true);
    return real;
  }
  const basenameOf = (p: string): string => p.slice(p.lastIndexOf("/") + 1);

  for (const scope of ["user", "project-local"] as const) {
    it(`${scope}: status は稼働中・2 回目の attach は already-running・daemon の SIGTERM 終了で entry 0 + state 削除・daemon stop が効く`, async () => {
      const settingsPath = resolveSettingsPath(scope, cwd, home);
      linkSettings(settingsPath);
      const args = scope === "user" ? ["--scope", "user", "--yes"] : [];
      const scopeArgs = scope === "user" ? ["--scope", "user"] : [];
      const a = await startAttachCli(args, { cwd, home });
      expect(entries(settingsPath)).toBeGreaterThan(0);
      // POSITIVE 対 (下の stateFiles(home) が空の assert と同じ helper): 稼働中は state が 1 件。
      expect(stateFiles(home)).toHaveLength(1);
      const logs: string[] = [];
      expect(
        runStatus(parseDaemonArgs(["daemon", "status", ...scopeArgs], cwd), rt(logs)).running,
      ).toBe(true);
      const again = await runStart(
        parseDaemonArgs(["attach", ...args], cwd),
        { wsUrl: "ws://x", dbPath: join(cwd, "again.db") },
        rt(logs),
      );
      expect(again.status).toBe("already-running");
      process.kill(-a.pgid, "SIGTERM");
      expect(await a.groupGone(15_000), a.stderr()).toBe(true);
      expect(entries(settingsPath)).toBe(0);
      expect(stateFiles(home)).toEqual([]);
      // 2 回目の寿命: `daemon stop` が見つけて止める。
      const b = await startAttachCli(args, { cwd, home });
      expect(stateFiles(home)).toHaveLength(1);
      const stop = runStop(parseDaemonArgs(["daemon", "stop", ...scopeArgs], cwd), rt(logs));
      expect(stop.kill).toBe("sent");
      expect(await b.groupGone(15_000), b.stderr()).toBe(true);
      expect(entries(settingsPath)).toBe(0);
      expect(stateFiles(home)).toEqual([]);
    }, 60_000);
  }

  it("monorepo の file symlink 形: package の settings file が root の settings file への symlink なら別の key で、package 側の stop は root の daemon を止めない", async () => {
    const rootSettings = resolveSettingsPath("project-local", cwd, home);
    mkdirSync(dirname(rootSettings), { recursive: true });
    writeFileSync(rootSettings, JSON.stringify({ hooks: {} }));
    const pkg = join(cwd, "packages", "a");
    const pkgSettings = resolveSettingsPath("project-local", pkg, home);
    mkdirSync(dirname(pkgSettings), { recursive: true });
    symlinkSync(rootSettings, pkgSettings);
    const root = await startAttachCli([], { cwd, home });
    expect(entries(rootSettings)).toBeGreaterThan(0);
    const logs: string[] = [];
    const stop = runStop(parseDaemonArgs(["daemon", "stop"], pkg), rt(logs));
    expect(stop).toMatchObject({ status: "not-running", kill: "no-state" });
    expect(await root.groupGone(300)).toBe(false);
    expect(entries(rootSettings)).toBeGreaterThan(0);
    // 対照 (POSITIVE): root 側の stop は止める。
    expect(runStop(parseDaemonArgs(["daemon", "stop"], cwd), rt(logs)).kill).toBe("sent");
    expect(await root.groupGone(15_000), root.stderr()).toBe(true);
    expect(entries(rootSettings)).toBe(0);
  }, 60_000);

  it("HOME 自体が symlink (H3): symlink の HOME で起動した user daemon を、物理 home を cwd にした `--scope project` が止める", async () => {
    const homeLink = join(cwd, "home-link");
    symlinkSync(home, homeLink);
    const cli = await startAttachCli(["--scope", "user", "--yes"], { cwd, home: homeLink });
    const userSettings = resolveSettingsPath("user", cwd, homeLink);
    expect(entries(userSettings)).toBeGreaterThan(0);
    const viaPhysical = parseDaemonArgs(["daemon", "status", "--scope", "project"], home);
    // POSITIVE 対: lexical には別の path。
    expect(resolveSettingsPath("project", home, homeLink)).not.toBe(userSettings);
    const logs: string[] = [];
    const rtLink: DaemonRuntime = { ...rt(logs), home: homeLink };
    expect(runStatus(viaPhysical, rtLink).running).toBe(true);
    const stop = runStop(parseDaemonArgs(["daemon", "stop", "--scope", "project"], home), rtLink);
    expect(stop.kill).toBe("sent");
    expect(await cli.groupGone(15_000), cli.stderr()).toBe(true);
    expect(entries(userSettings)).toBe(0);
  }, 40_000);
  it("HOME 自体が symlink (逆向き・QA-STA-R2-2): symlink の HOME を cwd にした `--scope project` の daemon を、別の cwd からの `--scope user` が止める", async () => {
    const homeLink = join(cwd, "home-link");
    symlinkSync(home, homeLink);
    const cli = await startAttachCli(["--scope", "project", "--yes", "--token-mode", "env"], {
      cwd: homeLink,
      home: homeLink,
      env: { ACTRADECK_HOOK_TOKEN: "b".repeat(40) },
    });
    const userSettings = resolveSettingsPath("user", cwd, homeLink);
    expect(entries(userSettings)).toBeGreaterThan(0);
    const logs: string[] = [];
    const rtLink: DaemonRuntime = { ...rt(logs), home: homeLink };
    const status = runStatus(parseDaemonArgs(["daemon", "status", "--scope", "user"], cwd), rtLink);
    expect(status.running).toBe(true);
    expect(status.state?.scope).toBe("project");
    const stop = runStop(parseDaemonArgs(["daemon", "stop", "--scope", "user"], cwd), rtLink);
    expect(stop.kill).toBe("sent");
    expect(await cli.groupGone(15_000), cli.stderr()).toBe(true);
    expect(entries(userSettings)).toBe(0);
  }, 40_000);
});

describe("INV-ATTACH-STATE-TRUST: etime は記録 pid の経過時間を読む (QA-STA-2)", () => {
  it("ps -o etime= の対象は引数の pid (自プロセスではない)", async () => {
    const self = (): number => defaultIdentitySources.elapsedSeconds(process.pid) ?? -1;
    while (self() < 3) await new Promise((r) => setTimeout(r, 200));
    const child = await spawnBystander();
    const childElapsed = defaultIdentitySources.elapsedSeconds(child.pid);
    expect(childElapsed).toBeDefined();
    expect(childElapsed as number).toBeLessThanOrEqual(1);
    // POSITIVE 対: 自プロセスの経過時間は 3s 以上。
    expect(self()).toBeGreaterThanOrEqual(3);
  }, 10_000);
});

describe("INV-ATTACH-STATE-TRUST: isDaemonProcess の分岐 (OS 情報を注入)", () => {
  const T = Date.parse("2026-10-06T00:00:00.000Z");
  const B = "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0";
  /** 記録 pid。fake の OS 情報源はこの pid の問い合わせにだけ答え、それ以外の pid (自 pid・"self") は throw する。 */
  const PID = 4242;
  const only = (pid: number | "self"): void => {
    if (pid !== PID)
      throw new Error(`identity source asked about pid ${String(pid)}, expected ${PID}`);
  };
  /**
   * 厳密な fake (QA-STA-R2-1): pid を取る 3 つの問い合わせ (signal0 / readStartTicks / elapsedSeconds) は
   * 記録 pid 以外で throw する。isDaemonProcess のどの呼び出し site が別の pid を渡しても、その行は RED になる。
   */
  function src(o: {
    sig?: Signal0Result[];
    boot?: string;
    ticks?: number;
    elapsedFromStart?: number;
  }): IdentitySources {
    const sig = [...(o.sig ?? ["exists"])];
    return {
      signal0: (pid) => {
        only(pid);
        return sig.length > 1 ? (sig.shift() as Signal0Result) : (sig[0] as Signal0Result);
      },
      readBootId: () => o.boot,
      readStartTicks: (pid) => {
        only(pid);
        return o.ticks;
      },
      // 子の開始時刻 = T + elapsedFromStart (ms)・now = T + 600s。
      elapsedSeconds: (pid) => {
        only(pid);
        return o.elapsedFromStart === undefined ? undefined : (600_000 - o.elapsedFromStart) / 1000;
      },
      now: () => T + 600_000,
    };
  }
  const st = (procIdentity?: ProcIdentity) => ({
    pid: PID,
    startedAt: new Date(T).toISOString(),
    ...(procIdentity ? { procIdentity } : {}),
  });
  const CASES: ReadonlyArray<readonly [string, ReturnType<typeof st>, IdentitySources, string]> = [
    ["ESRCH", st(), src({ sig: ["esrch"] }), "dead"],
    ["EPERM", st(), src({ sig: ["eperm"] }), "unknown"],
    ["signal 0 のその他の失敗", st(), src({ sig: ["error"] }), "unknown"],
    ["Linux ticks 一致", st({ bootId: B, startTicks: 5 }), src({ boot: B, ticks: 5 }), "alive"],
    ["Linux ticks 不一致", st({ bootId: B, startTicks: 5 }), src({ boot: B, ticks: 6 }), "dead"],
    [
      "Linux boot_id 不一致",
      st({ bootId: B, startTicks: 5 }),
      src({ boot: B.replace("0f", "1f"), ticks: 5 }),
      "dead",
    ],
    ["Linux ticks 読めない", st({ bootId: B, startTicks: 5 }), src({ boot: B }), "unknown"],
    [
      "procIdentity あり・boot_id 読めない (非 Linux) は etime",
      st({ bootId: B, startTicks: 5 }),
      src({ elapsedFromStart: -10_000 }),
      "alive",
    ],
    ["etime: startedAt より前に起動", st(), src({ elapsedFromStart: -10_000 }), "alive"],
    ["etime: startedAt + 2000ms ちょうど (許容内)", st(), src({ elapsedFromStart: 2000 }), "alive"],
    [
      "etime: startedAt + 3000ms (許容超過・boot_id 読めない)",
      st(),
      src({ elapsedFromStart: 3000 }),
      "dead",
    ],
    [
      "etime: startedAt + 3000ms (許容超過・boot_id 読める = Linux の旧 state)",
      st(),
      src({ boot: B, elapsedFromStart: 3000 }),
      "unknown",
    ],
    ["etime 取れない・まだ存在", st(), src({}), "unknown"],
    ["etime 取れない・その間に終了", st(), src({ sig: ["exists", "esrch"] }), "dead"],
  ];
  for (const [name, state, s, want] of CASES) {
    it(`${name} → ${want}`, () => {
      expect(isDaemonProcess(state, s)).toBe(want);
    });
  }
  it("fake の OS 情報源は記録 pid 以外の問い合わせに答えない (厳密さ自体の固定)", () => {
    const s = src({ ticks: 5, elapsedFromStart: 0 });
    // POSITIVE 対: 記録 pid には答える。
    expect(s.signal0(PID)).toBe("exists");
    expect(s.readStartTicks(PID)).toBe(5);
    expect(s.elapsedSeconds(PID)).toBe(600);
    for (const other of [process.pid, PID + 1] as const) {
      expect(() => s.signal0(other)).toThrow(`expected ${PID}`);
      expect(() => s.readStartTicks(other)).toThrow(`expected ${PID}`);
      expect(() => s.elapsedSeconds(other)).toThrow(`expected ${PID}`);
    }
    expect(() => s.readStartTicks("self")).toThrow(`expected ${PID}`);
  });

  it("parser: /proc stat の comm に `) ` があっても field 22・etime の 4 形", () => {
    const fields = Array.from({ length: 20 }, (_, i) => String(i + 3));
    expect(parseStartTicks(`99 (a) b (c)) ${fields.join(" ")}`)).toBe(22);
    expect(parseStartTicks("99 (x) S 1")).toBeUndefined();
    expect(parseEtimeSeconds("  05:03\n")).toBe(303);
    expect(parseEtimeSeconds("1:02:03")).toBe(3723);
    expect(parseEtimeSeconds("2-01:02:03")).toBe(2 * 86400 + 3723);
    expect(parseEtimeSeconds("abc")).toBeUndefined();
  });
});
