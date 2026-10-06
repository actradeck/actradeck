/**
 * INV-ATTACH-SCOPE-LOCK (task 01a10c42 PR-B2・Triangle ADR 01a10ddb D1 / D4・裁定 01a11052)。
 *
 * attach の判定 (state の読み取り) と除去 / 書込は scope lock (`withScopeLock`・`~/.actradeck/daemon/<scopeKey>.lock`・
 * settings の lock とは別 path) の下で行う。lock の直列化は **実プロセス** (distinct pid) で検証する
 * (file-lock は自 pid の lock を奪うので thread では検証できない)。
 *
 * - V1: daemon A (別プロセス) が scope lock を保持して merge → (窓) → state を書く間に、拒否される起動 B が
 *   後始末を走らせても、B は lock を待ち、A の state を生きた daemon として読んで触らない (A の配線と state が残る)。
 * - V2: scope lock を settings の lock と同じ path にすると、入れ子の内側が自 pid の lock を奪って外側が無 lock に
 *   なる (V1 と同じ形が RED)。同じ process の中の入れ子は throw する (再入の unit)。
 * - lock を取得できなければ後始末は `lock-unavailable` (throw しない・何も変えない)・`daemon stop` も
 *   `lock-unavailable` (終了コード 1)。
 * - V3: lock の下の後始末は endpoint を問わず全 ActraDeck entry を外す (記録外の port・marker の無い legacy
 *   literal / env 署名・marker 付きの command 形)。
 * - V5: 後始末の順序は detach → state → token file。detach が失敗したら state も token file も残る。
 * - V7: startDaemon が throw しても後始末 (stale のみ) を走らせてから元の例外を投げる。
 * - lock2 の再判定: 起動の間に別の daemon が state を書いていたら自分の daemon を止めて already-running。
 *   corrupt な state は lock2 で読み直して上書きする (TDA-STA-4 (3)・base 同値)。
 * - SEC-STA-R2-1: 起動中に settings の親 dir の symlink が付け替わっても、state は merge の後に再導出した
 *   path に書く (status / stop が書いた daemon を見つけられる)。
 * - V15: daemon 自身の終了 (shutdownSelf) は、state が自分なら全部外し、無ければ自分の endpoint の entry だけを
 *   外して state に触らず、別 pid / corrupt なら何も触らない。kill しない。
 *
 * すべて temp HOME / temp cwd で動かす (実 ~/.claude・~/.actradeck に触れない)。signal は自分で spawn した子
 * だけに送る。
 */
import { type ChildProcess, spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

import { AttachDaemon } from "../src/attach-daemon.js";
import {
  cleanupStaleWiring,
  type DaemonArgs,
  type DaemonRuntime,
  parseDaemonArgs,
  resolveSettingsPath,
  runStart,
  runStatus,
  runStop,
  shutdownSelf,
  stopOutcomeExitCode,
  type StopOutcome,
  scopeTarget,
  withScopeLock,
} from "../src/daemon-cli.js";
import { readState, scopeArtifacts, writeDaemonState } from "../src/daemon-state.js";
import { defaultIdentitySources } from "../src/process-identity.js";
import { ACTRADECK_MARKER, mergeAttachHooks } from "../src/settings-merge.js";

import {
  actradeckEndpoints,
  actradeckEntries,
  appendEntriesFor,
  daemonStateFor,
  deadPid,
  stubRuntime,
} from "./helpers/attach-fixtures.js";
import { tsxBin, waitForFile, workerScript } from "./helpers/lock-test-support.js";

const WS = "ws://127.0.0.1:1/ingest/ws";
const TOKEN = "tok-scope-lock-0123456789abcdef0123456";
const USER_HOOK_COMMAND = "echo user-hook-kept";

let home: string;
let cwd: string;
let sig: string;
const children: ChildProcess[] = [];
/** holder の実 worker の pid (tsx の子プロセス・SIGKILL で止める)。 */
const workerPids: number[] = [];
const daemons: AttachDaemon[] = [];
beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), "actradeck-scopelock-home-")));
  cwd = realpathSync(mkdtempSync(join(tmpdir(), "actradeck-scopelock-cwd-")));
  sig = mkdtempSync(join(tmpdir(), "actradeck-scopelock-sig-"));
});
afterEach(async () => {
  for (const pid of workerPids.splice(0)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* 既に終了 */
    }
    for (let i = 0; i < 250; i += 1) {
      try {
        process.kill(pid, 0);
      } catch {
        break;
      }
      await new Promise((r) => setTimeout(r, 20));
    }
  }
  for (const c of children.splice(0)) {
    if (c.exitCode === null && c.signalCode === null) {
      const gone = new Promise((r) => c.once("exit", r));
      c.kill("SIGKILL");
      await gone;
    }
  }
  for (const d of daemons.splice(0)) await d.shutdown();
  for (const d of [home, cwd, sig]) rmSync(d, { recursive: true, force: true });
});

