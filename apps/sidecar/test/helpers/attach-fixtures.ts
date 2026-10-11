/**
 * attach INV テストの共有 fixture (test only・TDA-STA-7 ≡ TDA-TD-3・task 01a10c42 PR-B2 の先頭 commit)。
 *
 * 同じ fixture が inv-attach-{deny-cleanup,deny-cleanup-fs,teardown,teardown-fs,state-trust} に複製されて
 * 分岐していた (死んだ pid の ESRCH 検査の有無・DaemonState リテラル・entry の読取り・`.url` 直読み・
 * 実 attach CLI harness の待ち方)。state の形や entry の形が変わるたびに N か所を直さずに済むよう、
 * ここを単一出所にする。
 *
 * - {@link deadPid}: 実際に終了したプロセスの pid (ESRCH を確かめてから返す)。
 * - {@link daemonStateFor}: runStart が書くのと同じ形の DaemonState (必要な項目だけ上書き)。
 * - {@link actradeckEntries} / {@link actradeckEndpoints}: settings の ActraDeck entry とその endpoint
 *   (取り出しは本番の `endpointOfEntry` 1 本・T-B の command entry も同じ関数で扱える)。
 * - {@link appendEntriesFor}: 本番 merge で別 file に作った entry を event ごとに連結する (self-heal を
 *   避けて複数 endpoint を並べる)。
 * - {@link stubRuntime}: daemon を起動しない DaemonRuntime (startDaemon は reject)。
 * - {@link startAttachCli}: 実 attach CLI (src/cli.ts を tsx で・新しいプロセスグループ)。
 *
 * `node:fs` を包む mock の factory は ./attach-fs-mock.ts (この file は node:fs を import するので、
 * `vi.mock("node:fs")` の factory からは読めない)。
 */
