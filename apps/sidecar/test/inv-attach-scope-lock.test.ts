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
 * - V3: 自動の後始末 (拒否起動・起動失敗) は記録 endpoint の entry だけを外し、ほかの ActraDeck entry (記録外の
 *   port・marker の無い legacy literal / env 署名・marker 付きの command 形) が残れば state を残す。利用者の
 *   `daemon stop` は全部外す (裁定 01a110b2)。
 * - lock を共有しない daemon (別 HOME・旧い build 相当の lock 無し merge → state) の生きた配線は、自動の後始末で
 *   外れない (SEC-SL-1 の vector・実 CLI)。
 * - 別プロセスが scope lock を保持している間の start は lock1 / lock2 のどちらでも throw し何も書かない
 *   (SEC-SL-2 ≡ TDA-SL-2)。lock2 の再判定は同一性 unknown を稼働中とみなす (SEC-SL-6)。
 * - 実 CLI: signal で終了する daemon は state が別 pid なら何も触らず、state が無ければ自分の endpoint だけを外す・
 *   `daemon stop` の終了コード (QA-SL-1 / QA-SL-2)。
 * - V5: 後始末の順序は detach → state → token file。detach が失敗したら state も token file も残る。
 * - V7: startDaemon が throw しても後始末 (stale のみ) を走らせてから元の例外を投げる。
 * - lock2 の再判定: 起動の間に別の daemon が state を書いていたら自分の daemon を止めて already-running。
 *   corrupt な state は lock2 で読み直して上書きする (TDA-STA-4 (3)・base 同値)。
 * - SEC-STA-R2-1: 起動中に settings の親 dir の symlink が付け替わっても、state は merge の後に再導出した
 *   path に書く (status / stop が書いた daemon を見つけられる)。
 * - V15: daemon 自身の終了 (shutdownSelf) は、state が自分なら全部外し、無い / corrupt なら自分の endpoint の entry
 *   だけを外して state に触らず、別 pid なら何も触らない。kill しない。
 *
 * すべて temp HOME / temp cwd で動かす (実 ~/.claude・~/.actradeck に触れない)。signal は自分で spawn した子
 * だけに送る。
 */
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
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
  ScopeLockUnavailableError,
  shutdownSelf,
  stopOutcomeExitCode,
  type StopOutcome,
  scopeTarget,
  withScopeLock,
} from "../src/daemon-cli.js";
import { readState, scopeArtifacts, writeDaemonState } from "../src/daemon-state.js";
import { defaultIdentitySources, type IdentitySources } from "../src/process-identity.js";
import { ACTRADECK_MARKER, endpointOfEntry, mergeAttachHooks } from "../src/settings-merge.js";