/** listen して閉じた (= 今は誰も bind していない) loopback port の endpoint。 */
async function deadEndpoint(): Promise<string> {
  const srv = createServer();
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const addr = srv.address();
  const port = typeof addr === "object" && addr !== null ? addr.port : 0;
  await new Promise<void>((r) => srv.close(() => r()));
  expect(port).toBeGreaterThan(0);
  return `http://127.0.0.1:${port}/hook`;
}

interface Residue {
  readonly settingsPath: string;
  readonly statePath: string;
  readonly tokenPath: string;
  readonly endpoint: string;
}

/** crash した daemon の残骸: 利用者 hook + 死んだ port の配線 + 死んだ pid の state + hook token file。 */
async function plantResidue(): Promise<Residue> {
  const settingsPath = resolveSettingsPath("project-local", cwd, home);
  mkdirSync(dirname(settingsPath), { recursive: true });
  writeFileSync(
    settingsPath,
    JSON.stringify({
      hooks: {
        PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: USER_HOOK_COMMAND }] }],
      },
    }),
  );
  const endpoint = await deadEndpoint();
  mergeAttachHooks({ settingsPath, endpoint, tokenMode: "literal", token: TOKEN });
  const art = scopeArtifacts(settingsPath, home);
  writeDaemonState(art.statePath, daemonStateFor(settingsPath, { pid: deadPid(), endpoint }));
  writeFileSync(art.tokenPath, "token-file-marker", { mode: 0o600 });
  expect(actradeckEntries(settingsPath).length).toBeGreaterThan(0);
  return { settingsPath, statePath: art.statePath, tokenPath: art.tokenPath, endpoint };
}

/** post-condition: state が残るか、ActraDeck entry が 0 本 (state を失って配線だけが残る形を作らない)。 */
function expectNoHandleLoss(r: Residue): void {
  expect(existsSync(r.statePath) || actradeckEntries(r.settingsPath).length === 0).toBe(true);
}

/** scope lock を別プロセスで保持する daemon A / 保持だけの holder (helpers/scope-lock-holder.mts)。 */
async function spawnHolder(
  mode: "start" | "hold",
  holdMs: number,
  endpoint = "",
): Promise<{ child: ChildProcess; pid: number }> {
  const child = spawn(tsxBin, [workerScript("scope-lock-holder.mts")], {
    env: {
      ...process.env,
      MODE: mode,
      HOME_DIR: home,
      CWD_DIR: cwd,
      SIG_DIR: sig,
      HOLD_MS: String(holdMs),
      ENDPOINT: endpoint,
    },
    stdio: ["ignore", "ignore", "inherit"],
  });
  children.push(child);
  expect(await waitForFile(join(sig, "held"), 20_000), "holder never entered the lock").toBe(true);
  // tsx は worker を子プロセスで走らせるので、lock と state の pid は worker が書いた値を使う。
  let pid = Number(readFileSync(join(sig, "held"), "utf8"));
  for (let i = 0; i < 50 && !(pid > 0); i += 1) {
    await new Promise((r) => setTimeout(r, 10));
    pid = Number(readFileSync(join(sig, "held"), "utf8"));
  }
  expect(Number.isInteger(pid) && pid > 0).toBe(true);
  workerPids.push(pid);
  return { child, pid };
}

const projectLocal = (): DaemonArgs => parseDaemonArgs(["attach", "--token-mode", "env"], cwd);

