/**
 * INV-ATTACH-DENY-CLEANUP (fs 注入・SEC-ENV-4 R2): `node:fs` を素通しで包み、ほかの test に影響させずに
 * 2 つを固定する。
 *
 * - QA-DC-R2-3: `checkExistingDaemon` は stale 判定に使う state と、CAS の比較値 (`raw`) を**同じ 1 回の
 *   読み取り**から取る。2 回読むと、その間に書かれた state を判定と比較で取り違える。
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
import { checkExistingDaemon, stateFilePath, writeDaemonState } from "../src/daemon-state.js";
import { mergeAttachHooks } from "../src/settings-merge.js";

/** 注入: 指定 path の readFileSync 回数を数える / 指定 path の rmSync を失敗させる。未設定なら素通し。 */
const fsHook = vi.hoisted(() => ({
  countPath: undefined as string | undefined,
  reads: 0,
  failRmPath: undefined as string | undefined,
}));
vi.mock("node:fs", async (importOriginal) => {
  const orig = await importOriginal<typeof import("node:fs")>();
  const readFileSync = ((...args: Parameters<typeof orig.readFileSync>) => {
    if (fsHook.countPath !== undefined && String(args[0]) === fsHook.countPath) fsHook.reads += 1;
    return orig.readFileSync(...args);
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
  fsHook.countPath = undefined;
  fsHook.failRmPath = undefined;
  fsHook.reads = 0;
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
  const statePath = stateFilePath(settingsPath, home);
  writeDaemonState(statePath, {
    pid: spawnSync(process.execPath, ["-e", ""]).pid,
    endpoint,
    wiredSettingsPaths: [settingsPath],
    scope: "project-local",
    startedAt: new Date(0).toISOString(),
  });
  return { settingsPath, statePath, stateRaw: readFileSync(statePath, "utf8") };
}

describe("INV-ATTACH-DENY-CLEANUP: state の読み取りは 1 回・削除失敗を「消しました」と報告しない (fs 注入)", () => {
  let executed = 0;
  afterAll(() => {
    expect(executed).toBe(2);
  });

  it("checkExistingDaemon は state file を 1 回だけ読み、判定した state と raw は同じ読み取りから来る (QA-DC-R2-3)", () => {
    const { statePath, stateRaw } = plantStale();
    fsHook.countPath = statePath;
    fsHook.reads = 0;
    const existing = checkExistingDaemon(statePath);
    expect(fsHook.reads).toBe(1);
    expect(existing.stale).toBe(true);
    expect(existing.raw).toBe(stateRaw);
    expect(JSON.parse(existing.raw as string)).toEqual(existing.state);
    executed += 1;
  });

  it("state の削除に失敗したら detached-state-rm-failed を返し、「消しました」と言わず停止案内を出す (SEC-DC-R2-2)", () => {
    const { settingsPath, statePath, stateRaw } = plantStale();
    fsHook.failRmPath = statePath;
    const logs: string[] = [];
    const res = cleanupStaleWiring({
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
