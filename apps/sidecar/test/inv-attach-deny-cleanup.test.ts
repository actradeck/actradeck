/**
 * INV-ATTACH-DENY-CLEANUP / INV-ATTACH-SIGHUP-DETACH (SEC-ENV-4・task 01a10831-8102)。
 *
 * daemon が crash (SIGKILL) や端末クローズ (SIGHUP) で落ちると、settings の hook は死んだ port を
 * 向いたまま残る。その port を別プロセスが bind すると hook payload と token を受け取れる。
 *
 * - 拒否された起動 (denied-*) は、前回 daemon の state が stale (pid 死亡) なら配線を外し state を消す。
 *   生きている daemon の配線には触らない。user / project scope で --yes も confirm の承認も無いときは
 *   書かずに `daemon stop --scope <scope>` を案内する (confirm ゲートの趣旨を崩さない)。
 * - 起動後の拒否 (denied-env-token-mismatch) も同じ後始末に載る (stale state を先に消して配線だけ残す
 *   経路を塞ぐ・SEC R2 の追記)。
 * - attach CLI は SIGHUP でも SIGINT / SIGTERM と同じ detach + shutdown を行う (実プロセスで固定)。
 *
 * すべて temp HOME / temp cwd で動かす (実 ~/.claude・~/.actradeck に触れない)。
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
  type StartOutcome,
} from "../src/daemon-cli.js";
import {
  isPidAlive,
  removeDaemonStateIfUnchanged,
  stateFilePath,
  writeDaemonState,
} from "../src/daemon-state.js";
import {
  computeDetachedSettings,
  isActradeckEntry,
  mergeAttachHooks,
  type TokenMode,
} from "../src/settings-merge.js";

import { tsxBin } from "./helpers/lock-test-support.js";

/**
 * 競合の決定的注入点 (R1 unblock・TDA の probe R2 と同じ形)。`checkExistingDaemon` の戻り値は本物のまま、
 * 戻る直前に `race.fire` を 1 回だけ同期実行する。未設定なら素通し (他の test には影響しない)。
 */
const race = vi.hoisted(() => ({ fire: undefined as undefined | (() => void), fired: 0 }));
vi.mock("../src/daemon-state.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../src/daemon-state.js")>();
  return {
    ...orig,
    checkExistingDaemon: (p: string) => {
      const r = orig.checkExistingDaemon(p);
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

const WS = "ws://127.0.0.1:1/ingest/ws";
const GOOD_TOKEN = "tok-deny-cleanup-0123456789abcdef0123";
/** 拒否経路で配線を外したときの文言 (detach 行の POSITIVE と、触らない行の negative で同じ literal)。 */
const DETACHED_MSG = "stale state を消しました";
/** 判定の後に state が書き換わっていたので消さなかったときの文言 (R2 の POSITIVE と R1 の negative で同じ literal)。 */
const STATE_CHANGED_MSG = "state は判定の後に書き換わっていたため消していません";
/** 外さずに案内したときの文言の核 (同上)。 */
const STOP_HINT = "agentmon daemon stop --scope";
/** project 系の案内に付く起動ディレクトリ指定 (user 行の negative と project 行の POSITIVE で同じ literal)。 */
const CWD_FLAG = "--cwd";
/** 停止案内の期待形 (実装の stopCommandHint とは別に仕様から組み立てる・同じ helper を呼ぶと変異が素通る)。 */
function expectedHint(scope: AttachScope): string {
  return scope === "user" ? `${STOP_HINT} user` : `${STOP_HINT} ${scope} ${CWD_FLAG} ${cwd}`;
}
/** 利用者の hook (detach で温存されること・POSITIVE)。 */
const USER_HOOK_COMMAND = "echo user-hook-kept";

let home: string;
let cwd: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "actradeck-deny-home-"));
  cwd = mkdtempSync(join(tmpdir(), "actradeck-deny-cwd-"));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});

/** 実際に終了したプロセスの pid (stale state の pid)。 */
function deadPid(): number {
  const r = spawnSync(process.execPath, ["-e", ""]);
  const pid = r.pid;
  expect(Number.isInteger(pid) && pid > 0).toBe(true);
  expect(isPidAlive(pid)).toBe(false);
  return pid;
}

/** listen して閉じた (= 今は誰も bind していない) loopback port。 */
async function deadPort(): Promise<number> {
  const srv = createServer();
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const addr = srv.address();
  const port = typeof addr === "object" && addr !== null ? addr.port : 0;
  await new Promise<void>((r) => srv.close(() => r()));
  expect(port).toBeGreaterThan(0);
  return port;
}

interface Residue {
  readonly settingsPath: string;
  readonly statePath: string;
  readonly deadEndpoint: string;
  readonly settingsBefore: string;
  readonly stateBefore: string;
  readonly pid: number;
}