describe("INV-ATTACH-SCOPE-LOCK: 判定と除去 / 書込は別プロセスとの間で scope lock で直列化される (V1 / V2・実プロセス)", () => {
  it("V1: A が lock の中で merge → 窓 → state を書く間の拒否起動 B は lock を待ち、A を生きた daemon として触らない", async () => {
    const r = await plantResidue();
    const aEndpoint = await deadEndpoint();
    const a = await spawnHolder("start", 700, aEndpoint);
    // A は merge を終えて lock の中で待っている (state はまだ残骸の死んだ pid)。
    const aCount = actradeckEndpoints(r.settingsPath).filter((e) => e === aEndpoint).length;
    expect(aCount).toBeGreaterThan(0);
    const logs: string[] = [];
    const t0 = Date.now();
    const out = await runStart(
      projectLocal(),
      { wsUrl: WS, dbPath: join(cwd, "b.db") },
      stubRuntime(home, logs),
    );
    const waited = Date.now() - t0;
    expect(out.status).toBe("denied-env-token-missing");
    expect("cleanup" in out ? out.cleanup : undefined).toBe("alive-untouched");
    expect(existsSync(join(sig, "released"))).toBe(true);
    // A の配線は 1 本も欠けず、A の state は A の pid (B は lock を待ってから読んだ)。
    expect(actradeckEndpoints(r.settingsPath).filter((e) => e === aEndpoint).length).toBe(aCount);
    const st = readState(scopeArtifacts(r.settingsPath, home), ["project-local"]);
    expect(st.kind === "state" ? st.state.pid : undefined).toBe(a.pid);
    expect(st.kind === "state" ? st.state.endpoint : undefined).toBe(aEndpoint);
    expect(readFileSync(r.tokenPath, "utf8")).toBe("token-file-marker");
    expectNoHandleLoss(r);
    // B は A が lock を外すまで待った (A は held の後 700ms 保持する)。
    expect(waited).toBeGreaterThanOrEqual(300);
    expect(
      runStatus(parseDaemonArgs(["daemon", "status"], cwd), stubRuntime(home, [])).running,
    ).toBe(true);
  }, 30_000);

  it("V2: 同じ process の中で同じ scope の lock を入れ子に取ると throw する (対照: 順に取る・別 scope の入れ子は通る)", () => {
    const t = scopeTarget("project-local", cwd, home);
    let inner = 0;
    expect(() => withScopeLock(t, () => withScopeLock(t, () => (inner += 1)))).toThrow("入れ子");
    expect(inner).toBe(0);
    // 別の target object でも scopeKey が同じなら入れ子 (cwd = home の project と user は同じ settings file)。
    const proj = scopeTarget("project", home, home);
    const user = scopeTarget("user", home, home);
    expect(proj.artifacts.scopeKey).toBe(user.artifacts.scopeKey);
    expect(() => withScopeLock(proj, () => withScopeLock(user, () => undefined))).toThrow("入れ子");
    // 対照 (POSITIVE): 順に取れば通り、別 scope の入れ子も通る (順序は scope → settings なので settings の lock
    // とは衝突しない)。
    expect(withScopeLock(t, () => 1) + withScopeLock(t, () => 2)).toBe(3);
    const other = scopeTarget("project", cwd, home);
    expect(other.artifacts.scopeKey).not.toBe(t.artifacts.scopeKey);
    expect(withScopeLock(t, () => withScopeLock(other, () => "ok"))).toBe("ok");
    // lock file は settings の lock と別 path で、0700 の dir の下に作る。
    expect(t.artifacts.lockPath).not.toBe(`${t.settingsPath}.actradeck-lock`);
    expect(dirname(t.artifacts.lockPath)).toBe(join(home, ".actradeck", "daemon"));
    expect(statSync(dirname(t.artifacts.lockPath)).mode & 0o777).toBe(0o700);
  });
});

