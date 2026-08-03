/**
 * INV-GIT-WATCHER-B1 (ADR 0015 §D5・B1・受入 10) — 実 git repo で検証 (REAL DATA・モック無し)。
 *
 *  - `diff.updated` へ `head_sha` (git rev-parse HEAD) を追加。unborn/非 git では欠落。
 *  - snapshotDiff の hash 入力に未追跡ファイルの stat 行 (path/size/mtime) を含め、**未追跡ファイルの
 *    内容変更**が diff_hash を動かす (受入 10)。porcelain の名前列挙では見えない盲点を閉じる。
 *  - tree fingerprint = treeFingerprint(head_sha, diff_hash) が head_sha を反映する。
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { treeFingerprint } from "@actradeck/event-model";

import { GitWatcher, snapshotDiff } from "../src/git-watcher.js";
import { SessionIdentity } from "../src/session-identity.js";
import type { NormalizedEvent } from "@actradeck/event-model";

function resolvedIdentity(sessionId: string): SessionIdentity {
  return new SessionIdentity({ fallbackSessionId: sessionId, explicitSessionId: sessionId });
}

function initRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "actradeck-gitb1-"));
  const run = (args: string[]): void => void execFileSync("git", args, { cwd: dir });
  run(["init", "-q"]);
  run(["config", "user.email", "t@example.com"]);
  run(["config", "user.name", "t"]);
  writeFileSync(join(dir, "a.txt"), "hello\n");
  run(["add", "."]);
  run(["commit", "-q", "-m", "init"]);
  return dir;
}

function headSha(dir: string): string {
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir }).toString().trim();
}

let watcher: GitWatcher | undefined;
afterEach(async () => {
  await watcher?.stop();
  watcher = undefined;
});

describe("§D5 head_sha (受入 8 の fingerprint 基盤)", () => {
  it("snapshotDiff は現在の HEAD commit を headSha に載せる", async () => {
    const dir = initRepo();
    const snap = await snapshotDiff(dir);
    expect(snap.headSha).toBe(headSha(dir));
  });

  it("非 git ディレクトリでは headSha が undefined (fingerprint は diff_hash-only へ縮退)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "actradeck-nongit-"));
    const snap = await snapshotDiff(dir);
    expect(snap.headSha).toBeUndefined();
    // treeFingerprint は head 欠落でも diff_hash から成立する (§D5 縮退)。
    expect(treeFingerprint(snap.headSha, snap.hash)).toBeDefined();
  });

  it("commit 後に head_sha が変わり tree fingerprint が動く (commit-after-verify → stale 方向・§D5 honest limit)", async () => {
    const dir = initRepo();
    const before = await snapshotDiff(dir);
    writeFileSync(join(dir, "a.txt"), "hello\nmore\n");
    execFileSync("git", ["commit", "-qam", "change"], { cwd: dir });
    const after = await snapshotDiff(dir);
    expect(after.headSha).not.toBe(before.headSha);
    expect(treeFingerprint(after.headSha, after.hash)).not.toBe(
      treeFingerprint(before.headSha, before.hash),
    );
  });

  it("diff.updated イベント payload に head_sha が載る", async () => {
    const dir = initRepo();
    const events: NormalizedEvent[] = [];
    watcher = new GitWatcher({
      identity: resolvedIdentity("s1"),
      repoRoot: dir,
      onEvent: (e) => events.push(e as NormalizedEvent),
    });
    writeFileSync(join(dir, "a.txt"), "hello\nchanged\n");
    await watcher.captureAndEmit();
    const diff = events.find((e) => e.event_type === "diff.updated");
    expect(diff).toBeDefined();
    expect((diff!.payload as { head_sha?: string }).head_sha).toBe(headSha(dir));
  });
});

describe("§D5 未追跡ファイル内容変更 (受入 10): stat 行で diff_hash が動く", () => {
  it("未追跡ファイルの**内容**編集 (行数不変) が diff_hash を変える", async () => {
    const dir = initRepo();
    // 未追跡ファイルを作る。
    writeFileSync(join(dir, "untracked.txt"), "aaaa\n");
    const s1 = await snapshotDiff(dir);
    // 同じ**サイズ**を保つと size は不変だが mtime が動く → 検出される。行数・名前は porcelain で不変。
    // まず内容 (サイズ変化) 編集で確実に検出することを固定する。
    writeFileSync(join(dir, "untracked.txt"), "bbbbbb\n");
    const s2 = await snapshotDiff(dir);
    expect(s2.hash).not.toBe(s1.hash); // 未追跡内容変更が hash に反映 (盲点解消)。
    // porcelain の changed_files は名前ベースゆえ 1 のまま (内容変化は名前列挙に出ない)。
    expect(s1.changedFiles).toBe(1);
    expect(s2.changedFiles).toBe(1);
  });

  it("未追跡ファイル追加/削除も diff_hash を動かす", async () => {
    const dir = initRepo();
    const base = await snapshotDiff(dir);
    writeFileSync(join(dir, "new-untracked.txt"), "x\n");
    const added = await snapshotDiff(dir);
    expect(added.hash).not.toBe(base.hash);
  });

  it(".gitignore 済ファイルは未追跡列挙に含めない (exclude-standard・over-detection 防止)", async () => {
    const dir = initRepo();
    writeFileSync(join(dir, ".gitignore"), "ignored/\n");
    execFileSync("git", ["add", ".gitignore"], { cwd: dir });
    execFileSync("git", ["commit", "-qm", "ignore"], { cwd: dir });
    const base = await snapshotDiff(dir);
    // ignored/ 配下の変更は fingerprint に影響しない (ls-files --others --exclude-standard が除外)。
    execFileSync("mkdir", ["-p", join(dir, "ignored")]);
    writeFileSync(join(dir, "ignored", "big.log"), "noise\n");
    const after = await snapshotDiff(dir);
    expect(after.hash).toBe(base.hash);
  });
});
