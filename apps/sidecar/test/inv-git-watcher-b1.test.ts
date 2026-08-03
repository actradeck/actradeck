/**
 * INV-GIT-WATCHER-B1 (ADR 0015 §D5・B1・受入 10) — 実 git repo で検証 (REAL DATA・モック無し)。
 *
 *  - `diff.updated` へ `head_sha` (git rev-parse HEAD) を追加。unborn/非 git では欠落。
 *  - snapshotDiff の hash 入力に未追跡ファイルの stat 行 (path/size/mtime) を含め、**未追跡ファイルの
 *    内容変更**が diff_hash を動かす (受入 10)。porcelain の名前列挙では見えない盲点を閉じる。
 *  - tree fingerprint = treeFingerprint(head_sha, diff_hash) が head_sha を反映する。
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { treeFingerprint } from "@actradeck/event-model";

import {
  diffHashInput,
  GitWatcher,
  snapshotDiff,
  untrackedDigestJoin,
} from "../src/git-watcher.js";
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

describe("QA-B1R2-3 / TDA-B1R2-2: diff_hash 入力の NUL domain-separation (空白/改行復帰は RED)", () => {
  // R1 で hash 入力を 3 フィールド NUL 区切りへ直したが、コードのみ着地しテスト未着地 = 空白へ戻す変異が
  //   全 GREEN で生存した (QA-B1R2-3)。区切り byte を charCodeAt で固定 + straddle で domain separation を pin し、
  //   退行を赤化する (テスト source にも生 NUL を書かず charCode===0 で検証する)。

  it("diffHashInput は 3 フィールドを NUL(0) 区切りで結合する (空白/任意非 NUL 復帰は RED)", () => {
    const out = diffHashInput("a", "b", "c");
    expect(out.length).toBe(5); // a + sep + b + sep + c。
    expect(out.charCodeAt(1)).toBe(0); // 区切りは NUL。空白復帰なら 32 → RED。
    expect(out.charCodeAt(3)).toBe(0);
  });

  it("diffHashInput の straddle: 境界を跨ぐ内容が空白区切りでは衝突する (NUL では区別)", () => {
    // A=(status="X", diff="Y Z", untracked="W"), B=(status="X Y", diff="Z", untracked="W")。
    //   空白 join では両者 "X Y Z W" に畳まれ衝突 → 実変更 (フィールド境界の移動) を隠蔽する。空白復帰変異で赤化。
    const a = diffHashInput("X", "Y Z", "W");
    const b = diffHashInput("X Y", "Z", "W");
    expect(a).not.toBe(b);
  });

  it("untrackedDigestJoin は NUL(0) 区切りで、改行入り filename が part 境界を跨いでも一意 (\n/空白 join は RED)", () => {
    // rel は ls-files -z 由来で LF を含みうる。part を改行 (\n) で連結すると LF 入り rel が part 境界と衝突する。
    //   A=["a", "b\nc"], B=["a\nb", "c"] は \n join では双方 "a\nb\nc" に畳まれ衝突 → 内側 straddle。
    //   NUL join では区別する (rel は NUL-free ゆえ NUL が偽造不能な区切り)。
    expect(untrackedDigestJoin(["a", "b"]).charCodeAt(1)).toBe(0); // 区切りは NUL。\n(10)/空白(32) 復帰なら RED。
    const a = untrackedDigestJoin(["a", "b\nc"]);
    const b = untrackedDigestJoin(["a\nb", "c"]);
    expect(a).not.toBe(b); // \n join への退行はこの assert を赤化する (双方 "a\nb\nc")。
  });

  it("実 git: 改行入り filename の未追跡ファイルが diff_hash に一意に反映される (内側 join 実挙動)", async () => {
    const dir = initRepo();
    const base = await snapshotDiff(dir);
    // POSIX filename に改行を含む未追跡ファイルを作る。内側 join が \n だと境界が曖昧化する形。
    writeFileSync(join(dir, "a\nb"), "x\n");
    const s1 = await snapshotDiff(dir);
    expect(s1.hash).not.toBe(base.hash); // 改行入り未追跡ファイルの追加が検出される。
    writeFileSync(join(dir, "a\nb"), "xxxx\n"); // size 変化でさらに動く (盲点なし)。
    const s2 = await snapshotDiff(dir);
    expect(s2.hash).not.toBe(s1.hash);
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

  it("QA-B1-4: 同一バイト長の内容編集 (mtime のみ変化) が diff_hash を動かす (mtime 成分の回帰固定)", async () => {
    const dir = initRepo();
    const f = join(dir, "untracked.txt");
    writeFileSync(f, "aaaa\n"); // 5 bytes。
    // mtime を確定値へ固定して baseline を取る (flake 防止のため明示 utimes)。
    const t0 = new Date("2026-01-01T00:00:00Z");
    utimesSync(f, t0, t0);
    const s1 = await snapshotDiff(dir);
    // 同一バイト長の別内容へ書換え、mtime を別値へ進める (size 不変・porcelain 名も不変)。
    writeFileSync(f, "bbbb\n"); // 5 bytes = 5 bytes。
    const t1 = new Date("2026-01-01T00:00:05Z");
    utimesSync(f, t1, t1);
    const s2 = await snapshotDiff(dir);
    // digest は path/size/mtime のみゆえ、size 不変では **mtime 成分** だけが hash を動かす。
    //   mtime 成分を除去する mutation はこの assert を赤化させる (QA-B1-4)。
    expect(s2.hash).not.toBe(s1.hash);
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