describe("INV-ATTACH-SCOPE-LOCK: lock を取得できなければ何も変えずに報告する (throw しない)", () => {
  it("後始末は lock-unavailable・daemon stop は lock-unavailable (終了コード 1)・daemon 自身の終了も触らない", async () => {
    const r = await plantResidue();
    const settingsBefore = readFileSync(r.settingsPath, "utf8");
    const stateBefore = readFileSync(r.statePath, "utf8");
    await spawnHolder("hold", 15_000);
    const logs: string[] = [];
    const cleanup = cleanupStaleWiring({
      target: scopeTarget("project-local", cwd, home),
      writeApproved: true,
      log: (m) => logs.push(m),
    });
    expect(cleanup).toBe("lock-unavailable");
    const stop = runStop(parseDaemonArgs(["daemon", "stop"], cwd), stubRuntime(home, logs));
    expect(stop).toMatchObject({ status: "lock-unavailable", kill: "skipped-lock-unavailable" });
    expect(stopOutcomeExitCode(stop)).toBe(1);
    expect(shutdownSelf(projectLocal(), stubRuntime(home, logs), r.endpoint).kind).toBe(
      "lock-unavailable",
    );
    expect(readFileSync(r.settingsPath, "utf8")).toBe(settingsBefore);
    expect(readFileSync(r.statePath, "utf8")).toBe(stateBefore);
    expect(readFileSync(r.tokenPath, "utf8")).toBe("token-file-marker");
    expect(logs.join("\n")).toContain("を取得できなかった");
  }, 40_000);

  it("daemon stop の終了コード: incomplete と lock-unavailable は 1・stopped と not-running は 0 (裁定 01a11052 ③)", () => {
    const base = { detached: false, settingsPaths: [] } as const;
    const rows: readonly [StopOutcome, 0 | 1][] = [
      [{ ...base, status: "stopped", kill: "sent" }, 0],
      [{ ...base, status: "not-running", kill: "no-state" }, 0],
      [{ ...base, status: "incomplete", kill: "sent" }, 1],
      [{ ...base, status: "lock-unavailable", kill: "skipped-lock-unavailable" }, 1],
    ];
    for (const [o, code] of rows) expect(stopOutcomeExitCode(o), o.status).toBe(code);
    expect(new Set(rows.map(([o]) => o.status)).size).toBe(rows.length);
  });
});

/** marker 付きの command 形 entry (T-B の shim 配線の形・url を持たず args に endpoint を持つ)。 */
function appendCommandEntry(settingsPath: string, endpoint: string): void {
  const s = JSON.parse(readFileSync(settingsPath, "utf8")) as {
    hooks: Record<string, unknown[]>;
  };
  s.hooks.PreToolUse = [
    ...(s.hooks.PreToolUse ?? []),
    {
      hooks: [
        {
          type: "command",
          command: `node /opt/actradeck/hook-shim.js --endpoint ${endpoint} --event PreToolUse`,
          [ACTRADECK_MARKER]: true,
        },
      ],
    },
  ];
  writeFileSync(settingsPath, JSON.stringify(s));
}

/** marker を外した legacy 署名の entry を settings に足す (本番 merge の形から marker を落とす)。 */
async function appendLegacy(settingsPath: string, kind: "literal" | "env"): Promise<void> {
  const other = join(dirname(settingsPath), `legacy-${kind}.json`);
  mergeAttachHooks({
    settingsPath: other,
    endpoint: await deadEndpoint(),
    tokenMode: kind,
    ...(kind === "literal" ? { token: TOKEN } : {}),
  });
  const b = JSON.parse(readFileSync(other, "utf8")) as {
    hooks: Record<string, Array<{ hooks: Array<Record<string, unknown>> }>>;
  };
  for (const groups of Object.values(b.hooks))
    for (const g of groups)
      for (const e of g.hooks) {
        delete e[ACTRADECK_MARKER];
        if (kind === "env") delete e.headers;
      }
  const a = JSON.parse(readFileSync(settingsPath, "utf8")) as { hooks: Record<string, unknown[]> };
  for (const [ev, groups] of Object.entries(b.hooks))
    a.hooks[ev] = [...(a.hooks[ev] ?? []), ...groups];
  writeFileSync(settingsPath, JSON.stringify(a));
  rmSync(other, { force: true });
}

