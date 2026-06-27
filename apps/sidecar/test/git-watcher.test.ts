/**
 * git diff watcher (plan.md §13) — 実 git repo で検証 (REAL DATA, モック無し)。
 *
 *   fs event → debounce → git diff snapshot → hash 変化時のみ diff.updated 送信。
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { GitWatcher, findRepoRoot, snapshotDiff } from "../src/git-watcher.js";
import { SessionIdentity } from "../src/session-identity.js";
import type { NormalizedEvent } from "@actradeck/event-model";

/** ADR 019e9462: 即確定 identity (explicit モード)。canonical = sessionId で固定。 */
function resolvedIdentity(sessionId: string): SessionIdentity {
  return new SessionIdentity({ fallbackSessionId: sessionId, explicitSessionId: sessionId });
}

function initRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "actradeck-git-"));
  const run = (args: string[]) => execFileSync("git", args, { cwd: dir });
  run(["init", "-q"]);
  run(["config", "user.email", "t@example.com"]);
  run(["config", "user.name", "t"]);
  writeFileSync(join(dir, "a.txt"), "hello\n");
  run(["add", "."]);
  run(["commit", "-q", "-m", "init"]);
  return dir;
}

let watcher: GitWatcher | undefined;
afterEach(async () => {
  await watcher?.stop();
  watcher = undefined;
});

describe("git-watcher (real repo)", () => {
  it("findRepoRoot resolves a git toplevel", async () => {
    const dir = initRepo();
    const root = await findRepoRoot(dir);
    expect(root).toBeTruthy();
  });

  it("snapshotDiff reports changed files + added/removed lines", async () => {
    const dir = initRepo();
    const before = await snapshotDiff(dir);
    expect(before.changedFiles).toBe(0);

    writeFileSync(join(dir, "a.txt"), "hello\nworld\n");
    const after = await snapshotDiff(dir);
    expect(after.changedFiles).toBe(1);
    expect(after.addedLines).toBeGreaterThanOrEqual(1);
    expect(after.hash).not.toBe(before.hash); // hash 変化
  });

  it("captureAndEmit only emits when hash changes (dedup)", async () => {
    const dir = initRepo();
    const events: NormalizedEvent[] = [];
    watcher = new GitWatcher({
      identity: resolvedIdentity("s1"),
      repoRoot: dir,
      onEvent: (e) => events.push(e),
    });

    writeFileSync(join(dir, "a.txt"), "hello\nchange1\n");
    const first = await watcher.captureAndEmit();
    expect(first).toBeDefined();
    expect(events).toHaveLength(1);
    expect(events[0]!.event_type).toBe("diff.updated");
    expect(events[0]!.payload.diff_hash).toBeTruthy();

    // 同一状態で再キャプチャ → hash 不変 → 送らない。
    const second = await watcher.captureAndEmit();
    expect(second).toBeUndefined();
    expect(events).toHaveLength(1);

    // さらに変更 → 新しい diff.updated。
    writeFileSync(join(dir, "a.txt"), "hello\nchange2\n");
    const third = await watcher.captureAndEmit();
    expect(third).toBeDefined();
    expect(events).toHaveLength(2);
  });

  it("start() watches fs events and emits diff.updated after debounce (104-118)", async () => {
    const dir = initRepo();
    const events: NormalizedEvent[] = [];
    watcher = new GitWatcher({
      identity: resolvedIdentity("s1"),
      repoRoot: dir,
      debounceMs: 30,
      onEvent: (e) => events.push(e),
    });
    watcher.start();
    // chokidar の初期スキャンが落ち着くのを待ってから変更を起こす (ignoreInitial)。
    await new Promise((r) => setTimeout(r, 300));
    // 初期スナップショットを確定。
    await watcher.captureAndEmit();
    const baseline = events.length;

    // ファイル変更 → fs event → debounce → captureAndEmit。
    writeFileSync(join(dir, "a.txt"), "hello\nwatched-change\n");
    for (let i = 0; i < 100 && events.length <= baseline; i++) {
      await new Promise((r) => setTimeout(r, 30));
    }
    expect(events.length).toBeGreaterThan(baseline);
    expect(events.at(-1)!.event_type).toBe("diff.updated");
  });

  it("concurrent captureAndEmit is guarded (no double-emit while running)", async () => {
    const dir = initRepo();
    const events: NormalizedEvent[] = [];
    watcher = new GitWatcher({
      identity: resolvedIdentity("s1"),
      repoRoot: dir,
      onEvent: (e) => events.push(e),
    });
    writeFileSync(join(dir, "a.txt"), "hello\nconcurrent\n");
    // 同時に 2 回呼ぶ → running ガードで一方は undefined。
    const [a, b] = await Promise.all([watcher.captureAndEmit(), watcher.captureAndEmit()]);
    const defined = [a, b].filter((x) => x !== undefined);
    expect(defined.length).toBeGreaterThanOrEqual(1);
    expect(events.length).toBeLessThanOrEqual(1);
  });

  it("INV(SEC-4 metrics-only): 作業ツリーの実 secret は diff.updated event に一切現れない (本文非埋込)", async () => {
    const dir = initRepo();
    // 実ファイルに秘匿を書き込む (working tree diff に乗る)。GitWatcher は本文を載せず
    // メトリクスのみを emit する契約 (SEC-4)。raw diff を payload に埋める退行を赤化させる。
    const GH_SECRET = "ghp_REALFAKE0123456789abcdefABCDEF0123456789";
    writeFileSync(join(dir, "a.txt"), `hello\nGITHUB_TOKEN=${GH_SECRET}\n`);
    const events: NormalizedEvent[] = [];
    watcher = new GitWatcher({
      identity: resolvedIdentity("s1"),
      repoRoot: dir,
      onEvent: (e) => events.push(e),
    });
    const snap = await watcher.captureAndEmit();
    expect(snap).toBeDefined();
    expect(events).toHaveLength(1);
    const ev = events[0]!;

    // 本文非埋込: event 全体 (payload 含む) を文字列化しても secret 原文も prefix 断片も出ない。
    const serialized = JSON.stringify(ev);
    expect(serialized, "GitWatcher leaked raw secret into diff.updated").not.toContain(GH_SECRET);
    expect(serialized).not.toContain("ghp_");

    // payload は metrics キーのみ (raw diff/本文フィールドが無い)。本文を足す mutation で赤化する。
    expect(Object.keys(ev.payload).sort()).toEqual([
      "added_lines",
      "changed_files",
      "diff_hash",
      "kind",
      "removed_lines",
    ]);
    // メトリクスは正しく観測されている (変更を見落としていない)。
    expect((ev.payload as { changed_files?: number }).changed_files).toBeGreaterThanOrEqual(1);
  });
});