/**
 * crash した daemon の残骸を作る: 利用者 hook + 死んだ port を向いた ActraDeck 配線 + state file。
 * 配線は本番と同じ mergeAttachHooks で書く (手書きの entry を作らない)。
 */
async function plantResidue(
  scope: AttachScope,
  pid: number,
  extraWired: readonly string[] = [],
): Promise<Residue> {
  const settingsPath = resolveSettingsPath(scope, cwd, home);
  mkdirSync(dirname(settingsPath), { recursive: true });
  writeFileSync(
    settingsPath,
    JSON.stringify({
      hooks: {
        PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: USER_HOOK_COMMAND }] }],
      },
    }),
  );
  const deadEndpoint = `http://127.0.0.1:${await deadPort()}/hook`;
  // project scope は tracked file なので env mode (値を書かない)・それ以外は literal。
  const tokenMode: TokenMode = scope === "project" ? "env" : "literal";
  mergeAttachHooks({
    settingsPath,
    endpoint: deadEndpoint,
    tokenMode,
    ...(tokenMode === "literal" ? { token: GOOD_TOKEN } : {}),
  });
  const statePath = stateFilePath(settingsPath, home);
  writeDaemonState(statePath, {
    pid,
    endpoint: deadEndpoint,
    wiredSettingsPaths: [settingsPath, ...extraWired],
    scope,
    startedAt: new Date(0).toISOString(),
  });
  const settingsBefore = readFileSync(settingsPath, "utf8");
  expect(actradeckEntries(settingsPath).length).toBeGreaterThan(0);
  expect(settingsBefore).toContain(deadEndpoint);
  return {
    settingsPath,
    statePath,
    deadEndpoint,
    settingsBefore,
    stateBefore: readFileSync(statePath, "utf8"),
    pid,
  };
}

function actradeckUrls(settingsPath: string): string[] {
  return actradeckEntries(settingsPath).map((e) => String((e as { url?: unknown }).url));
}

function actradeckEntries(settingsPath: string): unknown[] {
  const s = JSON.parse(readFileSync(settingsPath, "utf8")) as {
    hooks?: Record<string, Array<{ hooks?: unknown[] }>>;
  };
  return Object.values(s.hooks ?? {})
    .flat()
    .flatMap((g) => g.hooks ?? [])
    .filter(isActradeckEntry);
}

type RuntimeKind = "normal" | "mismatch";

/**
 * 実 AttachDaemon を起動する runtime。mismatch は「渡された hookToken を無視し自前 nonce で起動する」
 * 壊れた受け渡し (本番では到達しない・test でだけ denied-env-token-mismatch に到達させる)。
 * `onStarted` は daemon 起動直後 (runStart が mismatch を判定する前) に呼ぶ。
 */
function makeRuntime(
  logs: string[],
  kind: RuntimeKind,
  opts: { confirm?: boolean; onStarted?: () => void } = {},
): { rt: DaemonRuntime; daemons: AttachDaemon[] } {
  const daemons: AttachDaemon[] = [];
  const rt: DaemonRuntime = {
    home,
    log: (m) => logs.push(m),
    ...(opts.confirm !== undefined ? { confirm: () => opts.confirm as boolean } : {}),
    startDaemon: async (o) => {
      const daemon = new AttachDaemon({
        wsUrl: o.wsUrl,
        dbPath: o.dbPath,
        ...(kind === "normal" && o.hookToken !== undefined ? { hookToken: o.hookToken } : {}),
        host: "127.0.0.1",
      });
      const { hookEndpoint } = await daemon.start();
      daemons.push(daemon);
      opts.onStarted?.();
      return { daemon, hookEndpoint, hookToken: daemon.hookAuthToken };
    },
  };
  return { rt, daemons };
}

interface Row {
  readonly name: string;
  readonly scope: AttachScope;
  readonly argv: readonly string[];
  readonly hookToken?: string;
  /** rt.confirm の戻り値 (undefined = confirm 未提供 = CLI 既定の deny)。 */
  readonly confirm?: boolean;
  readonly runtime: RuntimeKind;
  readonly status: StartOutcome["status"];
  /** stale state に対する期待 (detached = 外す / left = 書かずに案内)。 */
  readonly expect: "detached" | "left";
}

const ENV = ["--token-mode", "env"] as const;
const LIT = ["--token-mode", "literal"] as const;