describe("INV-ATTACH-SCOPE-LOCK: lock の下の後始末の範囲・順序・throw 経路 (V3 / V5 / V7)", () => {
  it("V3: 記録外の port・legacy literal / env 署名・marker 付き command 形も外し、state と token file を消す", async () => {
    const r = await plantResidue();
    appendEntriesFor(r.settingsPath, await deadEndpoint(), { token: TOKEN });
    await appendLegacy(r.settingsPath, "literal");
    await appendLegacy(r.settingsPath, "env");
    appendCommandEntry(r.settingsPath, await deadEndpoint());
    const kinds = actradeckEntries(r.settingsPath);
    // 足した形が実在する (POSITIVE): command 形 (url 無し)・marker 無し・記録外の endpoint。
    expect(kinds.some((e) => (e as { type?: unknown }).type === "command")).toBe(true);
    expect(kinds.some((e) => !(ACTRADECK_MARKER in (e as object)))).toBe(true);
    expect(new Set(actradeckEndpoints(r.settingsPath)).size).toBeGreaterThan(3);
    const res = cleanupStaleWiring({
      target: scopeTarget("project-local", cwd, home),
      writeApproved: true,
      log: () => undefined,
    });
    expect(res).toBe("detached");
    expect(actradeckEntries(r.settingsPath)).toEqual([]);
    expect(readFileSync(r.settingsPath, "utf8")).toContain(USER_HOOK_COMMAND);
    expect(existsSync(r.statePath)).toBe(false);
    expect(existsSync(r.tokenPath)).toBe(false);
  });

  it("V5: detach が失敗したら state も token file も残す (後始末・daemon stop とも・対照: 読めれば両方消える)", async () => {
    const r = await plantResidue();
    const stateBefore = readFileSync(r.statePath, "utf8");
    writeFileSync(r.settingsPath, "{ not json");
    expect(
      cleanupStaleWiring({
        target: scopeTarget("project-local", cwd, home),
        writeApproved: true,
        log: () => undefined,
      }),
    ).toBe("detach-failed");
    expect(() =>
      runStop(parseDaemonArgs(["daemon", "stop"], cwd), stubRuntime(home, [])),
    ).toThrow();
    expect(readFileSync(r.statePath, "utf8")).toBe(stateBefore);
    expect(readFileSync(r.tokenPath, "utf8")).toBe("token-file-marker");
    // 対照 (POSITIVE)。
    const q = await plantResidue();
    expect(runStop(parseDaemonArgs(["daemon", "stop"], cwd), stubRuntime(home, []))).toMatchObject({
      status: "stopped",
      state: "removed",
      token: "removed",
    });
    expect(existsSync(q.statePath)).toBe(false);
    expect(existsSync(q.tokenPath)).toBe(false);
  });

  it("V7: startDaemon が throw したら stale な配線 (記録外も) と state・token file を片付けてから元の例外を投げる", async () => {
    const r = await plantResidue();
    appendEntriesFor(r.settingsPath, await deadEndpoint(), { token: TOKEN });
    const logs: string[] = [];
    await expect(
      runStart(
        parseDaemonArgs(["attach"], cwd),
        { wsUrl: WS, dbPath: join(cwd, "x.db") },
        stubRuntime(home, logs, { startDaemon: () => Promise.reject(new Error("bind failed")) }),
      ),
    ).rejects.toThrow("bind failed");
    expect(actradeckEntries(r.settingsPath)).toEqual([]);
    expect(existsSync(r.statePath)).toBe(false);
    expect(existsSync(r.tokenPath)).toBe(false);
    expectNoHandleLoss(r);
    expect(logs.join("\n")).toContain("stale state を消しました");
  });
});

/** 実 AttachDaemon を起動する runtime。`onStarted` は daemon 起動の直後 (lock2 の前) に呼ぶ。 */
function startingRuntime(logs: string[], onStarted?: (endpoint: string) => void): DaemonRuntime {
  return stubRuntime(home, logs, {
    startDaemon: async (o) => {
      const daemon = new AttachDaemon({ wsUrl: o.wsUrl, dbPath: o.dbPath, host: "127.0.0.1" });
      const { hookEndpoint } = await daemon.start();
      daemons.push(daemon);
      onStarted?.(hookEndpoint);
      return { daemon, hookEndpoint, hookToken: daemon.hookAuthToken };
    },
  });
}

/** 生きている無関係の子プロセス (自分で spawn・afterEach で必ず止める)。 */
async function spawnBystander(): Promise<{ pid: number }> {
  const c = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  children.push(c);
  await new Promise<void>((res, rej) => c.once("spawn", res).once("error", rej));
  return { pid: c.pid as number };
}

