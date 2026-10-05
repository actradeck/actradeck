/**
 * INV-ATTACH-STATE-TRUST (Triangle ADR 01a10ddb D3 / D7・task 01a10c42 PR-A)。
 *
 * - V9: scope の artifact path は realpath 正規化した settings path から導出する。symlink 経由の cwd と
 *   物理 cwd は同じ state を指す。symlink を含まない path では旧 `scopeHash(settingsPath)` と同値 (互換)。
 * - V10: state の形検証は `asDaemonState` 1 か所・reader は `readState` 1 本 (absent | corrupt | state)。
 *   legacy の `wiredSettingsPaths` は導出 settings path と一致する要素 1 個の配列だけを受理する。
 * - corrupt: 拒否起動の後始末は書かずに `state-invalid`・`daemon stop` は全 detach + state 削除で kill しない。
 * - V8: `daemon stop` は記録 pid が記録した daemon と同一だと確かめられたときだけ SIGTERM を送る。生きている
 *   無関係の子プロセス (自分で spawn したもの) の pid を state に入れても、その子は止まらない。
 * - upgrade の窓: 新しい path に state が無いときは、旧い dist の path (symlink を解決しない settings path の
 *   scopeHash) を reader の中で読む。start / stop / status / 拒否起動の後始末がすべて同じ reader を通る。
 * - cwd が home: project と user が同じ settings file を指すときは、どちらの scope ラベルの state も受け入れる
 *   (別 file を指す scope のラベルは corrupt のまま)。
 *
 * temp HOME / temp cwd で動かす (実 ~/.claude・~/.actradeck に触れない)。signal は自分で spawn した子にだけ届く。
 */
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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
} from "../src/daemon-cli.js";
import {
  canonicalPath,
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
import { isActradeckEntry, mergeAttachHooks } from "../src/settings-merge.js";

import { tsxBin } from "./helpers/lock-test-support.js";

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
  writeDaemonState(statePath, {
    endpoint: DEAD_ENDPOINT,
    scope: "project-local",
    settingsPath: canonicalPath(settingsPath),
    startedAt: new Date().toISOString(),
    tokenMode: "literal",
    ...over,
  });
  return { settingsPath, statePath };
}
function entries(settingsPath: string): number {
  const s = JSON.parse(readFileSync(settingsPath, "utf8")) as {
    hooks?: Record<string, Array<{ hooks?: unknown[] }>>;
  };
  return Object.values(s.hooks ?? {})
    .flat()
    .flatMap((g) => g.hooks ?? [])
    .filter(isActradeckEntry).length;
}
function rt(logs: string[], identity?: IdentitySources): DaemonRuntime {
  return {
    home,
    log: (m) => logs.push(m),
    startDaemon: () => Promise.reject(new Error("would start")),
    ...(identity !== undefined ? { identity } : {}),
  };
}
const withSignal0 = (r: Signal0Result): IdentitySources => ({
  ...defaultIdentitySources,
  signal0: () => r,
});

