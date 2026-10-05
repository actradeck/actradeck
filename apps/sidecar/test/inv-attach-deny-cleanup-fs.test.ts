/**
 * INV-ATTACH-DENY-CLEANUP (fs 注入・SEC-ENV-4 R2): `node:fs` を素通しで包み、ほかの test に影響させずに
 * 2 つを固定する。
 *
 * - QA-DC-R2-3 / TDA-DC-R3-5: state の唯一の reader `readState` は、判定に使う state と CAS の比較値
 *   (`raw`) を**同じ 1 回の読み取り**から取る。2 回読むと、その間に書かれた state を判定と比較で取り違える。
 *   読取り回数ではなく、1 回目の読み取りの直後に state file を書き換える注入で挙動として固定する (読む API
 *   を変えても、2 回目の読み取りは書き換え後の中身を返すので RED になる)。
 * - SEC-DC-R2-2: state の削除に失敗したら、後始末は「消しました」と報告しない (戻り値も区別する)。
 *
 * temp HOME / temp cwd で動かす (実 ~/.claude・~/.actradeck に触れない)。
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { cleanupStaleWiring, resolveSettingsPath } from "../src/daemon-cli.js";
import { canonicalPath, readState, scopeArtifacts, writeDaemonState } from "../src/daemon-state.js";
import { mergeAttachHooks } from "../src/settings-merge.js";

/**
 * 注入: 指定 path を readFileSync で 1 回読んだ直後に、その file を `rewriteTo` の中身へ書き換える (1 回だけ) /
 * 指定 path の rmSync を失敗させる。未設定なら素通し。
 */
const fsHook = vi.hoisted(() => ({
  rewritePath: undefined as string | undefined,
  rewriteTo: "",
  rewrites: 0,
  failRmPath: undefined as string | undefined,
}));
vi.mock("node:fs", async (importOriginal) => {
  const orig = await importOriginal<typeof import("node:fs")>();
  const readFileSync = ((...args: Parameters<typeof orig.readFileSync>) => {
    const out = orig.readFileSync(...args);
    if (fsHook.rewritePath !== undefined && String(args[0]) === fsHook.rewritePath) {
      fsHook.rewritePath = undefined;
      fsHook.rewrites += 1;
      orig.writeFileSync(String(args[0]), fsHook.rewriteTo);
    }
    return out;
  }) as typeof orig.readFileSync;
  const rmSync = ((...args: Parameters<typeof orig.rmSync>) => {
    if (fsHook.failRmPath !== undefined && String(args[0]) === fsHook.failRmPath) {
      throw Object.assign(new Error("EACCES (injected)"), { code: "EACCES" });
    }
    return orig.rmSync(...args);
  }) as typeof orig.rmSync;
  return { ...orig, default: { ...orig, readFileSync, rmSync }, readFileSync, rmSync };
});

const DETACHED_MSG = "stale state を消しました";
const RM_FAILED_MSG = "stale state は削除できませんでした";
const STOP_HINT = "agentmon daemon stop --scope";