/** 拒否経路 × scope の表。left は「confirm が要る scope で --yes も承認も無い」行だけ。 */
const ROWS: readonly Row[] = [
  // denied-env-token-missing
  ...(
    [
      ["project-local", [], "detached"],
      ["project", ["--yes"], "detached"],
      ["user", ["--yes"], "detached"],
      ["project", [], "left"],
      ["user", [], "left"],
    ] as const
  ).map(
    ([scope, flags, exp]): Row => ({
      name: `env-token-missing × ${scope}${flags.length > 0 ? " --yes" : ""}`,
      scope,
      argv: [...ENV, ...flags],
      runtime: "normal",
      status: "denied-env-token-missing",
      expect: exp,
    }),
  ),
  // denied-hook-token-invalid (env mode)
  ...(
    [
      ["project-local", [], "detached"],
      ["project", ["--yes"], "detached"],
      ["user", ["--yes"], "detached"],
      ["project", [], "left"],
      ["user", [], "left"],
    ] as const
  ).map(
    ([scope, flags, exp]): Row => ({
      name: `hook-token-invalid (env) × ${scope}${flags.length > 0 ? " --yes" : ""}`,
      scope,
      argv: [...ENV, ...flags],
      hookToken: "a",
      runtime: "normal",
      status: "denied-hook-token-invalid",
      expect: exp,
    }),
  ),
  // denied-hook-token-invalid (literal mode・SEC R2 X3 の形)
  ...(
    [
      ["project-local", [], "detached"],
      ["user", ["--yes"], "detached"],
      ["user", [], "left"],
    ] as const
  ).map(
    ([scope, flags, exp]): Row => ({
      name: `hook-token-invalid (literal) × ${scope}${flags.length > 0 ? " --yes" : ""}`,
      scope,
      argv: [...LIT, ...flags],
      hookToken: "a",
      runtime: "normal",
      status: "denied-hook-token-invalid",
      expect: exp,
    }),
  ),
  // denied-needs-confirm (confirm 未提供 / confirm が false)
  {
    name: "needs-confirm × project (confirm 未提供)",
    scope: "project",
    argv: [...ENV],
    hookToken: GOOD_TOKEN,
    runtime: "normal",
    status: "denied-needs-confirm",
    expect: "left",
  },
  {
    name: "needs-confirm × user (confirm 未提供)",
    scope: "user",
    argv: [...LIT],
    runtime: "normal",
    status: "denied-needs-confirm",
    expect: "left",
  },
  {
    name: "needs-confirm × user (confirm=false)",
    scope: "user",
    argv: [...LIT],
    confirm: false,
    runtime: "normal",
    status: "denied-needs-confirm",
    expect: "left",
  },
  // denied-token-leak (project + literal)
  {
    name: "token-leak × project --yes",
    scope: "project",
    argv: [...LIT, "--yes"],
    runtime: "normal",
    status: "denied-token-leak",
    expect: "detached",
  },
  {
    name: "token-leak × project",
    scope: "project",
    argv: [...LIT],
    runtime: "normal",
    status: "denied-token-leak",
    expect: "left",
  },
  // denied-env-token-mismatch (startDaemon 後の拒否・confirm ゲートは通過済み)
  ...(
    [
      ["project-local", [], undefined],
      ["project", ["--yes"], undefined],
      ["user", ["--yes"], undefined],
      ["project", [], true],
    ] as const
  ).map(
    ([scope, flags, confirm]): Row => ({
      name: `env-token-mismatch × ${scope}${flags.length > 0 ? " --yes" : ""}${confirm === true ? " (confirm=true)" : ""}`,
      scope,
      argv: [...ENV, ...flags],
      hookToken: GOOD_TOKEN,
      ...(confirm !== undefined ? { confirm } : {}),
      runtime: "mismatch",
      status: "denied-env-token-mismatch",
      expect: "detached",
    }),
  ),
];