import {
  actradeckEndpoints,
  actradeckEntries,
  appendEntriesFor,
  daemonStateFor,
  type AttachCli,
  deadPid,
  killAttachCli,
  sidecarRoot,
  startAttachCli,
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
  it("V3: 自動の後始末は記録 endpoint の entry だけを外し、記録外の port・legacy literal / env 署名・marker 付き command 形が残れば state と token file を残す (対照: daemon stop は全部外す)", async () => {
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
    const others = actradeckEntries(r.settingsPath).filter(
      (e) => endpointOfEntry(e) !== r.endpoint,
    );
    const stateBefore = readFileSync(r.statePath, "utf8");
    const res = cleanupStaleWiring({
      target: scopeTarget("project-local", cwd, home),
      writeApproved: true,
      log: () => undefined,
    });
    expect(res).toBe("detached-entries-remain");
    expect(actradeckEndpoints(r.settingsPath).filter((e) => e === r.endpoint)).toEqual([]);
    expect(actradeckEntries(r.settingsPath)).toEqual(others);
    expect(readFileSync(r.statePath, "utf8")).toBe(stateBefore);
    expect(readFileSync(r.tokenPath, "utf8")).toBe("token-file-marker");
    expectNoHandleLoss(r);
    // 対照 (POSITIVE): 利用者の daemon stop は endpoint を問わず全部外し、state と token file を消す。
    expect(runStop(parseDaemonArgs(["daemon", "stop"], cwd), stubRuntime(home, []))).toMatchObject({
      status: "stopped",
      state: "removed",
      token: "removed",
    });
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

  it("V7: startDaemon が throw したら記録 endpoint の配線を外してから元の例外を投げる (記録外が残れば state と token file は残す・対照: 記録外が無ければ全部片付く)", async () => {
    const r = await plantResidue();
    const otherEndpoint = await deadEndpoint();
    appendEntriesFor(r.settingsPath, otherEndpoint, { token: TOKEN });
    const otherCount = actradeckEndpoints(r.settingsPath).filter((e) => e === otherEndpoint).length;
    expect(otherCount).toBeGreaterThan(0);
    const logs: string[] = [];
    const failing = () =>
      runStart(
        parseDaemonArgs(["attach"], cwd),
        { wsUrl: WS, dbPath: join(cwd, "x.db") },
        stubRuntime(home, logs, { startDaemon: () => Promise.reject(new Error("bind failed")) }),
      );
    await expect(failing()).rejects.toThrow("bind failed");
    expect(actradeckEndpoints(r.settingsPath).filter((e) => e === r.endpoint)).toEqual([]);
    expect(actradeckEndpoints(r.settingsPath).filter((e) => e === otherEndpoint).length).toBe(
      otherCount,
    );
    expect(existsSync(r.statePath)).toBe(true);
    expect(readFileSync(r.tokenPath, "utf8")).toBe("token-file-marker");
    expectNoHandleLoss(r);
    expect(logs.join("\n")).toContain(ENTRIES_REMAIN_MSG);
    // 対照 (POSITIVE): 記録外が無ければ同じ throw 経路で配線・state・token file が片付く。
    rmSync(r.settingsPath);
    const q = await plantResidue();
    await expect(failing()).rejects.toThrow("bind failed");
    expect(actradeckEntries(q.settingsPath)).toEqual([]);
    expect(existsSync(q.statePath)).toBe(false);
    expect(existsSync(q.tokenPath)).toBe(false);
    expect(logs.join("\n")).toContain(DETACHED_MSG);
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

  it("起動の間に state が corrupt になっても lock2 で読み直して上書きする (base 同値)", async () => {
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
    expect(out).toEqual({ kind: "own-endpoint-detached", detached: true, record: "absent" });
    expect(actradeckEndpoints(r.settingsPath)).not.toContain(r.endpoint);
    expect(actradeckEndpoints(r.settingsPath).filter((e) => e === otherEndpoint).length).toBe(
      otherCount,
    );
    expect(existsSync(r.statePath)).toBe(false);
    expect(readFileSync(r.tokenPath, "utf8")).toBe("token-file-marker");
    executed += 1;
  });

  it("state が corrupt なら自分の endpoint の entry だけを外し、state のバイトは変えず daemon stop を案内する (SEC-SL-3 ≡ TDA-SL-1)", async () => {
    const r = await plantResidue();
    writeFileSync(r.statePath, "{ not json");
    const otherEndpoint = await deadEndpoint();
    appendEntriesFor(r.settingsPath, otherEndpoint, { token: TOKEN });
    const otherCount = actradeckEndpoints(r.settingsPath).filter((e) => e === otherEndpoint).length;
    expect(otherCount).toBeGreaterThan(0);
    expect(actradeckEndpoints(r.settingsPath)).toContain(r.endpoint);
    const logs: string[] = [];
    expect(shutdownSelf(projectLocal(), stubRuntime(home, logs), r.endpoint)).toEqual({
      kind: "own-endpoint-detached",
      detached: true,
      record: "corrupt",
    });
    expect(actradeckEndpoints(r.settingsPath).filter((e) => e === r.endpoint)).toEqual([]);
    expect(actradeckEndpoints(r.settingsPath).filter((e) => e === otherEndpoint).length).toBe(
      otherCount,
    );
    expect(readFileSync(r.statePath, "utf8")).toBe("{ not json");
    expect(readFileSync(r.tokenPath, "utf8")).toBe("token-file-marker");
    expect(logs.join("\n")).toContain("agentmon daemon stop --scope project-local");
    executed += 1;
  });
});

/** 記録 endpoint 以外の entry が残ったときの後始末の文言 (base と同じ・R2 ガード)。 */
const ENTRIES_REMAIN_MSG = "ほかの ActraDeck hook 配線が残っているため、state は残します";
/** 記録 endpoint の entry が 1 本も無かったときの文言。 */
const NONE_PHRASE = "を向いた hook 配線は既に無くなっていました";
/** 記録 endpoint の entry を外して state を消したときの文言。 */
const DETACHED_MSG = "stale state を消しました";

/** この file が起動した実 attach CLI (afterEach でグループごと止める)。 */
const clis: AttachCli[] = [];
afterEach(async () => {
  for (const cli of clis.splice(0)) await killAttachCli(cli);
});

/** 実 attach CLI を常駐させ、その endpoint を返す (`attach` の後ろに `args`)。 */
async function residentCli(
  args: readonly string[],
  at: { readonly cwd: string; readonly home: string; readonly db: string },
): Promise<{ cli: AttachCli; endpoint: string }> {
  const cli = await startAttachCli(args, at);
  clis.push(cli);
  const m = /常駐中 \(endpoint=(http:\/\/127\.0\.0\.1:\d+\/hook)\)/.exec(cli.stderr());
  expect(m?.[1], cli.stderr()).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/hook$/);
  return { cli, endpoint: (m as RegExpExecArray)[1] as string };
}

/** 実 CLI (`src/cli.ts <args>`) を 1 回走らせて終わるまで待つ (env は最小限・tmp HOME)。 */
function runCli(
  args: readonly string[],
  at: { readonly cwd: string; readonly home: string; readonly db?: string },
): { status: number | null; stderr: string } {
  const r = spawnSync(tsxBin, [join(sidecarRoot, "src", "cli.ts"), ...args], {
    cwd: at.cwd,
    env: {
      PATH: process.env.PATH ?? "",
      HOME: at.home,
      ACTRADECK_WS_URL: "ws://127.0.0.1:1",
      ACTRADECK_DB: at.db ?? join(at.cwd, "run-cli.db"),
    },
    encoding: "utf8",
    timeout: 60_000,
  });
  return { status: r.status, stderr: r.stderr };
}

/** settings の中で `endpoint` を向く ActraDeck entry の数。 */
function countAt(settingsPath: string, endpoint: string): number {
  return actradeckEndpoints(settingsPath).filter((e) => e === endpoint).length;
}

/** SEC の det-probes の ctxAt と同じ形: <base>/repo に利用者 hook だけの settings・<base>/home。 */
function ctxAt(name: string): {
  base: string;
  cwd: string;
  home: string;
  settingsPath: string;
  db: string;
} {
  const base = join(cwd, name);
  const repo = join(base, "repo");
  mkdirSync(join(repo, ".claude"), { recursive: true });
  const h = join(base, "home");
  mkdirSync(h, { recursive: true });
  const settingsPath = join(repo, ".claude", "settings.local.json");
  writeFileSync(
    settingsPath,
    JSON.stringify({
      hooks: {
        PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo user-hook" }] }],
      },
    }),
  );
  return { base, cwd: repo, home: h, settingsPath, db: join(base, "a.db") };
}

describe("INV-ATTACH-SCOPE-LOCK: lock を共有しない daemon の生きた配線は自動の後始末で外れない (SEC-SL-1 ⊇ TDA-SL-3 の vector・実 CLI・base 同値)", () => {
  it("別 HOME: HOME=h1 の daemon Y が配線した同じ project settings を、HOME=h2 の拒否起動の後始末は外さない (Y の 15 本が残る)", async () => {
    // SEC det-probes multi-home の手順どおり。
    const y = ctxAt("m");
    const h2 = join(cwd, "m", "home2");
    mkdirSync(h2, { recursive: true });
    const art2 = scopeArtifacts(y.settingsPath, h2);
    const yd = await residentCli(["--cwd", y.cwd], y);
    // h2 の下の stale 記録 + その死んだ entry (HOME=h2 で起動した daemon が以前 crash した形)。
    const staleEp = await deadEndpoint();
    appendEntriesFor(y.settingsPath, staleEp, { token: "tok-stale-0123456789abcdef0123456789" });
    writeDaemonState(art2.statePath, {
      pid: deadPid(),
      endpoint: staleEp,
      scope: "project-local",
      settingsPath: art2.canonicalSettingsPath,
      startedAt: new Date().toISOString(),
      tokenMode: "literal",
    });
    const yBefore = countAt(y.settingsPath, yd.endpoint);
    expect(yBefore).toBe(15);
    const r = runCli(["attach", "--cwd", y.cwd, "--token-mode", "env"], {
      cwd: y.cwd,
      home: h2,
      db: join(cwd, "m", "b.db"),
    });
    expect(r.status).toBe(1);
    // base と同じ結果: Y の配線は残り、記録外が残るので h2 の state も残して案内する。
    expect(countAt(y.settingsPath, yd.endpoint)).toBe(yBefore);
    expect(countAt(y.settingsPath, staleEp)).toBe(0);
    expect(await yd.cli.groupGone(0)).toBe(false);
    expect(existsSync(scopeArtifacts(y.settingsPath, y.home).statePath)).toBe(true);
    expect(existsSync(art2.statePath)).toBe(true);
    expect(r.stderr).toContain(ENTRIES_REMAIN_MSG);
    expect(r.stderr).not.toContain(DETACHED_MSG);
  }, 60_000);

  it("旧い build 相当の書き手 O (lock 無しで merge → [拒否起動の後始末] → 記録を書く): O の配線は残り、後始末は detached だけを報告しない", async () => {
    // SEC det-probes old-writer-interleave の手順どおり (順序を決め打ちにした再現)。
    const c = ctxAt("o");
    const art = scopeArtifacts(c.settingsPath, c.home);
    const staleEp = await deadEndpoint();
    mergeAttachHooks({
      settingsPath: c.settingsPath,
      endpoint: staleEp,
      tokenMode: "literal",
      token: "tok-stale-0123456789abcdef0123456789",
    });
    writeDaemonState(art.statePath, {
      pid: deadPid(),
      endpoint: staleEp,
      scope: "project-local",
      settingsPath: art.canonicalSettingsPath,
      startedAt: new Date().toISOString(),
      tokenMode: "literal",
    });
    const oEp = await deadEndpoint();
    mergeAttachHooks({
      settingsPath: c.settingsPath,
      endpoint: oEp,
      tokenMode: "literal",
      token: "tok-old-build-0123456789abcdef012345",
    });
    const oAfterMerge = countAt(c.settingsPath, oEp);
    expect(oAfterMerge).toBe(15);
    const r = runCli(["attach", "--cwd", c.cwd, "--token-mode", "env"], c);
    const oEntriesAfterCleanup = countAt(c.settingsPath, oEp);
    // O が記録を書く (旧い runStart が merge の直後に書くのと同じ)。
    writeDaemonState(art.statePath, {
      pid: process.pid,
      endpoint: oEp,
      scope: "project-local",
      settingsPath: art.canonicalSettingsPath,
      startedAt: new Date().toISOString(),
      tokenMode: "literal",
    });
    expect(r.status).toBe(1);
    expect(oEntriesAfterCleanup).toBe(oAfterMerge);
    // detached だけ (「外しました。stale state を消しました」) ではなく、残存を案内する (base と同じ)。
    expect(r.stderr).toContain(ENTRIES_REMAIN_MSG);
    expect(r.stderr).toContain(NONE_PHRASE);
    expect(r.stderr).not.toContain(DETACHED_MSG);
    const st = readState(art, ["project-local"]);
    expect(st.kind === "state" ? st.state.endpoint : undefined).toBe(oEp);
  }, 60_000);
});

describe("INV-ATTACH-SCOPE-LOCK: 別プロセスが scope lock を保持している間の start は throw して何も書かない (SEC-SL-2 ≡ TDA-SL-2・SEC-SL-6)", () => {
  it("lock1: 保持中の start は ScopeLockUnavailableError で reject し、startDaemon を呼ばず settings / state を変えない (実 CLI は exit 1・db も作らない)", async () => {
    const r = await plantResidue();
    const settingsBefore = readFileSync(r.settingsPath, "utf8");
    const stateBefore = readFileSync(r.statePath, "utf8");
    await spawnHolder("hold", 20_000);
    let started = 0;
    await expect(
      runStart(
        parseDaemonArgs(["attach"], cwd),
        { wsUrl: WS, dbPath: join(cwd, "lock1.db") },
        stubRuntime(home, [], {
          startDaemon: () => {
            started += 1;
            return Promise.reject(new Error("must not start"));
          },
        }),
      ),
    ).rejects.toThrow(ScopeLockUnavailableError);
    expect(started).toBe(0);
    // 実 CLI も同じ: exit 1・daemon を作らない (AttachDaemon は db を開く)・何も書かない。
    const db = join(cwd, "lock1-cli.db");
    const cli = runCli(["attach"], { cwd, home, db });
    expect(cli.status).toBe(1);
    expect(cli.stderr).toContain("scope lock");
    expect(existsSync(db)).toBe(false);
    expect(readFileSync(r.settingsPath, "utf8")).toBe(settingsBefore);
    expect(readFileSync(r.statePath, "utf8")).toBe(stateBefore);
  }, 60_000);

  it("lock2: daemon 起動の間に別プロセスが lock を取ったら、自分の daemon を止めて reject し settings / state を変えない", async () => {
    const r = await plantResidue();
    const settingsBefore = readFileSync(r.settingsPath, "utf8");
    const stateBefore = readFileSync(r.statePath, "utf8");
    let ownEndpoint = "";
    await expect(
      runStart(
        parseDaemonArgs(["attach"], cwd),
        { wsUrl: WS, dbPath: join(cwd, "lock2.db") },
        stubRuntime(home, [], {
          startDaemon: async (o) => {
            const daemon = new AttachDaemon({
              wsUrl: o.wsUrl,
              dbPath: o.dbPath,
              host: "127.0.0.1",
            });
            const { hookEndpoint } = await daemon.start();
            daemons.push(daemon);
            ownEndpoint = hookEndpoint;
            await spawnHolder("hold", 20_000);
            return { daemon, hookEndpoint, hookToken: daemon.hookAuthToken };
          },
        }),
      ),
    ).rejects.toThrow(ScopeLockUnavailableError);
    expect(ownEndpoint.length).toBeGreaterThan(0);
    await expect(fetch(ownEndpoint, { method: "POST", body: "{}" })).rejects.toThrow();
    expect(readFileSync(r.settingsPath, "utf8")).toBe(settingsBefore);
    expect(readFileSync(r.statePath, "utf8")).toBe(stateBefore);
  }, 60_000);

  it("lock2 の再判定は同一性 unknown の記録を稼働中とみなす: 自分の daemon を止めて already-running・settings を変えない (SEC-SL-6)", async () => {
    const r = await plantResidue();
    const other = await spawnBystander();
    const settingsBefore = readFileSync(r.settingsPath, "utf8");
    const otherEndpoint = await deadEndpoint();
    // 記録 pid だけ同一性を確かめられない (EPERM と同じ扱い) 源。
    const identity: IdentitySources = {
      ...defaultIdentitySources,
      signal0: (pid) => (pid === other.pid ? "eperm" : defaultIdentitySources.signal0(pid)),
    };
    let written = "";
    const logs: string[] = [];
    const out = await runStart(
      parseDaemonArgs(["attach"], cwd),
      { wsUrl: WS, dbPath: join(cwd, "unknown.db") },
      {
        ...startingRuntime(logs, () => {
          writeDaemonState(
            r.statePath,
            daemonStateFor(r.settingsPath, { pid: other.pid, endpoint: otherEndpoint }),
          );
          written = readFileSync(r.statePath, "utf8");
        }),
        identity,
      },
    );
    expect(out).toMatchObject({ status: "already-running", hookEndpoint: otherEndpoint });
    expect(readFileSync(r.settingsPath, "utf8")).toBe(settingsBefore);
    expect(readFileSync(r.statePath, "utf8")).toBe(written);
    expect(logs.join("\n")).toContain("同一性は未確認");
  }, 30_000);
});

describe("INV-ATTACH-SCOPE-LOCK: 実 CLI の signal 終了と daemon stop の終了コード (QA-SL-1 / QA-SL-2)", () => {
  it("SIGHUP: state が別の生きた pid なら settings / state を変えず相手も止めない (対照: 自分の state なら entry 0・state 削除)", async () => {
    const { cli } = await residentCli([], { cwd, home, db: join(cwd, "p1.db") });
    const settingsPath = resolveSettingsPath("project-local", cwd, home);
    const art = scopeArtifacts(settingsPath, home);
    const by = await spawnBystander();
    const bootId = defaultIdentitySources.readBootId();
    const startTicks = defaultIdentitySources.readStartTicks(by.pid);
    const own = JSON.parse(readFileSync(art.statePath, "utf8")) as Record<string, unknown>;
    writeDaemonState(art.statePath, {
      ...(own as unknown as Parameters<typeof writeDaemonState>[1]),
      pid: by.pid,
      endpoint: "http://127.0.0.1:1/hook",
      ...(bootId !== undefined && startTicks !== undefined
        ? { procIdentity: { bootId, startTicks } }
        : {}),
    });
    const settingsBefore = readFileSync(settingsPath, "utf8");
    const stateBefore = readFileSync(art.statePath, "utf8");
    expect(actradeckEntries(settingsPath).length).toBe(15);
    process.kill(-cli.pgid, "SIGHUP");
    expect(await cli.groupGone(15_000), cli.stderr()).toBe(true);
    expect(readFileSync(settingsPath, "utf8")).toBe(settingsBefore);
    expect(readFileSync(art.statePath, "utf8")).toBe(stateBefore);
    expect(defaultIdentitySources.signal0(by.pid)).toBe("exists");
    // 対照 (POSITIVE): 別 dir で、自分の state のまま SIGHUP すると entry 0・state 削除。
    const cwd2 = join(cwd, "own");
    mkdirSync(cwd2);
    const own2 = await residentCli([], { cwd: cwd2, home, db: join(cwd2, "p1b.db") });
    const settings2 = resolveSettingsPath("project-local", cwd2, home);
    const art2 = scopeArtifacts(settings2, home);
    expect(actradeckEntries(settings2).length).toBe(15);
    process.kill(-own2.cli.pgid, "SIGHUP");
    expect(await own2.cli.groupGone(15_000), own2.cli.stderr()).toBe(true);
    expect(actradeckEntries(settings2)).toEqual([]);
    expect(existsSync(art2.statePath)).toBe(false);
  }, 90_000);

  it("SIGHUP: state が無ければ自分の endpoint の entry だけを外し、ほかの endpoint の entry は残す", async () => {
    const { cli, endpoint } = await residentCli([], { cwd, home, db: join(cwd, "p4.db") });
    const settingsPath = resolveSettingsPath("project-local", cwd, home);
    const art = scopeArtifacts(settingsPath, home);
    const otherEndpoint = await deadEndpoint();
    appendEntriesFor(settingsPath, otherEndpoint, { token: TOKEN });
    const otherCount = countAt(settingsPath, otherEndpoint);
    expect(otherCount).toBeGreaterThan(0);
    expect(countAt(settingsPath, endpoint)).toBe(15);
    rmSync(art.statePath);
    process.kill(-cli.pgid, "SIGHUP");
    expect(await cli.groupGone(15_000), cli.stderr()).toBe(true);
    expect(countAt(settingsPath, endpoint)).toBe(0);
    expect(countAt(settingsPath, otherEndpoint)).toBe(otherCount);
    expect(existsSync(art.statePath)).toBe(false);
  }, 60_000);

  it("daemon stop: 別プロセスが scope lock を保持していれば exit 1 で何も変えない", async () => {
    const r = await plantResidue();
    const settingsBefore = readFileSync(r.settingsPath, "utf8");
    const stateBefore = readFileSync(r.statePath, "utf8");
    await spawnHolder("hold", 20_000);
    const stop = runCli(["daemon", "stop"], { cwd, home });
    expect(stop.status).toBe(1);
    expect(stop.stderr).toContain("を取得できなかった");
    expect(readFileSync(r.settingsPath, "utf8")).toBe(settingsBefore);
    expect(readFileSync(r.statePath, "utf8")).toBe(stateBefore);
  }, 60_000);

  it("daemon stop: hook token file を消せなければ (incomplete) exit 1 (対照: 片付けば exit 0)", async () => {
    const r = await plantResidue();
    rmSync(r.tokenPath);
    mkdirSync(join(r.tokenPath, "x"), { recursive: true });
    const stop = runCli(["daemon", "stop"], { cwd, home });
    expect(stop.status).toBe(1);
    expect(stop.stderr).toContain("停止の後始末が終わっていません");
    rmSync(r.tokenPath, { recursive: true, force: true });
    // 対照 (POSITIVE)。
    await plantResidue();
    const ok = runCli(["daemon", "stop"], { cwd, home });
    expect(ok.status).toBe(0);
    expect(ok.stderr).not.toContain("停止の後始末が終わっていません");
  }, 60_000);
});

/**
 * 同じ HOME で、bind mount した別 path から同じ settings を扱う形 (SEC-SL-1 repro 2)。`unshare -rm` (root 不要の
 * private mount namespace) が使える環境だけで走る: unprivileged user namespace を制限している環境 (Ubuntu 24.04
 * の AppArmor 既定など) では使えないので skip する。そのため INV の名前 (CI の assert-inv-ran が skip を拒否する
 * 集合) には入れない。
 */
const userNamespaceMount =
  process.platform === "linux" &&
  spawnSync("unshare", ["-rm", "sh", "-c", "mount -t tmpfs none /mnt"], { stdio: "ignore" })
    .status === 0;

describe.runIf(userNamespaceMount)(
  "attach bind mount 残余 (unshare -rm が使える環境のみ・SEC-SL-1 repro 2・base 同値)",
  () => {
    it("bind mount の別 path (別 scopeKey) の拒否起動の後始末は、repo で常駐する daemon の 15 本を外さない", () => {
      const base = join(cwd, "bind");
      mkdirSync(base);
      const r = spawnSync("unshare", ["-rm", tsxBin, workerScript("bind-mount-worker.mts")], {
        env: { ...process.env, BASE: base, TSX_BIN: tsxBin },
        encoding: "utf8",
        timeout: 120_000,
      });
      expect(r.status, r.stderr).toBe(0);
      const out = JSON.parse(r.stdout.trim().split("\n").pop() ?? "{}") as {
        keys: { repo: string; alt: string };
        yEntriesBefore: number;
        yEntriesAfter: number;
        yAlive: boolean;
        yStateStill: boolean;
        altStateStill: boolean;
        refusedExit: number;
        refusedStderr: string;
      };
      expect(out.keys.repo).not.toBe(out.keys.alt);
      expect(out.yEntriesBefore).toBe(15);
      expect(out.yEntriesAfter).toBe(15);
      expect(out.yAlive).toBe(true);
      expect(out.yStateStill).toBe(true);
      expect(out.altStateStill).toBe(true);
      expect(out.refusedExit).toBe(1);
      expect(out.refusedStderr).toContain(ENTRIES_REMAIN_MSG);
    }, 150_000);
  },
);
