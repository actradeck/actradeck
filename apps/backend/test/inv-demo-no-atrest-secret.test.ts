/**
 * INV-DEMO-NO-ATREST-SECRET — セーフティデモの **出荷 2 ファイル** (safety-demo-script.ts /
 * safety-demo-driver.ts) の at-rest バイト列に、連続 secret 形が **一切残っていない**ことを構造的に固定する
 * (decision 019f387f・split-literal 契約)。
 *
 * なぜ必要か: これらは apps/backend/src 配下の出荷ソースで、`e2e/` fixture-path 免除の外にある。image FS
 * scan / OSS mirror leak gate (OSS_SECRET_RE) / GitHub Push Protection がすべて走査するため、dummy secret を
 * 素のリテラルで書くと publish/scan で弾かれる (メモリ github-push-protection-blocks-redaction-fixtures)。
 * split-literal で at-rest 連続形を消しつつ、**実行時に組み立てた値は本物の secret 形ゆえ redactString が
 * redact する** (= redaction fidelity を落とさない) の両立を、両方向で赤に倒せる形で pin する。
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import { redactString } from "@actradeck/redaction";

import {
  DEMO_AWS_ACCESS_KEY_ID,
  DEMO_GITHUB_TOKEN,
  demoSecretCommand,
} from "../src/safety-demo-script.js";

const SRC_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
const SHIPPED_FILES = ["safety-demo-script.ts", "safety-demo-driver.ts"] as const;

/**
 * 連続 secret 形パターン (redactor.ts:329-330 + oss-patterns.sh OSS_SECRET_RE と同値)。
 * 出荷ソースの at-rest バイト列がこれらに **一致してはならない**。
 */
const CONTINUOUS_SECRET_PATTERNS: ReadonlyArray<{ name: string; re: RegExp }> = [
  { name: "aws-access-key-id (redactor)", re: /\b(?:AKIA|ASIA|AROA|AIDA)[0-9A-Z]{16}\b/ },
  { name: "aws-access-key-id (OSS_SECRET_RE)", re: /AKIA[0-9A-Z]{16}/ },
  {
    name: "github-token (redactor)",
    re: /\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{20,255}\b/,
  },
  { name: "github-token (OSS_SECRET_RE)", re: /ghp_[A-Za-z0-9]{36}/ },
];

describe("INV-DEMO-NO-ATREST-SECRET: 出荷ソースに連続 secret 形が残らない", () => {
  for (const file of SHIPPED_FILES) {
    it(`${file} の at-rest バイトに連続 secret 形が 0 件`, () => {
      const text = readFileSync(join(SRC_DIR, file), "utf8");
      for (const { name, re } of CONTINUOUS_SECRET_PATTERNS) {
        expect(
          re.test(text),
          `${file} が ${name} に連続マッチしてはならない (split-literal を維持)`,
        ).toBe(false);
      }
    });
  }
});

describe("INV-DEMO-NO-ATREST-SECRET: 実行時組立値は本物の secret 形で redactString が redact する", () => {
  it("DEMO_AWS_ACCESS_KEY_ID は redactString で [REDACTED:aws-access-key-id] になる", () => {
    // 組立値そのものは AKIA + 16 = 本物の形 (テストプロセス内の値は at-rest でなく in-memory)。
    expect(DEMO_AWS_ACCESS_KEY_ID).toBe("AKIAIOSFODNN7EXAMPLE");
    const redacted = redactString(`key ${DEMO_AWS_ACCESS_KEY_ID} end`);
    expect(redacted).toContain("[REDACTED:aws-access-key-id]");
    expect(redacted).not.toContain(DEMO_AWS_ACCESS_KEY_ID);
  });

  it("DEMO_GITHUB_TOKEN は redactString で [REDACTED:github-token] になる", () => {
    expect(DEMO_GITHUB_TOKEN.startsWith("ghp_")).toBe(true);
    expect(DEMO_GITHUB_TOKEN.length).toBe("ghp_".length + 36);
    const redacted = redactString(`token ${DEMO_GITHUB_TOKEN} end`);
    expect(redacted).toContain("[REDACTED:github-token]");
    expect(redacted).not.toContain(DEMO_GITHUB_TOKEN);
  });

  it("demoSecretCommand() は両 kind を含み redactString で両方 redact される (生 secret 非残留)", () => {
    const cmd = demoSecretCommand();
    expect(cmd).toContain(DEMO_AWS_ACCESS_KEY_ID);
    expect(cmd).toContain(DEMO_GITHUB_TOKEN);
    const redacted = redactString(cmd);
    expect(redacted).toContain("[REDACTED:aws-access-key-id]");
    expect(redacted).toContain("[REDACTED:github-token]");
    expect(redacted).not.toContain(DEMO_AWS_ACCESS_KEY_ID);
    expect(redacted).not.toContain(DEMO_GITHUB_TOKEN);
  });
});