let home: string;
let cwd: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "actradeck-denyfs-home-"));
  cwd = mkdtempSync(join(tmpdir(), "actradeck-denyfs-cwd-"));
});
afterEach(() => {
  fsHook.rewritePath = undefined;
  fsHook.failRmPath = undefined;
  fsHook.rewrites = 0;
  rmSync(home, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});

/** 死んだ pid の state + その state の endpoint を向いた配線 (本番 mergeAttachHooks で作る)。 */
function plantStale(): { settingsPath: string; statePath: string; stateRaw: string } {
  const settingsPath = resolveSettingsPath("project-local", cwd, home);
  mkdirSync(dirname(settingsPath), { recursive: true });
  writeFileSync(settingsPath, "{}");
  const endpoint = "http://127.0.0.1:9/hook";
  mergeAttachHooks({
    settingsPath,
    endpoint,
    tokenMode: "literal",
    token: "tok-denyfs-0123456789abcdef0123456789",
  });
  const statePath = scopeArtifacts(settingsPath, home).statePath;
  writeDaemonState(statePath, {
    pid: spawnSync(process.execPath, ["-e", ""]).pid,
    endpoint,
    scope: "project-local",
    settingsPath: canonicalPath(settingsPath),
    startedAt: new Date(0).toISOString(),
    tokenMode: "literal",
  });
  return { settingsPath, statePath, stateRaw: readFileSync(statePath, "utf8") };
}

describe("INV-ATTACH-DENY-CLEANUP: state の読み取りは 1 回・削除失敗を「消しました」と報告しない (fs 注入)", () => {
  let executed = 0;
  afterAll(() => {
    expect(executed).toBe(3);
  });

  it("readState が判定した state と raw は同じ 1 回の読み取りから来る (読み取りの直後の書き換えを拾わない・QA-DC-R2-3 / TDA-DC-R3-5)", () => {
    const { settingsPath, statePath, stateRaw } = plantStale();
    const art = scopeArtifacts(settingsPath, home);
    // 書き換え後の中身は、同じ形で pid と endpoint だけが違う state (2 回目に読めば別の値になる)。
    const rewritten = stateRaw.replace(/"pid": \d+/, '"pid": 1').replace(":9/hook", ":1/hook");
    expect(rewritten).not.toBe(stateRaw);
    fsHook.rewriteTo = rewritten;
    fsHook.rewritePath = statePath;
    const read = readState(art, ["project-local"]);
    expect(fsHook.rewrites).toBe(1);
    expect(readFileSync(statePath, "utf8")).toBe(rewritten);
    expect(read.kind).toBe("state");
    if (read.kind !== "state") throw new Error("unreachable");
    expect(read.raw).toBe(stateRaw);
    expect(read.state.endpoint).toBe("http://127.0.0.1:9/hook");
    expect(read.state.pid).toBe((JSON.parse(stateRaw) as { pid: number }).pid);
    // 対照 (POSITIVE): 注入が無ければ同じ reader は書き換え後の中身をそのまま読む。
    const again = readState(art, ["project-local"]);
    expect(again.kind === "state" ? again.raw : undefined).toBe(rewritten);
    expect(again.kind === "state" ? again.state.endpoint : undefined).toBe(
      "http://127.0.0.1:1/hook",
    );
    executed += 1;
  });

  it("後始末は判定に使った読み取りのバイト列で CAS する (読み取りの直後に state が書き換わったら消さない)", () => {
    const { settingsPath, statePath, stateRaw } = plantStale();
    const rewritten = stateRaw.replace(/"pid": \d+/, '"pid": 1');
    fsHook.rewriteTo = rewritten;
    fsHook.rewritePath = statePath;
    const logs: string[] = [];
    const res = cleanupStaleWiring({
      home,
      statePath,
      settingsPath,
      scope: "project-local",
      cwd,
      writeApproved: true,
      log: (m) => logs.push(m),
    });
    expect(fsHook.rewrites).toBe(1);
    expect(res).toBe("detached-state-changed");
    expect(readFileSync(statePath, "utf8")).toBe(rewritten);
    expect(logs.join("\n")).not.toContain(DETACHED_MSG);
    executed += 1;
  });

  it("state の削除に失敗したら detached-state-rm-failed を返し、「消しました」と言わず停止案内を出す (SEC-DC-R2-2)", () => {
    const { settingsPath, statePath, stateRaw } = plantStale();
    fsHook.failRmPath = statePath;
    const logs: string[] = [];
    const res = cleanupStaleWiring({
      home,
      statePath,
      settingsPath,
      scope: "project-local",
      cwd,
      writeApproved: true,
      log: (m) => logs.push(m),
    });
    expect(res).toBe("detached-state-rm-failed");
    expect(readFileSync(statePath, "utf8")).toBe(stateRaw);
    const log = logs.join("\n");
    expect(log).toContain(RM_FAILED_MSG);
    expect(log).toContain(`${STOP_HINT} project-local --cwd ${cwd}`);
    expect(log).not.toContain(DETACHED_MSG);
    // 対照: 注入を外すと同じ形で detached になり「消しました」と出る (同一リテラルの POSITIVE)。
    fsHook.failRmPath = undefined;
    const logs2: string[] = [];
    const { settingsPath: s2, statePath: p2 } = plantStale();
    expect(
      cleanupStaleWiring({
        home,
        statePath: p2,
        settingsPath: s2,
        scope: "project-local",
        cwd,
        writeApproved: true,
        log: (m) => logs2.push(m),
      }),
    ).toBe("detached");
    expect(logs2.join("\n")).toContain(DETACHED_MSG);
    expect(logs2.join("\n")).not.toContain(RM_FAILED_MSG);
    executed += 1;
  });
});