describe("INV-ATTACH-SCOPE-LOCK: lock2 で読み直して判定する (TDA-TD-4 / TDA-STA-4 (3) / SEC-STA-R2-1)", () => {
  it("起動の間に別の daemon が state を書いていたら、自分の daemon を止めて already-running (配線も state も書かない)", async () => {
    const r = await plantResidue();
    const other = await spawnBystander();
    const bootId = defaultIdentitySources.readBootId();
    const startTicks = defaultIdentitySources.readStartTicks(other.pid);
    const otherEndpoint = await deadEndpoint();
    const settingsBefore = readFileSync(r.settingsPath, "utf8");
    let otherState = "";
    let ownEndpoint = "";
    const logs: string[] = [];
    const out = await runStart(
      parseDaemonArgs(["attach"], cwd),
      { wsUrl: WS, dbPath: join(cwd, "lost.db") },
      startingRuntime(logs, (endpoint) => {
        ownEndpoint = endpoint;
        const { procIdentity: _self, ...rest } = daemonStateFor(r.settingsPath, {
          pid: other.pid,
          endpoint: otherEndpoint,
        });
        void _self;
        writeDaemonState(r.statePath, {
          ...rest,
          ...(bootId !== undefined && startTicks !== undefined
            ? { procIdentity: { bootId, startTicks } }
            : {}),
        });
        otherState = readFileSync(r.statePath, "utf8");
      }),
    );
    expect(out).toMatchObject({ status: "already-running", hookEndpoint: otherEndpoint });
    expect(readFileSync(r.statePath, "utf8")).toBe(otherState);
    // 配線は書いていない (settings は起動前のバイト列のまま)。
    expect(readFileSync(r.settingsPath, "utf8")).toBe(settingsBefore);
    expect(ownEndpoint.length).toBeGreaterThan(0);
    // 自分の daemon は止めた (endpoint に届かない)。
    await expect(fetch(ownEndpoint, { method: "POST", body: "{}" })).rejects.toThrow();
    expect(logs.join("\n")).toContain("この daemon は止めました");
  }, 30_000);

  it("起動の間に state が corrupt になっても lock2 で読み直して上書きする (base 同値・対照: 起動前から corrupt でも同じ)", async () => {
    const r = await plantResidue();
    const logs: string[] = [];
    const out = await runStart(
      parseDaemonArgs(["attach"], cwd),
      { wsUrl: WS, dbPath: join(cwd, "corrupt.db") },
      startingRuntime(logs, () => writeFileSync(r.statePath, "{ not json")),
    );
    expect(out.status).toBe("started");
    const st = readState(scopeArtifacts(r.settingsPath, home), ["project-local"]);
    expect(st.kind === "state" ? st.state.pid : undefined).toBe(process.pid);
    expect(st.kind === "state" ? st.state.endpoint : undefined).toBe(out.hookEndpoint);
    expect(actradeckEndpoints(r.settingsPath).every((e) => e === out.hookEndpoint)).toBe(true);
    expect(
      shutdownSelf(parseDaemonArgs(["attach"], cwd), stubRuntime(home, []), out.hookEndpoint ?? "")
        .kind,
    ).toBe("torn-down");
  }, 30_000);

  it("SEC-STA-R2-1: 起動中に cwd の symlink が付け替わっても state は merge の後に再導出した path に書く (status は稼働中・終了で 0 本)", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "actradeck-scopelock-retarget-")));
    try {
      const r1 = join(root, "r1");
      const r2 = join(root, "r2");
      mkdirSync(r1);
      mkdirSync(r2);
      const app = join(root, "app");
      symlinkSync(r1, app);
      const args = parseDaemonArgs(["attach"], app);
      const pre = scopeArtifacts(resolveSettingsPath("project-local", app, home), home);
      const logs: string[] = [];
      const out = await runStart(
        args,
        { wsUrl: WS, dbPath: join(root, "retarget.db") },
        startingRuntime(logs, () => {
          rmSync(app);
          symlinkSync(r2, app);
        }),
      );
      expect(out.status).toBe("started");
      const settingsPath = resolveSettingsPath("project-local", app, home);
      const post = scopeArtifacts(settingsPath, home);
      expect(post.statePath).not.toBe(pre.statePath);
      // 配線は付け替え先 (r2) に書かれ、state もその path の key で書かれている。
      expect(actradeckEndpoints(join(r2, ".claude", "settings.local.json"))).toContain(
        out.hookEndpoint,
      );
      expect(existsSync(post.statePath)).toBe(true);
      expect(existsSync(pre.statePath)).toBe(false);
      expect(out.statePath).toBe(post.statePath);
      expect(
        runStatus(parseDaemonArgs(["daemon", "status"], app), stubRuntime(home, [])).running,
      ).toBe(true);
      expect(shutdownSelf(args, stubRuntime(home, []), out.hookEndpoint ?? "").kind).toBe(
        "torn-down",
      );
      expect(actradeckEntries(join(r2, ".claude", "settings.local.json"))).toEqual([]);
      expect(existsSync(post.statePath)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);
});