describe("INV-ATTACH-STATE-TRUST: scope の artifact path は realpath 正規化した settings path から導出する (V9)", () => {
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
    const deadPid = spawnSync(process.execPath, ["-e", ""]).pid;
    const { settingsPath, statePath, raw } = plantCorrupt(deadPid);
    const before = readFileSync(settingsPath, "utf8");
    const logs: string[] = [];
    const base = {
      statePath,
      settingsPath,
      scope: "project-local" as const,
      cwd,
      writeApproved: true,
    };
    expect(cleanupStaleWiring({ home, ...base, log: (m) => logs.push(m) })).toBe("state-invalid");
    expect(readFileSync(settingsPath, "utf8")).toBe(before);
    expect(readFileSync(statePath, "utf8")).toBe(raw);
    expect(logs.join("\n")).toContain(INVALID_MSG);
    expect(logs.join("\n")).toContain(`agentmon daemon stop --scope project-local --cwd ${cwd}`);
    plant({ pid: deadPid });
    const logs2: string[] = [];
    expect(cleanupStaleWiring({ home, ...base, log: (m) => logs2.push(m) })).toBe("detached");
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
    expect(stop).toMatchObject({
      status: "stopped",
      kill: "skipped-corrupt",
      state: "corrupt-removed",
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
      name: "procIdentity 無し・子は startedAt より後に起動 (etime 許容超過)",
      linuxOnly: false,
      state: () => ({ startedAt: minuteAgo() }),
      kill: "skipped-dead",
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
      const { settingsPath, statePath } = plant(reused);
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
      expect(
        cleanupStaleWiring({
          home,
          statePath,
          settingsPath,
          scope: "project-local",
          cwd,
          writeApproved: true,
          log: (m) => logs.push(m),
        }),
      ).toBe("detached");
      expect(entries(settingsPath)).toBe(0);
      expect(running(child)).toBe(true);
    },
  );

  it("同一性 unknown は alive 扱い: 後始末は触らない・起動は already-running・status は稼働中 (対照: 注入なしの一致は alive)", async () => {
    const child = await spawnBystander();
    const { settingsPath, statePath } = plant({
      pid: child.pid,
      startedAt: new Date(Date.now() - 60_000).toISOString(),
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
        home,
        statePath,
        settingsPath,
        scope: "project-local",
        cwd,
        writeApproved: true,
        log: (m) => logs.push(m),
        identity: unknown,
      }),
    ).toBe("alive-untouched");
    expect(readFileSync(settingsPath, "utf8")).toBe(before);
    // 対照: 注入なしでは、この state (startedAt は子の起動より前) は stale (etime) として外れる。
    expect(runStatus(parseDaemonArgs(["daemon", "status"], cwd), rt(logs)).liveness).toBe("dead");
    expect(running(child)).toBe(true);
  });
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
    const deadPid = spawnSync(process.execPath, ["-e", ""]).pid;
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
    const deadPid = spawnSync(process.execPath, ["-e", ""]).pid;
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

const sidecarRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

describe("INV-ATTACH-STATE-TRUST: cwd が home のとき project と user は同じ settings file を指し、どちらの scope でも止められる", () => {
  it("実 attach CLI を user scope で home から起動 → `daemon stop --scope project` (cwd = home) が kill して外す", async () => {
    const child = spawn(
      tsxBin,
      [join(sidecarRoot, "src", "cli.ts"), "attach", "--scope", "user", "--yes"],
      {
        cwd: home,
        env: {
          PATH: process.env.PATH ?? "",
          HOME: home,
          ACTRADECK_WS_URL: "ws://127.0.0.1:1",
          ACTRADECK_DB: join(home, "cli.db"),
        },
        stdio: ["ignore", "ignore", "pipe"],
        detached: true,
      },
    );
    const pgid = child.pid as number;
    let stderr = "";
    child.stderr.on("data", (c: Buffer) => (stderr += c.toString()));
    const groupGone = async (ms: number): Promise<boolean> => {
      const deadline = Date.now() + ms;
      for (;;) {
        try {
          process.kill(-pgid, 0);
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === "ESRCH") return true;
        }
        if (Date.now() >= deadline) return false;
        await new Promise((r) => setTimeout(r, 20));
      }
    };
    try {
      const deadline = Date.now() + 20_000;
      while (!stderr.includes("常駐中") && Date.now() < deadline) {
        if (await groupGone(0)) break;
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(stderr, stderr).toContain("常駐中");
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
      const stop = runStop(
        parseDaemonArgs(["daemon", "stop", "--scope", "project"], home),
        rt(logs),
      );
      expect(stop.kill).toBe("sent");
      expect(await groupGone(15_000), `attach CLI survived SIGTERM: ${stderr}`).toBe(true);
      expect(entries(userSettings)).toBe(0);
      expect(existsSync(scopeArtifacts(userSettings, home).statePath)).toBe(false);
    } finally {
      try {
        process.kill(-pgid, "SIGKILL");
      } catch {
        /* 既に終了 */
      }
      expect(await groupGone(5_000), "process group survived the group kill").toBe(true);
    }
  }, 40_000);

  it("project ラベルの state も `--scope user` で止まる (cwd = home)・別 file を指す scope のラベルは corrupt のまま", async () => {
    const child = await spawnBystander();
    const userSettings = resolveSettingsPath("user", home, home);
    mkdirSync(dirname(userSettings), { recursive: true });
    mergeAttachHooks({ settingsPath: userSettings, endpoint: DEAD_ENDPOINT, tokenMode: "env" });
    const art = scopeArtifacts(userSettings, home);
    const state = (scope: AttachScope, settingsPath: string): DaemonState => ({
      pid: child.pid,
      endpoint: DEAD_ENDPOINT,
      scope,
      settingsPath: canonicalPath(settingsPath),
      startedAt: new Date().toISOString(),
      tokenMode: "env",
    });
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

describe("INV-ATTACH-STATE-TRUST: isDaemonProcess の分岐 (OS 情報を注入)", () => {
  const T = Date.parse("2026-10-06T00:00:00.000Z");
  const B = "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0";
  function src(o: {
    sig?: Signal0Result[];
    boot?: string;
    ticks?: number;
    elapsedFromStart?: number;
  }): IdentitySources {
    const sig = [...(o.sig ?? ["exists"])];
    return {
      signal0: () => (sig.length > 1 ? (sig.shift() as Signal0Result) : (sig[0] as Signal0Result)),
      readBootId: () => o.boot,
      readStartTicks: () => o.ticks,
      // 子の開始時刻 = T + elapsedFromStart (ms)・now = T + 600s。
      elapsedSeconds: () =>
        o.elapsedFromStart === undefined ? undefined : (600_000 - o.elapsedFromStart) / 1000,
      now: () => T + 600_000,
    };
  }
  const st = (procIdentity?: ProcIdentity) => ({
    pid: 4242,
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
    ["etime: startedAt + 3000ms (許容超過)", st(), src({ elapsedFromStart: 3000 }), "dead"],
    ["etime 取れない・まだ存在", st(), src({}), "unknown"],
    ["etime 取れない・その間に終了", st(), src({ sig: ["exists", "esrch"] }), "dead"],
  ];
  for (const [name, state, s, want] of CASES) {
    it(`${name} → ${want}`, () => {
      expect(isDaemonProcess(state, s)).toBe(want);
    });
  }
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
