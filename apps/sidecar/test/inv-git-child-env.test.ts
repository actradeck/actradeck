/**
 * INV-GIT-CHILD-ENV (SEC-1, H) — git 子プロセスの env leak ガード。
 *
 * sidecar が起動する git 子 (diff-provider / git-watcher) が全 env を継承すると、悪意ある repo の
 * `.gitattributes` textconv や `core.fsmonitor` 経由で **任意コマンドが実行され**、INGEST_TOKEN /
 * ACTRADECK_* を exfil できる (SEC PoC 実証)。git 子は `env: buildChildEnv()` (allowlist) で起動し、
 * これら sidecar 機密が git 子の env に現れないことを REAL git repo で固定する。
 *
 * 攻撃面の再現: `.gitattributes` で textconv を仕込み、`git diff` (textconv 駆動) 時に「自身の env を
 * 捕捉ファイルへ書く」スクリプトを発火させる。捕捉ファイルに sentinel が現れない = leak 遮断。
 *
 * 🔴 REAL DATA: 実 git バイナリ + 実 repo (os.tmpdir 配下)。process.env の sentinel は test 内で
 * 一時設定し afterEach で復元する (実機密は焼かない)。
 */
import { execFileSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { generateRedactedDiff } from "../src/diff-provider.js";
import { snapshotDiff, findRepoRoot } from "../src/git-watcher.js";

const INGEST_SENTINEL = "INGEST-SENTINEL-d34db33f";
const ACTRADECK_SENTINEL = "ACTRADECK-SENTINEL-c0ffee";

describe("INV-GIT-CHILD-ENV: git child env leak guard (SEC-1)", () => {
  let repo: string;
  let capturePath: string;
  const savedEnv = new Map<string, string | undefined>();

  const setEnv = (k: string, v: string): void => {
    if (!savedEnv.has(k)) savedEnv.set(k, process.env[k]);
    process.env[k] = v;
  };

  const gitInRepo = (args: string[]): void => {
    execFileSync("git", args, { cwd: repo, env: { ...process.env } });
  };

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "actradeck-git-leak-"));
    capturePath = join(repo, "captured-env.txt");

    // sidecar 機密を親 env に一時設定 (この値が git 子へ漏れてはならない)。
    setEnv("INGEST_TOKEN", INGEST_SENTINEL);
    setEnv("ACTRADECK_DB", ACTRADECK_SENTINEL);

    // REAL git repo を初期化。
    gitInRepo(["init", "-q"]);
    gitInRepo(["config", "user.email", "test@example.com"]);
    gitInRepo(["config", "user.name", "test"]);

    // 攻撃スクリプト: 自身の env を捕捉ファイルへ追記する。textconv は引数にファイルパスを取り
    // stdout を出す必要があるため env dump 後に cat する。
    const attackScript = join(repo, "exfil.sh");
    writeFileSync(attackScript, `#!/bin/sh\nenv >> "${capturePath}"\ncat "$1"\n`, { mode: 0o755 });
    chmodSync(attackScript, 0o755);

    // textconv を仕込む (.gitattributes + git config)。
    writeFileSync(join(repo, ".gitattributes"), "*.secret diff=exfil\n");
    gitInRepo(["config", "diff.exfil.textconv", attackScript]);

    // textconv 対象ファイルをコミット → 変更して diff 発火条件を作る。
    const target = join(repo, "data.secret");
    writeFileSync(target, "v1\n");
    gitInRepo(["add", "-A"]);
    gitInRepo(["commit", "-q", "-m", "init"]);
    writeFileSync(target, "v2\n"); // working tree 差分 → git diff が textconv を駆動。
  });

  afterEach(() => {
    for (const [k, v] of savedEnv) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    savedEnv.clear();
    rmSync(repo, { recursive: true, force: true });
  });

  it("does not leak INGEST_TOKEN/ACTRADECK_* through diff-provider git child (.gitattributes textconv)", async () => {
    // 注意: diff-provider は `--no-ext-diff` を渡すが textconv は ext-diff ではないため発火しうる。
    // どちらにせよ「捕捉ファイルに sentinel が出ない」ことが leak 遮断の十分条件。
    const result = await generateRedactedDiff(repo);
    expect(typeof result.body).toBe("string");

    const captured = existsSync(capturePath) ? readFileSync(capturePath, "utf8") : "";
    expect(captured).not.toContain(INGEST_SENTINEL);
    expect(captured).not.toContain(ACTRADECK_SENTINEL);
  });

  it("does not leak INGEST_TOKEN/ACTRADECK_* through git-watcher snapshotDiff git child", async () => {
    const snap = await snapshotDiff(repo);
    expect(snap.hash.length).toBeGreaterThan(0);

    const captured = existsSync(capturePath) ? readFileSync(capturePath, "utf8") : "";
    expect(captured).not.toContain(INGEST_SENTINEL);
    expect(captured).not.toContain(ACTRADECK_SENTINEL);
  });

  it("does not leak through git-watcher findRepoRoot git child (config-driven exec面)", async () => {
    const root = await findRepoRoot(repo);
    expect(typeof root === "string" || root === undefined).toBe(true);

    const captured = existsSync(capturePath) ? readFileSync(capturePath, "utf8") : "";
    expect(captured).not.toContain(INGEST_SENTINEL);
    expect(captured).not.toContain(ACTRADECK_SENTINEL);
  });

  it("control: textconv DOES fire and capture file is writable (test harness is valid)", () => {
    // ハーネス自体が攻撃面を再現できることを保証する (false-negative 防止)。
    // ここでは全 env 継承で直接 git を回し、捕捉ファイルに親 env が乗る = 攻撃面が live であることを示す。
    execFileSync("git", ["diff", "--unified=3"], { cwd: repo, env: { ...process.env } });
    const captured = existsSync(capturePath) ? readFileSync(capturePath, "utf8") : "";
    // textconv が発火し env dump が行われた (= 攻撃面は実在する。本番経路はこれを buildChildEnv で塞ぐ)。
    expect(captured).toContain(INGEST_SENTINEL);
  });
});
