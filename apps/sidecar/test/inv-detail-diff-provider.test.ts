/**
 * 段階2 (ADR 019ea4ba D2-B) diff 本文経路の不変条件 — 実 git repo で検証 (REAL DATA, モック無し)。
 *
 * 検証する不変条件 (falsifiable・mutation で赤):
 *  - INV-DETAIL-REDACTION-TRANSPARENCY (diff 側): 実 git の作業ツリーに秘匿 (ghp_/AKIA) を混入し、
 *    generateRedactedDiff の出力に **原文が現れず `[REDACTED:*]` に化けている**。redactDeep(=redactString)
 *    choke を bypass する mutation で赤化する。
 *  - INV-DETAIL-DIFF-SIZE: 1file/全体上限超過で `[DIFF-TRUNCATED:n]` を付し、**切り詰めが redaction の
 *    後**(秘匿が切り詰め断片で漏れない)。redact→truncate の順序を逆転する mutation で赤化する。
 *
 * 注: diff-provider は git CLI を直接呼ぶため、これらは「実 git repo に実ファイルを書く」REAL DATA
 *     検証である (ダミー差分文字列ではなく実差分でも redaction が効くことを示す)。
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  generateRedactedDiff,
  redactAndTruncateDiff,
  MAX_FILE_DIFF,
  MAX_TOTAL_DIFF,
} from "../src/diff-provider.js";

function initRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "actradeck-diff-"));
  const run = (args: string[]) => execFileSync("git", args, { cwd: dir });
  run(["init", "-q"]);
  run(["config", "user.email", "t@example.com"]);
  run(["config", "user.name", "t"]);
  writeFileSync(join(dir, "a.txt"), "hello\n");
  run(["add", "."]);
  run(["commit", "-q", "-m", "init"]);
  return dir;
}

const GH_SECRET = "ghp_" + "A".repeat(36); // GitHub PAT 形 (40 字 base62)。
const AWS_KEY = "AKIA" + "1234567890ABCDEF"; // AWS access key id 形。

describe("INV-DETAIL-REDACTION-TRANSPARENCY (diff path, real git)", () => {
  it("作業ツリーに混入した ghp_/AKIA は diff 応答で [REDACTED:*] に化け、原文は出ない", async () => {
    const dir = initRepo();
    // 実ファイルに秘匿を書き込む (working tree diff に乗る)。
    writeFileSync(
      join(dir, "a.txt"),
      `hello\nGITHUB_TOKEN=${GH_SECRET}\nAWS_ACCESS_KEY_ID=${AWS_KEY}\n`,
    );
    const result = await generateRedactedDiff(dir);

    // 原文の秘匿は **一切** 応答 body に現れない (INV-REDACTION 透過)。
    expect(result.body).not.toContain(GH_SECRET);
    expect(result.body).not.toContain(AWS_KEY);
    // redaction マーカーが現れている (choke を実際に通った証跡)。
    expect(result.body).toContain("[REDACTED:");
    // secret_detected (件数/bool) が立つ。秘匿値そのものは含まれない。
    expect(result.secretDetected).toBe(true);
    expect(result.redactionCount).toBeGreaterThan(0);
    // diff のメタ (ファイル名・+ 行) は温存され、観測価値を壊さない。
    expect(result.body).toContain("a.txt");
  });

  it("秘匿の無い通常の差分は redaction を発火させない (over-redaction しない)", async () => {
    const dir = initRepo();
    writeFileSync(join(dir, "a.txt"), "hello\nworld\nplain text change\n");
    const result = await generateRedactedDiff(dir);
    expect(result.body).toContain("world");
    expect(result.secretDetected).toBe(false);
    expect(result.redactionCount).toBe(0);
  });

  it("git 管理外 (空 repoRoot) は空 body で安全に返す (raw を出さない)", async () => {
    const result = await generateRedactedDiff("");
    expect(result.body).toBe("");
    expect(result.secretDetected).toBe(false);
  });
});

describe("INV-DETAIL-DIFF-SIZE (truncation-after-redaction)", () => {
  it("1file 上限超過で [DIFF-TRUNCATED:n] を付す", () => {
    // 単一ファイル chunk が MAX_FILE_DIFF を超える長さ。
    const big = "diff --git a/x b/x\n" + "+".repeat(MAX_FILE_DIFF + 5000);
    const r = redactAndTruncateDiff(big);
    expect(r.truncated).toBe(true);
    expect(r.body).toContain("[DIFF-TRUNCATED:");
  });

  it("全体上限超過で [DIFF-TRUNCATED:n] を付す (複数ファイルの合算)", () => {
    // 各 chunk は MAX_FILE_DIFF 未満だが合算で MAX_TOTAL_DIFF を超える。
    const chunkBody = "a".repeat(MAX_FILE_DIFF - 100);
    const chunks: string[] = [];
    let total = 0;
    let i = 0;
    while (total <= MAX_TOTAL_DIFF) {
      chunks.push(`diff --git a/f${i} b/f${i}\n${chunkBody}`);
      total += chunkBody.length;
      i++;
    }
    const r = redactAndTruncateDiff(chunks.join("\n"));
    expect(r.truncated).toBe(true);
    expect(r.body.endsWith("]")).toBe(true);
    expect(r.body).toContain("[DIFF-TRUNCATED:");
  });

  it("切り詰めは redaction の後: 上限境界を跨ぐ secret が断片で漏れない", () => {
    // secret が **MAX_FILE_DIFF 境界をちょうど跨ぐ** ように配置する。
    //   redact→truncate (正): secret 全体がまず [REDACTED:*] へ化け、その後 cut されるので
    //     原文断片は一切残らない。
    //   truncate→redact (mutation): 境界で secret が前半 (`ghp_AAA…`) だけ残る形で切られ、
    //     断片は最小長ルール (ghp_ は 20 字以上) を下回りマストされず **生 prefix が漏れる**
    //     → 下の not.toContain("ghp_") が赤になる。
    const header = "diff --git a/s b/s\n";
    // secret の直前に語境界 (空白) を置き、github-token ルール (\b ghp_…) が確実に発火する形にする。
    // 空白 + GH_SECRET (40 字) の中央 (空白 +20 字) が MAX_FILE_DIFF 境界に来るよう filler 長を調整。
    const fillerLen = MAX_FILE_DIFF - header.length - 21;
    const raw = `${header}${"x".repeat(fillerLen)} ${GH_SECRET} tail-marker`;
    const r = redactAndTruncateDiff(raw);
    // 原文 secret 全体は当然残らない。
    expect(r.body).not.toContain(GH_SECRET);
    // 生 `ghp_` prefix 断片も残らない (truncate-before-redact だと境界手前の頭が漏れうる)。
    expect(r.body).not.toContain("ghp_");
  });

  it("通常サイズの diff は truncated=false (切り詰めない)", () => {
    const r = redactAndTruncateDiff("diff --git a/a b/a\n+small change\n");
    expect(r.truncated).toBe(false);
    expect(r.body).toContain("small change");
  });
});