describe("INV-ATTACH-DENY-CLEANUP: 拒否された起動は stale な前回 daemon の配線だけを片付ける (SEC-ENV-4)", () => {
  let staleExecuted = 0;
  let aliveExecuted = 0;
  let hintRowsExecuted = 0;
  afterAll(() => {
    expect(hintRowsExecuted).toBe(ROWS.filter((r) => r.expect === "left").length);
    // 表の全行が stale / alive の両方で実際に最後まで走った (skip・早期 return・行の削除で RED)。
    expect(staleExecuted).toBe(ROWS.length);
    expect(aliveExecuted).toBe(ROWS.length);
    expect(ROWS.filter((r) => r.expect === "left").length).toBeGreaterThan(0);
    expect(ROWS.filter((r) => r.expect === "detached").length).toBeGreaterThan(0);
  });

  it("表の構成: 拒否 status 5 種すべてを持ち、行名は相異なる", () => {
    expect(new Set(ROWS.map((r) => r.name)).size).toBe(ROWS.length);
    expect([...new Set(ROWS.map((r) => r.status))].sort()).toEqual([
      "denied-env-token-mismatch",
      "denied-env-token-missing",
      "denied-hook-token-invalid",
      "denied-needs-confirm",
      "denied-token-leak",
    ]);
    // confirm が要る scope で --yes も承認も無い行だけが left (それ以外の left は表の誤り)。
    for (const r of ROWS) {
      const confirmScope = r.scope === "project" || r.scope === "user";
      const approved = r.argv.includes("--yes") || r.confirm === true;
      expect(r.expect, r.name).toBe(confirmScope && !approved ? "left" : "detached");
    }
  });

  for (const row of ROWS) {
    it(`stale × ${row.name} → ${row.status} / ${row.expect}`, async () => {
      const r = await plantResidue(row.scope, deadPid());
      const logs: string[] = [];
      const { rt, daemons } = makeRuntime(logs, row.runtime, {
        ...(row.confirm !== undefined ? { confirm: row.confirm } : {}),
      });
      const out = await runStart(
        parseDaemonArgs(["attach", "--scope", row.scope, ...row.argv], cwd),
        {
          wsUrl: WS,
          dbPath: join(cwd, "deny.db"),
          ...(row.hookToken !== undefined ? { hookToken: row.hookToken } : {}),
        },
        rt,
      );
      expect(out.status).toBe(row.status);
      // 拒否なので新しい daemon は常駐しない (mismatch は起動後に止めている)。
      expect(daemons.length).toBe(row.runtime === "mismatch" ? 1 : 0);
      const log = logs.join("\n");
      if (row.expect === "detached") {
        expect(actradeckEntries(r.settingsPath)).toEqual([]);
        expect(readFileSync(r.settingsPath, "utf8")).not.toContain(r.deadEndpoint);
        // 利用者の hook は温存 (reversible detach・POSITIVE)。
        expect(readFileSync(r.settingsPath, "utf8")).toContain(USER_HOOK_COMMAND);
        expect(existsSync(r.statePath)).toBe(false);
        expect(log).toContain(DETACHED_MSG);
        expect(log).toContain(`pid=${r.pid}`);
        expect(log).not.toContain(STOP_HINT);
      } else {
        // 共有/グローバル settings は書かない (バイト一致)・state も残す (daemon stop が配線を見つけられる)。
        expect(readFileSync(r.settingsPath, "utf8")).toBe(r.settingsBefore);
        expect(readFileSync(r.statePath, "utf8")).toBe(r.stateBefore);
        expect(log).toContain(`${STOP_HINT} ${row.scope}`);
        expect(log).toContain(`pid=${r.pid}`);
        expect(log).not.toContain(DETACHED_MSG);
        // 案内の完全形 (QA-DC-2 ≡ TDA-DC-3): project 系は起動ディレクトリを --cwd で指す・user は付けない。
        expect(log).toContain(expectedHint(row.scope));
        if (row.scope === "user") expect(log).not.toContain(CWD_FLAG);
        else expect(log).toContain(CWD_FLAG);
        hintRowsExecuted += 1;
      }
      // token 値はログに出さない (POSITIVE 対: 拒否か後始末の文言は出ている)。
      expect(log.length).toBeGreaterThan(0);
      // POSITIVE 対 (同一リテラル): この値はこの run に実在する。project 以外の残骸は literal mode で
      // 書いたので settings に値そのものがある。project の残骸は env mode (値を書かず参照だけ) なので、
      // 値が run に入るのは hookToken に GOOD_TOKEN を渡す行だけ。渡さない project 行 (missing /
      // invalid / token-leak) ではこの値は run に存在せず、下の negative は何も検査しない (開示)。
      if (row.scope !== "project") {
        expect(r.settingsBefore).toContain(GOOD_TOKEN);
      } else {
        expect(r.settingsBefore).toContain("$ACTRADECK_HOOK_TOKEN");
        if (row.hookToken !== undefined && row.hookToken.length > 1) {
          expect(row.hookToken).toContain(GOOD_TOKEN);
        }
      }
      expect(log).not.toContain(GOOD_TOKEN);
      staleExecuted += 1;
    });

    it(`alive (対照) × ${row.name} → 生きている daemon の配線と state に触らない`, async () => {
      // mismatch 行: 起動前は stale にしておき (already-running で返らせない)、daemon 起動の直後に
      // 生きている daemon の state へ差し替える。覆うのは「後始末の判定の時点で既に生存 state がある」形
      // だけ。判定の後に並走起動した daemon との競合は「並走起動との競合」describe が覆う。
      const r = await plantResidue(row.scope, row.runtime === "mismatch" ? deadPid() : process.pid);
      let aliveState: string | undefined;
      const logs: string[] = [];
      const { rt } = makeRuntime(logs, row.runtime, {
        ...(row.confirm !== undefined ? { confirm: row.confirm } : {}),
        onStarted: () => {
          writeDaemonState(r.statePath, {
            pid: process.pid,
            endpoint: r.deadEndpoint,
            wiredSettingsPaths: [r.settingsPath],
            scope: row.scope,
            startedAt: new Date(1).toISOString(),
          });
          aliveState = readFileSync(r.statePath, "utf8");
        },
      });
      const out = await runStart(
        parseDaemonArgs(["attach", "--scope", row.scope, ...row.argv], cwd),
        {
          wsUrl: WS,
          dbPath: join(cwd, "alive.db"),
          ...(row.hookToken !== undefined ? { hookToken: row.hookToken } : {}),
        },
        rt,
      );
      expect(out.status).toBe(row.status);
      expect(readFileSync(r.settingsPath, "utf8")).toBe(r.settingsBefore);
      expect(actradeckEntries(r.settingsPath).length).toBeGreaterThan(0);
      if (row.runtime === "mismatch") {
        expect(aliveState).toBeDefined();
        expect(readFileSync(r.statePath, "utf8")).toBe(aliveState);
      } else {
        expect(readFileSync(r.statePath, "utf8")).toBe(r.stateBefore);
      }
      const log = logs.join("\n");
      expect(log.length).toBeGreaterThan(0);
      expect(log).not.toContain(DETACHED_MSG);
      expect(log).not.toContain(STOP_HINT);
      aliveExecuted += 1;
    });
  }
});

