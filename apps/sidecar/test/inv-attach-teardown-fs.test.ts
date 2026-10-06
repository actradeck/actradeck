/**
 * INV-ATTACH-TEARDOWN (fs 注入・task 01a10c42 PR-B1): `node:fs` を素通しで包み、ほかの test に影響させずに
 * 2 つを固定する。
 *
 * - V4 (TDA-DC-R3-2 / SEC-DC-R3-2(f)): `daemon stop` は state file の削除に失敗したら「停止しました」と
 *   報告しない (戻り値 `incomplete` + `state: "rm-failed"`・記録が corrupt のときも同じ)。旧 runStop は
 *   握り潰す削除 (removeDaemonState) を使い、失敗しても stopped と `corrupt-removed` を返していた。
 * - V12 (D6): `inspectStaleWiring` は fs を一切呼ばない (純関数)。`node:fs` の全関数呼び出しを数える。
 *
 * temp HOME / temp cwd で動かす (実 ~/.claude・~/.actradeck に触れない)。
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { inspectStaleWiring } from "../src/attach-teardown.js";
import {
  type DaemonRuntime,
  parseDaemonArgs,
  resolveSettingsPath,
  runStop,
} from "../src/daemon-cli.js";
import {
  canonicalSettingsPath,
  compareDaemonState,
  readState,
  scopeArtifacts,
  writeDaemonState,
} from "../src/daemon-state.js";
import { mergeAttachHooks } from "../src/settings-merge.js";

/** 指定 path の rmSync を失敗させる / 数えている間の fs 関数呼び出しを数える。未設定なら素通し。 */
const fsHook = vi.hoisted(() => ({
  failRmPath: undefined as string | undefined,
  failReadPath: undefined as string | undefined,
  counting: false,
  calls: [] as string[],
}));
vi.mock("node:fs", async (importOriginal) => {
  const orig = await importOriginal<typeof import("node:fs")>();
  const wrapped: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(orig)) {
    if (typeof value !== "function" || name === "default") {
      wrapped[name] = value;
      continue;
    }
    const fn = value as (...a: unknown[]) => unknown;
    wrapped[name] = (...args: unknown[]) => {
      if (fsHook.counting) fsHook.calls.push(name);
      if (
        name === "readFileSync" &&
        fsHook.failReadPath !== undefined &&
        String(args[0]) === fsHook.failReadPath
      ) {
        throw Object.assign(new Error("EACCES (injected)"), { code: "EACCES" });
      }
      if (
        name === "rmSync" &&
        fsHook.failRmPath !== undefined &&
        String(args[0]) === fsHook.failRmPath
      ) {
        throw Object.assign(new Error("EACCES (injected)"), { code: "EACCES" });
      }
      return fn(...args);
    };
  }
  return { ...wrapped, default: wrapped };
});

const STOPPED_MSG = "daemon 停止 + detach";
const RM_FAILED_MSG = "を削除できませんでした";
const CORRUPT_REMOVED_MSG = "hook 配線を外し、state を消しました";