describe("INV-ATTACH-SCOPE-LOCK: daemon 自身の終了 (shutdownSelf) は自分の配線だけを外し kill しない (V15)", () => {
  let executed = 0;
  afterAll(() => {
    expect(executed).toBe(4);
  });

  it("state が自分 (pid が自プロセス) なら全部外し、state と token file を消す", async () => {
    const r = await plantResidue();
    writeDaemonState(
      r.statePath,
      daemonStateFor(r.settingsPath, { pid: process.pid, endpoint: r.endpoint }),
    );
    appendEntriesFor(r.settingsPath, await deadEndpoint(), { token: TOKEN });
    const out = shutdownSelf(projectLocal(), stubRuntime(home, []), r.endpoint);
    expect(out).toEqual({ kind: "torn-down", detached: true, state: "removed", token: "removed" });
    expect(actradeckEntries(r.settingsPath)).toEqual([]);
    expect(existsSync(r.statePath)).toBe(false);
    expect(existsSync(r.tokenPath)).toBe(false);
    executed += 1;
  });

  it("state が別 pid (後から起動した daemon) なら何も触らない (対照: 自分の pid なら外す = 上の行)", async () => {
    const r = await plantResidue();
    const other = await spawnBystander();
    writeDaemonState(
      r.statePath,
      daemonStateFor(r.settingsPath, { pid: other.pid, endpoint: r.endpoint }),
    );
    const settingsBefore = readFileSync(r.settingsPath, "utf8");
    const stateBefore = readFileSync(r.statePath, "utf8");
    expect(shutdownSelf(projectLocal(), stubRuntime(home, []), r.endpoint).kind).toBe(
      "untouched-other",
    );
    expect(readFileSync(r.settingsPath, "utf8")).toBe(settingsBefore);
    expect(readFileSync(r.statePath, "utf8")).toBe(stateBefore);
    expect(readFileSync(r.tokenPath, "utf8")).toBe("token-file-marker");
    // kill しない (記録 pid の子は生きている)。
    expect(defaultIdentitySources.signal0(other.pid)).toBe("exists");
    executed += 1;
  });

  it("state が無ければ自分の endpoint の entry だけを外し、state にも token file にも触らない", async () => {
    const r = await plantResidue();
    rmSync(r.statePath);
    const otherEndpoint = await deadEndpoint();
    appendEntriesFor(r.settingsPath, otherEndpoint, { token: TOKEN });
    const otherCount = actradeckEndpoints(r.settingsPath).filter((e) => e === otherEndpoint).length;
    expect(otherCount).toBeGreaterThan(0);
    expect(actradeckEndpoints(r.settingsPath)).toContain(r.endpoint);
    const out = shutdownSelf(projectLocal(), stubRuntime(home, []), r.endpoint);
    expect(out).toEqual({ kind: "own-endpoint-detached", detached: true });
    expect(actradeckEndpoints(r.settingsPath)).not.toContain(r.endpoint);
    expect(actradeckEndpoints(r.settingsPath).filter((e) => e === otherEndpoint).length).toBe(
      otherCount,
    );
    expect(existsSync(r.statePath)).toBe(false);
    expect(readFileSync(r.tokenPath, "utf8")).toBe("token-file-marker");
    executed += 1;
  });

  it("state が corrupt なら何も触らず daemon stop を案内する", async () => {
    const r = await plantResidue();
    writeFileSync(r.statePath, "{ not json");
    const settingsBefore = readFileSync(r.settingsPath, "utf8");
    const logs: string[] = [];
    expect(shutdownSelf(projectLocal(), stubRuntime(home, logs), r.endpoint).kind).toBe(
      "untouched-corrupt",
    );
    expect(readFileSync(r.settingsPath, "utf8")).toBe(settingsBefore);
    expect(readFileSync(r.statePath, "utf8")).toBe("{ not json");
    expect(logs.join("\n")).toContain("agentmon daemon stop --scope project-local");
    executed += 1;
  });
});