describe("INV-ATTACH-DENY-CLEANUP: 後始末の境界", () => {
  it("state が当該 scope 以外の settings を含むなら書かない (state から別 file への書込を誘導させない)", async () => {
    const other = join(home, "elsewhere", "settings.json");
    mkdirSync(dirname(other), { recursive: true });
    writeFileSync(other, JSON.stringify({ hooks: {} }));
    const otherBefore = readFileSync(other, "utf8");
    const r = await plantResidue("project-local", deadPid(), [other]);
    const logs: string[] = [];
    const res = cleanupStaleWiring({
      statePath: r.statePath,
      settingsPath: r.settingsPath,
      scope: "project-local",
      cwd,
      writeApproved: true,
      log: (m) => logs.push(m),
    });
    expect(res).toBe("left-needs-confirm");
    expect(readFileSync(r.settingsPath, "utf8")).toBe(r.settingsBefore);
    expect(readFileSync(other, "utf8")).toBe(otherBefore);
    expect(readFileSync(r.statePath, "utf8")).toBe(r.stateBefore);
    expect(logs.join("\n")).toContain(`${STOP_HINT} project-local --cwd ${cwd}`);
    // 対照: 当該 scope だけなら外す。
    const r2 = await plantResidue("project-local", deadPid());
    expect(
      cleanupStaleWiring({
        statePath: r2.statePath,
        settingsPath: r2.settingsPath,
        scope: "project-local",
        cwd,
        writeApproved: true,
        log: (m) => logs.push(m),
      }),
    ).toBe("detached");
    expect(actradeckEntries(r2.settingsPath)).toEqual([]);
  });

  it("detach に失敗したら state を残す (daemon stop で再試行できる)", async () => {
    const r = await plantResidue("project-local", deadPid());
    writeFileSync(r.settingsPath, "{ not json");
    const logs: string[] = [];
    const res = cleanupStaleWiring({
      statePath: r.statePath,
      settingsPath: r.settingsPath,
      scope: "project-local",
      cwd,
      writeApproved: true,
      log: (m) => logs.push(m),
    });
    expect(res).toBe("detach-failed");
    expect(readFileSync(r.statePath, "utf8")).toBe(r.stateBefore);
    expect(logs.join("\n")).toContain(STOP_HINT);
    expect(logs.join("\n")).not.toContain(DETACHED_MSG);
    expect(logs.join("\n")).toContain(expectedHint("project-local"));
  });

  it("detach 失敗時の案内も scope ごとの完全形 (project 系は --cwd 付き・user は無し)", async () => {
    let executed = 0;
    for (const scope of ["project", "user"] as const) {
      const r = await plantResidue(scope, deadPid());
      writeFileSync(r.settingsPath, "{ not json");
      const logs: string[] = [];
      const res = cleanupStaleWiring({
        statePath: r.statePath,
        settingsPath: r.settingsPath,
        scope,
        cwd,
        writeApproved: true,
        log: (m) => logs.push(m),
      });
      expect(res, scope).toBe("detach-failed");
      const log = logs.join("\n");
      expect(log, scope).toContain(expectedHint(scope));
      if (scope === "user") expect(log).not.toContain(CWD_FLAG);
      else expect(log).toContain(CWD_FLAG);
      executed += 1;
    }
    expect(executed).toBe(2);
  });

  it("onlyEndpoint は指定 endpoint の entry だけを外す・daemon stop (runStop) は全 ActraDeck entry を外す", async () => {
    const r = await plantResidue("project-local", deadPid());
    // 別の endpoint (並走起動した daemon) の配線を同じ settings に足す。merge の self-heal は死んだ
    // endpoint を消すので、別 file で作った entry を event ごとに連結する。
    const liveEndpoint = `http://127.0.0.1:${await deadPort()}/hook`;
    const other = join(cwd, "other.json");
    mergeAttachHooks({
      settingsPath: other,
      endpoint: liveEndpoint,
      tokenMode: "literal",
      token: GOOD_TOKEN,
    });
    const a = JSON.parse(readFileSync(r.settingsPath, "utf8")) as {
      hooks: Record<string, unknown[]>;
    };
    const b = JSON.parse(readFileSync(other, "utf8")) as { hooks: Record<string, unknown[]> };
    for (const [ev, groups] of Object.entries(b.hooks))
      a.hooks[ev] = [...(a.hooks[ev] ?? []), ...groups];
    writeFileSync(r.settingsPath, JSON.stringify(a));
    const urlsBefore = actradeckUrls(r.settingsPath);
    const deadCount = urlsBefore.filter((u) => u === r.deadEndpoint).length;
    const liveCount = urlsBefore.filter((u) => u === liveEndpoint).length;
    expect(deadCount).toBeGreaterThan(0);
    expect(liveCount).toBeGreaterThan(0);

    const only = computeDetachedSettings(a as Parameters<typeof computeDetachedSettings>[0], {
      onlyEndpoint: r.deadEndpoint,
    });
    expect(only.removed).toBe(true);
    const onlyJson = JSON.stringify(only.settings);
    expect(onlyJson).toContain(liveEndpoint);
    expect(onlyJson).not.toContain(r.deadEndpoint);
    expect(onlyJson).toContain(USER_HOOK_COMMAND);

    // 拒否経路の後始末 (state.endpoint = 死んだ endpoint) も同じ結果。
    expect(
      cleanupStaleWiring({
        statePath: r.statePath,
        settingsPath: r.settingsPath,
        scope: "project-local",
        cwd,
        writeApproved: true,
        log: () => undefined,
      }),
    ).toBe("detached");
    const after = actradeckUrls(r.settingsPath);
    expect(after.filter((u) => u === liveEndpoint).length).toBe(liveCount);
    expect(after.filter((u) => u === r.deadEndpoint).length).toBe(0);

    // daemon stop は利用者が明示した停止なので endpoint を問わず全部外す (runStop は onlyEndpoint を渡さない)。
    writeFileSync(r.settingsPath, JSON.stringify(a));
    writeDaemonState(r.statePath, {
      pid: deadPid(),
      endpoint: r.deadEndpoint,
      wiredSettingsPaths: [r.settingsPath],
      scope: "project-local",
      startedAt: new Date(0).toISOString(),
    });
    runStop(parseDaemonArgs(["daemon", "stop"], cwd), {
      home,
      log: () => undefined,
      startDaemon: () => Promise.reject(new Error("unused")),
    });
    expect(actradeckUrls(r.settingsPath)).toEqual([]);
    expect(readFileSync(r.settingsPath, "utf8")).toContain(USER_HOOK_COMMAND);
  });

  it("state の削除は判定に使ったバイト列と同じときだけ (CAS)", () => {
    const statePath = join(home, ".actradeck", "daemon", "cas.json");
    const st = {
      pid: 1,
      endpoint: "http://127.0.0.1:1/hook",
      wiredSettingsPaths: [],
      scope: "project-local",
      startedAt: new Date(0).toISOString(),
    };
    writeDaemonState(statePath, st);
    const raw = readFileSync(statePath, "utf8");
    writeDaemonState(statePath, { ...st, startedAt: new Date(1).toISOString() });
    const changed = readFileSync(statePath, "utf8");
    expect(changed).not.toBe(raw);
    expect(removeDaemonStateIfUnchanged(statePath, raw)).toBe(false);
    expect(readFileSync(statePath, "utf8")).toBe(changed);
    expect(removeDaemonStateIfUnchanged(statePath, changed)).toBe(true);
    expect(existsSync(statePath)).toBe(false);
  });

  it("state が無ければ何もしない", () => {
    const settingsPath = resolveSettingsPath("project-local", cwd, home);
    const logs: string[] = [];
    expect(
      cleanupStaleWiring({
        statePath: stateFilePath(settingsPath, home),
        settingsPath,
        scope: "project-local",
        cwd,
        writeApproved: true,
        log: (m) => logs.push(m),
      }),
    ).toBe("no-state");
    expect(logs).toEqual([]);
    expect(existsSync(settingsPath)).toBe(false);
  });

  it("stale な残骸の上で起動が成功すれば、配線は新 endpoint へ上書きされ state は新 pid になる", async () => {
    const r = await plantResidue("project-local", deadPid());
    const logs: string[] = [];
    const { rt, daemons } = makeRuntime(logs, "normal");
    const args = parseDaemonArgs(["attach"], cwd);
    const out = await runStart(args, { wsUrl: WS, dbPath: join(cwd, "ok.db") }, rt);
    try {
      expect(out.status).toBe("started");
      const settings = readFileSync(r.settingsPath, "utf8");
      expect(settings).not.toContain(r.deadEndpoint);
      expect(settings).toContain(out.hookEndpoint as string);
      expect(settings).toContain(USER_HOOK_COMMAND);
      const state = JSON.parse(readFileSync(r.statePath, "utf8")) as {
        pid: number;
        endpoint: string;
      };
      expect(state.pid).toBe(process.pid);
      expect(state.endpoint).toBe(out.hookEndpoint);
      expect(logs.join("\n")).toContain(`stale state を検出 (pid=${r.pid} 死亡)`);
    } finally {
      await daemons[0]?.shutdown();
      runStop(args, rt);
    }
  });

  it("startDaemon が失敗しても stale state は残り、daemon stop が配線を外せる", async () => {
    const r = await plantResidue("project-local", deadPid());
    const rt: DaemonRuntime = {
      home,
      log: () => undefined,
      startDaemon: () => Promise.reject(new Error("bind failed")),
    };
    const args = parseDaemonArgs(["attach"], cwd);
    await expect(runStart(args, { wsUrl: WS, dbPath: join(cwd, "x.db") }, rt)).rejects.toThrow(
      "bind failed",
    );
    expect(readFileSync(r.statePath, "utf8")).toBe(r.stateBefore);
    const stop = runStop(args, rt);
    expect(stop.status).toBe("stopped");
    expect(stop.detached).toBe(true);
    expect(stop.killedPid).toBeUndefined(); // 死んだ pid には何も送れていない
    expect(actradeckEntries(r.settingsPath)).toEqual([]);
    expect(existsSync(r.statePath)).toBe(false);
  });

  it("daemon stop は stale state (pid 死亡) でも配線を外し state を消す", async () => {
    for (const scope of ["project-local", "project", "user"] as const) {
      const r = await plantResidue(scope, deadPid());
      const stop = runStop(parseDaemonArgs(["daemon", "stop", "--scope", scope], cwd), {
        home,
        log: () => undefined,
        startDaemon: () => Promise.reject(new Error("unused")),
      });
      expect(stop.status, scope).toBe("stopped");
      expect(stop.detached, scope).toBe(true);
      expect(actradeckEntries(r.settingsPath), scope).toEqual([]);
      expect(readFileSync(r.settingsPath, "utf8"), scope).toContain(USER_HOOK_COMMAND);
      expect(existsSync(r.statePath), scope).toBe(false);
    }
  });
});