let home: string;
let cwd: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "actradeck-teardownfs-home-"));
  cwd = mkdtempSync(join(tmpdir(), "actradeck-teardownfs-cwd-"));
});
afterEach(() => {
  fsHook.failRmPath = undefined;
  fsHook.failReadPath = undefined;
  fsHook.counting = false;
  fsHook.calls = [];
  rmSync(home, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});

function rt(logs: string[]): DaemonRuntime {
  return { home, log: (m) => logs.push(m), startDaemon: () => Promise.reject(new Error("unused")) };
}

/** 死んだ pid の state + その endpoint を向いた配線 (本番 mergeAttachHooks で作る)。 */
function plantStale(): { settingsPath: string; statePath: string } {
  const settingsPath = resolveSettingsPath("project-local", cwd, home);
  mkdirSync(dirname(settingsPath), { recursive: true });
  writeFileSync(settingsPath, "{}");
  const endpoint = "http://127.0.0.1:9/hook";
  mergeAttachHooks({
    settingsPath,
    endpoint,
    tokenMode: "literal",
    token: "tok-teardownfs-0123456789abcdef01234567",
  });
  const statePath = scopeArtifacts(settingsPath, home).statePath;
  writeDaemonState(statePath, {
    pid: spawnSync(process.execPath, ["-e", ""]).pid,
    endpoint,
    scope: "project-local",
    settingsPath: canonicalSettingsPath(settingsPath),
    startedAt: new Date(0).toISOString(),
    tokenMode: "literal",
  });
  return { settingsPath, statePath };
}

describe("INV-ATTACH-TEARDOWN: daemon stop は state の削除に失敗したら停止と報告しない (V4・fs 注入)", () => {
  it("stale state: 削除に失敗したら incomplete / rm-failed・state は残る (対照: 注入なしは stopped)", () => {
    const { statePath } = plantStale();
    const raw = readFileSync(statePath, "utf8");
    fsHook.failRmPath = statePath;
    const logs: string[] = [];
    const stop = runStop(parseDaemonArgs(["daemon", "stop"], cwd), rt(logs));
    expect(stop).toMatchObject({ status: "incomplete", state: "rm-failed", detached: true });
    expect(readFileSync(statePath, "utf8")).toBe(raw);
    expect(logs.join("\n")).toContain(RM_FAILED_MSG);
    expect(logs.join("\n")).not.toContain(STOPPED_MSG);
    // 対照 (POSITIVE): 注入を外した同じ形は stopped で、停止の文言が出る。
    fsHook.failRmPath = undefined;
    plantStale();
    const logs2: string[] = [];
    expect(runStop(parseDaemonArgs(["daemon", "stop"], cwd), rt(logs2))).toMatchObject({
      status: "stopped",
      state: "removed",
    });
    expect(existsSync(statePath)).toBe(false);
    expect(logs2.join("\n")).toContain(STOPPED_MSG);
    expect(logs2.join("\n")).not.toContain(RM_FAILED_MSG);
  });

  it("corrupt state: 削除に失敗したら「state を消しました」と言わない (対照: 注入なしは言う)", () => {
    const { statePath } = plantStale();
    writeFileSync(statePath, "{ not json");
    fsHook.failRmPath = statePath;
    const logs: string[] = [];
    const stop = runStop(parseDaemonArgs(["daemon", "stop"], cwd), rt(logs));
    expect(stop).toMatchObject({
      status: "incomplete",
      kill: "skipped-corrupt",
      corrupt: true,
      state: "rm-failed",
    });
    expect(readFileSync(statePath, "utf8")).toBe("{ not json");
    expect(logs.join("\n")).toContain(RM_FAILED_MSG);
    expect(logs.join("\n")).not.toContain(CORRUPT_REMOVED_MSG);
    fsHook.failRmPath = undefined;
    const logs2: string[] = [];
    expect(runStop(parseDaemonArgs(["daemon", "stop"], cwd), rt(logs2))).toMatchObject({
      status: "stopped",
      corrupt: true,
      state: "removed",
    });
    expect(logs2.join("\n")).toContain(CORRUPT_REMOVED_MSG);
    expect(logs2.join("\n")).not.toContain(RM_FAILED_MSG);
  });
});

describe("INV-ATTACH-TEARDOWN: inspectStaleWiring は fs を呼ばない (V12・fs 注入)", () => {
  it("判定の間の node:fs 呼び出しは 0 回 (対照: 同じ計数で readState は fs を呼ぶ)", () => {
    const { settingsPath } = plantStale();
    const art = scopeArtifacts(settingsPath, home);
    // 対照 (POSITIVE): 計数は生きている (readState は state file を読む)。
    fsHook.counting = true;
    const read = readState(art, ["project-local"]);
    fsHook.counting = false;
    expect(fsHook.calls).toContain("readFileSync");
    expect(read.kind).toBe("state");
    fsHook.calls = [];
    fsHook.counting = true;
    const res = inspectStaleWiring({
      read,
      settings: { hooks: {} },
      isDaemonProcess: () => "dead",
    });
    fsHook.counting = false;
    expect(res.kind).toBe("stale");
    expect(fsHook.calls).toEqual([]);
  });
});

describe("INV-ATTACH-TEARDOWN: 読めない state の CAS 比較 (TDA-TD-2 ≡ QA-TD-2・fs 注入)", () => {
  it("判定でも読めなかった state は「同じ」・判定で読めた値とは「違う」・無ければ absent (daemon stop は読めない state も消す)", () => {
    const { statePath } = plantStale();
    fsHook.failReadPath = statePath;
    expect(compareDaemonState(statePath, undefined)).toBe("same");
    expect(compareDaemonState(statePath, "{}")).toBe("changed");
    // 読めない state は corrupt として扱われ、daemon stop は比較が「同じ」なので消して stopped。
    const logs: string[] = [];
    expect(runStop(parseDaemonArgs(["daemon", "stop"], cwd), rt(logs))).toMatchObject({
      status: "stopped",
      corrupt: true,
      state: "removed",
    });
    expect(existsSync(statePath)).toBe(false);
    fsHook.failReadPath = undefined;
    expect(compareDaemonState(statePath, undefined)).toBe("absent");
  });
});