import { spawn, spawnSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { expect } from "vitest";

import type { DaemonRuntime } from "../../src/daemon-cli.js";
import { canonicalSettingsPath, type DaemonState } from "../../src/daemon-state.js";
import { captureSelfIdentity } from "../../src/process-identity.js";
import {
  endpointOfEntry,
  isActradeckEntry,
  mergeAttachHooks,
  type TokenMode,
} from "../../src/settings-merge.js";

import { tsxBin } from "./lock-test-support.js";

/** sidecar package の root (src/cli.ts の位置)。 */
export const sidecarRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/** 実際に終了したプロセスの pid (stale state の pid)。ESRCH を確かめてから返す。 */
export function deadPid(): number {
  const pid = spawnSync(process.execPath, ["-e", ""]).pid;
  expect(Number.isInteger(pid) && pid > 0).toBe(true);
  expect(() => process.kill(pid, 0)).toThrow(/ESRCH/);
  return pid;
}

/**
 * runStart が書くのと同じ形の state。既定は project-local・literal・いまの時刻・自プロセスの同一性
 * (`identity: false` で付けない)。`over` の項目で上書きする。
 */
export function daemonStateFor(
  settingsPath: string,
  over: Partial<DaemonState> & { readonly pid: number; readonly endpoint: string },
  opts: { readonly identity?: boolean } = {},
): DaemonState {
  const identity = opts.identity === false ? undefined : captureSelfIdentity();
  return {
    scope: "project-local",
    settingsPath: canonicalSettingsPath(settingsPath),
    startedAt: new Date().toISOString(),
    tokenMode: "literal",
    ...(identity !== undefined ? { procIdentity: identity } : {}),
    ...over,
  };
}

/** settings の ActraDeck entry (marker と legacy 署名・`isActradeckEntry`)。 */
export function actradeckEntries(settingsPath: string): unknown[] {
  const s = JSON.parse(readFileSync(settingsPath, "utf8")) as {
    hooks?: Record<string, Array<{ hooks?: unknown[] }>>;
  };
  return Object.values(s.hooks ?? {})
    .flat()
    .flatMap((g) => g.hooks ?? [])
    .filter(isActradeckEntry);
}

/** settings の ActraDeck entry が向く endpoint (本番の `endpointOfEntry`・取り出せない entry は undefined)。 */
export function actradeckEndpoints(settingsPath: string): Array<string | undefined> {
  return actradeckEntries(settingsPath).map(endpointOfEntry);
}

/**
 * 本番 merge で別 file に作った `endpoint` の entry を、event ごとに settings へ連結する。merge の self-heal は
 * 記録外の endpoint を消すので、複数 endpoint を並べるにはこの形にする。
 */
export function appendEntriesFor(
  settingsPath: string,
  endpoint: string,
  opts: { readonly tokenMode?: TokenMode; readonly token?: string } = {},
): void {
  const tokenMode = opts.tokenMode ?? "literal";
  const other = join(dirname(settingsPath), `append-${process.pid}-${Date.now()}.json`);
  mergeAttachHooks({
    settingsPath: other,
    endpoint,
    tokenMode,
    ...(tokenMode === "literal"
      ? { token: opts.token ?? "tok-append-0123456789abcdef0123456" }
      : {}),
  });
  const a = JSON.parse(readFileSync(settingsPath, "utf8")) as { hooks?: Record<string, unknown[]> };
  const b = JSON.parse(readFileSync(other, "utf8")) as { hooks: Record<string, unknown[]> };
  const hooks = a.hooks ?? {};
  for (const [ev, groups] of Object.entries(b.hooks)) hooks[ev] = [...(hooks[ev] ?? []), ...groups];
  writeFileSync(settingsPath, JSON.stringify({ ...a, hooks }));
  rmSync(other, { force: true });
}

/** daemon を起動しない runtime (startDaemon は reject)。`extra` で項目を足す / 上書きする。 */
export function stubRuntime(
  home: string,
  logs: string[],
  extra: Partial<DaemonRuntime> = {},
): DaemonRuntime {
  return {
    home,
    log: (m) => logs.push(m),
    startDaemon: () => Promise.reject(new Error("stub runtime: startDaemon is not expected")),
    ...extra,
  };
}

/** 実 attach CLI のプロセスグループ。 */
export interface AttachCli {
  readonly pgid: number;
  stderr(): string;
  /** グループが `ms` 以内に居なくなったか (0 なら 1 回だけ確かめる)。 */
  groupGone(ms: number): Promise<boolean>;
}

/**
 * 実 attach CLI (`src/cli.ts attach ...` を tsx で・新しいプロセスグループ) を起動し、「常駐中」まで待つ
 * (起動に失敗してグループが居なくなったら待たずに抜け、「常駐中」の assert で落ちる)。env は最小限
 * (実 HOME・token・backend へは触れない)。止めるのは呼び出し側 (グループへ signal・{@link killAttachCli})。
 */
export async function startAttachCli(
  args: readonly string[],
  at: {
    readonly cwd: string;
    readonly home: string;
    readonly db: string;
    readonly env?: Record<string, string>;
  },
): Promise<AttachCli> {
  const child = spawn(tsxBin, [join(sidecarRoot, "src", "cli.ts"), "attach", ...args], {
    cwd: at.cwd,
    env: {
      PATH: process.env.PATH ?? "",
      HOME: at.home,
      ACTRADECK_WS_URL: "ws://127.0.0.1:1",
      ACTRADECK_DB: at.db,
      ...at.env,
    },
    stdio: ["ignore", "ignore", "pipe"],
    detached: true,
  });
  const pgid = child.pid as number;
  expect(Number.isInteger(pgid) && pgid > 0).toBe(true);
  let err = "";
  child.stderr.on("data", (c: Buffer) => (err += c.toString()));
  const cli: AttachCli = {
    pgid,
    stderr: () => err,
    async groupGone(ms) {
      const deadline = Date.now() + ms;
      for (;;) {
        try {
          process.kill(-pgid, 0);
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code === "ESRCH") return true;
        }
        if (Date.now() >= deadline) return false;
        await new Promise((r) => setTimeout(r, 20));
      }
    },
  };
  const deadline = Date.now() + 20_000;
  while (!err.includes("常駐中") && Date.now() < deadline) {
    if (await cli.groupGone(0)) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  if (!err.includes("常駐中")) await killAttachCli(cli); // 孤児を残さずに落とす
  expect(err, err).toContain("常駐中");
  return cli;
}

/** グループを SIGKILL し、居なくなったことを確かめる (後始末・既に終了していても良い)。 */
export async function killAttachCli(cli: AttachCli): Promise<void> {
  try {
    process.kill(-cli.pgid, "SIGKILL");
  } catch {
    /* 既に終了 */
  }
  expect(await cli.groupGone(5_000), "attach CLI process group survived the group kill").toBe(true);
}