describe("INV-ATTACH-DENY-CLEANUP: 並走起動との競合 — 後始末の判定の後に起動した daemon の配線と state は残す (R1 unblock・QA-DC-1 ≡ TDA-DC-1)", () => {
  let raceExecuted = 0;
  afterAll(() => {
    expect(raceExecuted).toBe(2);
  });

  /**
   * 同じ scope に crash 残骸 (死んだ pid の state + 死んだ port の配線) がある状態で、起動中の daemon A と
   * 拒否される起動 B (env mode・token 未設定) が並走する。A の手順は runStart と同じ primitive を同じ順序
   * (mergeAttachHooks → writeDaemonState) で呼ぶ。`interleave` が B を A の 2 手のどこへ挟むかを決める。
   */
  async function runRace(interleave: "between-merge-and-state" | "inside-b-after-check"): Promise<{
    aEndpoint: string;
    aCount: number;
    aState: string;
    r: Residue;
    logs: string[];
    status: StartOutcome["status"];
  }> {
    const r = await plantResidue("project-local", deadPid());
    const a = new AttachDaemon({ wsUrl: WS, dbPath: join(cwd, "a.db"), host: "127.0.0.1" });
    const { hookEndpoint } = await a.start();
    try {
      let aState = "";
      let aCount = 0;
      const aMerge = (): void => {
        mergeAttachHooks({
          settingsPath: r.settingsPath,
          endpoint: hookEndpoint,
          tokenMode: "literal",
          token: a.hookAuthToken,
        });
        aCount = actradeckUrls(r.settingsPath).filter((u) => u === hookEndpoint).length;
      };
      const aWriteState = (): void => {
        writeDaemonState(r.statePath, {
          pid: process.pid,
          endpoint: hookEndpoint,
          wiredSettingsPaths: [r.settingsPath],
          scope: "project-local",
          startedAt: new Date().toISOString(),
        });
        aState = readFileSync(r.statePath, "utf8");
      };
      if (interleave === "between-merge-and-state") aMerge();
      else {
        // B が stale と判定した直後 (detach と state 削除の前) に A の 2 手が終わる。
        race.fired = 0;
        race.fire = () => {
          aMerge();
          aWriteState();
        };
      }
      const logs: string[] = [];
      const out = await runStart(
        parseDaemonArgs(["attach", "--token-mode", "env"], cwd),
        { wsUrl: WS, dbPath: join(cwd, "b.db") },
        {
          home,
          log: (m) => logs.push(m),
          startDaemon: () => Promise.reject(new Error("B must not start")),
        },
      );
      race.fire = undefined;
      if (interleave === "between-merge-and-state") aWriteState();
      else expect(race.fired).toBe(1);
      return { aEndpoint: hookEndpoint, aCount, aState, r, logs, status: out.status };
    } finally {
      await a.shutdown();
    }
  }

  function assertAIntact(res: Awaited<ReturnType<typeof runRace>>): void {
    expect(res.status).toBe("denied-env-token-missing");
    expect(res.aCount).toBeGreaterThan(0);
    const urls = actradeckUrls(res.r.settingsPath);
    // A の配線は 1 本も欠けず、死んだ endpoint の配線は残っていない。
    expect(urls.filter((u) => u === res.aEndpoint).length).toBe(res.aCount);
    expect(urls.filter((u) => u === res.r.deadEndpoint).length).toBe(0);
    // A の state は A が書いたバイト列のまま (daemon status / stop が A を見つけられる)。
    expect(readFileSync(res.r.statePath, "utf8")).toBe(res.aState);
    expect(
      runStatus(parseDaemonArgs(["daemon", "status"], cwd), {
        home,
        log: () => undefined,
        startDaemon: () => Promise.reject(new Error("unused")),
      }).running,
    ).toBe(true);
  }

  it("R1: B の後始末全体が A.merge と A.writeDaemonState の間に入っても A は残る", async () => {
    const res = await runRace("between-merge-and-state");
    assertAIntact(res);
    // B の後始末は実際に走った (判定時の state = 残骸の state だったので CAS で消し、A が後から書いた)。
    expect(res.logs.join("\n")).toContain(DETACHED_MSG);
    expect(res.logs.join("\n")).not.toContain(STATE_CHANGED_MSG);
    raceExecuted += 1;
  });

  it("R2: B が stale と判定した直後に A が merge + state 書込を終えても A は残る (state は CAS で残す)", async () => {
    const res = await runRace("inside-b-after-check");
    assertAIntact(res);
    const log = res.logs.join("\n");
    expect(log).toContain(STATE_CHANGED_MSG);
    expect(log).not.toContain(DETACHED_MSG);
    raceExecuted += 1;
  });
});

const sidecarRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

describe("INV-ATTACH-SIGHUP-DETACH: 実 attach CLI は SIGHUP で detach + shutdown する (SEC-ENV-4)", () => {
  it("SIGHUP (端末クローズ) で settings から ActraDeck entry が消え state も消える", async () => {
    const settingsPath = resolveSettingsPath("project-local", cwd, home);
    const statePath = stateFilePath(settingsPath, home);
    // 実 CLI (src/cli.ts を tsx で)。新しいプロセスグループで起動し、端末クローズと同じく SIGHUP を
    // グループへ送る。env は最小限 (実 HOME・token・backend へは触れない)。
    const child = spawn(tsxBin, [join(sidecarRoot, "src", "cli.ts"), "attach"], {
      cwd,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: home,
        ACTRADECK_WS_URL: "ws://127.0.0.1:1",
        ACTRADECK_DB: join(cwd, "sighup.db"),
      },
      stdio: ["ignore", "ignore", "pipe"],
      detached: true,
    });
    const pgid = child.pid as number;
    expect(Number.isInteger(pgid) && pgid > 0).toBe(true);
    let stderr = "";
    child.stderr.on("data", (c: Buffer) => (stderr += c.toString()));
    const groupGone = async (timeoutMs: number): Promise<boolean> => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        try {
          process.kill(-pgid, 0);
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === "ESRCH") return true;
        }
        await new Promise((r) => setTimeout(r, 20));
      }
      return false;
    };
    try {
      // 常駐に入るまで待つ (配線と state の書込はその前に終わっている)。
      const deadline = Date.now() + 20_000;
      while (!stderr.includes("常駐中") && Date.now() < deadline) {
        if (await groupGone(0)) break;
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(stderr, stderr).toContain("常駐中");
      // POSITIVE: 起動中は配線と state がある (以降の「消えた」が空の settings で恒真にならない)。
      expect(actradeckEntries(settingsPath).length).toBeGreaterThan(0);
      expect(existsSync(statePath)).toBe(true);

      process.kill(-pgid, "SIGHUP");
      expect(await groupGone(15_000), `process group survived SIGHUP: ${stderr}`).toBe(true);

      expect(stderr).toContain("SIGHUP → detach + shutdown");
      expect(actradeckEntries(settingsPath)).toEqual([]);
      expect(existsSync(statePath)).toBe(false);
    } finally {
      try {
        process.kill(-pgid, "SIGKILL");
      } catch {
        /* 既に終了 */
      }
      // グループの残存 0 を確認する (孤児を残さない)。
      expect(await groupGone(5_000), "process group survived the group kill").toBe(true);
    }
  }, 40_000);
});
