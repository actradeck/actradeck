/**
 * INV-FILELOCK-TESTHOOKS-BOUNDARY (TDA-FL-2 ≡ SEC-FL-7): `withFileLock` の**注入 seam が
 * 本番コードから到達しない**ことを固定する。
 *
 * 根因: `FileLockOptions` の 9 フィールド中 6 個が本番未使用の test seam
 * (`isAlive` / `sleep` / `onLockAcquired` / `acquireDelayMs` / `onLockContended` / `onHolderObserved`) で、
 * `MergeOptions.lockOptions` / `detachAttachHooks(path, lockOptions?)` / `export type { FileLockOptions }`
 * という**本番の公開面**から seam 全体へ到達できた。本番が `isAlive: () => false` や `sleep: () => {}` を
 * 渡すと **CI 信号ゼロで** stale 判定・backoff が無効化される。
 *
 * **実際に効いているコントロールは 2 つ**で、型はそれ自体がゲートではない
 * (ADR 01a057d0: 検出器の自己保護は綴り pin の増殖でなく実行可能コントロールで):
 *   1. **実行可能ゲート (唯一の実行時強制)** — seam を渡せるのは test モードのときだけ。本番モードで
 *      `testHooks` を渡すと `withFileLock` が throw する。挙動 assert は file-lock.test.ts の
 *      「testHooks は test モード限定」describe (POSITIVE / NEGATIVE 対) が持つ。
 *   2. **走査** — `apps/sidecar/src/**` の本番コードに入口 `testHooks` が現れない。
 *      走査器は**既知陽性 / 既知陰性の fixture を同じ関数へ流して**歯を実証する。
 *
 * **型がしているのは「入口を 1 語に絞る」ことだけ** (TDA-FLV2-4)。seam は `FileLockTestHooks` に
 * 集約され `testHooks` からしか渡せないので、走査対象が 1 語で足りる — これは走査の**前提条件**で
 * あって強制ではない。`FileLockCallOptions` は seam へ到達できる型のままであり (だからこそ
 * INV テストが本番経路ごしに seam を注入できる)、型検査だけでは本番の注入を止められない。
 * 下の census は `Record<keyof T, true>` なので seam やオプションの増減で**型エラー**になり、
 * 「入口が 1 語である」という前提が黙って崩れるのを防ぐ (綴りの手写し census ではない)。
 *
 * **走査 universe の正直な開示**: 走査するのは `apps/sidecar/src/**` の `.ts` **のみ**。
 * `.mts` / `.cts` / `.js`、他 workspace、`dist/`、テスト自身は対象外。本番の lock 呼び出しが
 * すべてこの universe に居ることが前提で、universe 外へ本番コードが移れば走査は素通りする。
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { stripComments } from "./util/strip-comments.js";

import type { FileLockCallOptions, FileLockOptions, FileLockTestHooks } from "../src/file-lock.js";

const srcDir = resolve(dirname(fileURLToPath(import.meta.url)), "../src");

/**
 * 型駆動 census: seam を 1 つ足して**ここへ書き忘れると型エラー**になる
 * (`Record<keyof FileLockTestHooks, true>` は全キー必須・余剰キー禁止)。
 */
const TEST_HOOK_CENSUS: Record<keyof FileLockTestHooks, true> = {
  isAlive: true,
  sleep: true,
  acquireDelayMs: true,
  onLockAcquired: true,
  onLockContended: true,
  onHolderObserved: true,
  onDetached: true,
  onReleaseChecked: true,
};

/** 同じく本番向けオプションの census。増減すると型エラーになる。 */
const PRODUCTION_OPTION_CENSUS: Record<keyof FileLockOptions, true> = {
  lockPath: true,
  maxRetries: true,
  retryDelayMs: true,
};

/**
 * `withFileLock` が実際に受け取る型 (本番オプション + seam の入口) の census (TDA-FLV2-1)。
 * 走査が入口 1 語で足りる根拠は「call 型 − 本番型 = ちょうど入口 1 個」であること。
 * 2 個目の入口を生やすと、ここが型エラーか下の assert のどちらかで落ちる。
 */
const CALL_OPTION_CENSUS: Record<keyof FileLockCallOptions, true> = {
  lockPath: true,
  maxRetries: true,
  retryDelayMs: true,
  testHooks: true,
};

/** seam の入口 (本番コードに現れてはならない唯一の語)。 */
const ENTRY_POINT = "testHooks";

/**
 * seam の定義・配線が正当に存在するファイル (走査の免除)。免除は**この 1 件だけ**で、
 * 免除が空振り (= 当該ファイルに実は入口が無い) でないことも下で assert する。
 */
const EXEMPT_FILES = ["file-lock.ts"] as const;

/** 再帰的に `.ts` を列挙する。 */
function listSources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listSources(full));
    else if (entry.name.endsWith(".ts")) out.push(full);
  }
  return out.sort();
}

/**
 * 走査器 (単一出所): コメントを落としたソースに seam の入口が現れる行番号を返す。
 * 既知陽性 / 既知陰性 fixture を**この関数自身に**流して歯を実証する。
 */
function findEntryPointUsages(source: string): number[] {
  const stripped = stripComments(source);
  const re = new RegExp(`\\b${ENTRY_POINT}\\b`);
  return stripped
    .split("\n")
    .map((line, i) => (re.test(line) ? i + 1 : 0))
    .filter((n) => n > 0);
}

describe("INV-FILELOCK-TESTHOOKS-BOUNDARY: 走査器の歯 (既知陽性 / 既知陰性)", () => {
  // 走査器そのものが空振りしていないことを、本番コードではなく **fixture** で実証する
  // (綴り pin ではなく、同じ関数へ流す実行可能コントロール)。
  it("POSITIVE: seam を渡すコードは検出される (呼び出し・オブジェクト・分割代入)", () => {
    const positives = [
      `withFileLock(p, fn, { testHooks: { isAlive: () => false } });`,
      `const o = { maxRetries: 1, testHooks };`,
      `const { testHooks } = opts;`,
      `opts.testHooks?.sleep?.(1);`,
    ];
    for (const src of positives) {
      expect(findEntryPointUsages(src), `not detected: ${src}`).toEqual([1]);
    }
  });

  it("NEGATIVE(対): seam を渡さないコードは検出されない (コメント・部分一致・別語)", () => {
    const negatives = [
      `withFileLock(p, fn, { maxRetries: 3, retryDelayMs: 20 });`,
      `// testHooks は本番で渡さない`,
      `/* testHooks についての説明 */`,
      // QA-FLV2-R2-2 訂正: これは大文字始まり (`TestHooks`) なので、そもそも入口の綴りを
      // 含まない。`\b` の有無とは無関係に非マッチであり、境界軸を検証していない。
      `const myTestHooksLike = 1;`,
      // QA-FLV2-2: **前方は境界・後方は非境界**の形。後ろの `\b` を外すとここが偽陽性になる。
      `const testHooksLike = 1;`,
      // QA-FLV2-R2-2: **前方は非境界・後方は境界**の形 (小文字始まりで入口の綴りを実際に含む)。
      // 前の `\b` を外すとここが偽陽性になる。上の 2 本と合わせて両側の境界軸を挟む。
      `const mytestHooks = 1;`,
      `const hooks = {};`,
    ];
    for (const src of negatives) {
      expect(findEntryPointUsages(src), `false positive: ${src}`).toEqual([]);
    }
  });

  it("走査対象の集合が空でない (src/** の .ts を実際に読んでいる)", () => {
    const files = listSources(srcDir);
    expect(files.length).toBeGreaterThan(10);
    expect(files.some((f) => f.endsWith("file-lock.ts"))).toBe(true);
    expect(files.some((f) => f.endsWith("settings-merge.ts"))).toBe(true);
  });
});

describe("INV-FILELOCK-TESTHOOKS-BOUNDARY: 本番コードは seam を渡さない", () => {
  it("src/** に seam の入口が現れるのは定義ファイルだけ", () => {
    const offenders: string[] = [];
    for (const file of listSources(srcDir)) {
      const base = file.slice(srcDir.length + 1);
      if ((EXEMPT_FILES as readonly string[]).includes(base)) continue;
      const lines = findEntryPointUsages(readFileSync(file, "utf8"));
      if (lines.length > 0) offenders.push(`${base}:${lines.join(",")}`);
    }
    expect(offenders, `production sources passing ${ENTRY_POINT}`).toEqual([]);
  });

  it("免除は空振りでない (定義ファイルには入口が実在する)", () => {
    // 免除リストが「実は存在しない語を免除している」ことで恒真になっていないことの直接証拠。
    for (const base of EXEMPT_FILES) {
      const lines = findEntryPointUsages(readFileSync(join(srcDir, base), "utf8"));
      expect(lines.length, `${base} does not define ${ENTRY_POINT}`).toBeGreaterThan(0);
    }
    expect(EXEMPT_FILES).toEqual(["file-lock.ts"]); // 免除の増殖を loud にする
  });
});

describe("INV-FILELOCK-TESTHOOKS-BOUNDARY: 型による封じ込め", () => {
  it("本番オプションは 3 つだけで、seam と交わらない", () => {
    const prod = Object.keys(PRODUCTION_OPTION_CENSUS).sort();
    const seams = Object.keys(TEST_HOOK_CENSUS).sort();
    expect(prod).toEqual(["lockPath", "maxRetries", "retryDelayMs"]);
    expect(
      prod.filter((k) => seams.includes(k)),
      "production option collides with a seam",
    ).toEqual([]);
    // seam は 1 つ以上ある (census が空になって上の交差検査が恒真化しない)。
    expect(seams.length).toBeGreaterThan(0);
  });

  it("call 型 − 本番型 = ちょうど入口 1 語 (走査が 1 語で足りる根拠)", () => {
    // TDA-FLV2-1: 走査は入口 1 語だけを見る。その正当性は「seam へ到達できる経路が
    // `testHooks` 以外に無い」ことに依存する。2 個目の入口 (別名の seam bag・別 field) を
    // 生やすと、この差分が [ENTRY_POINT] でなくなって落ちる。
    const call = Object.keys(CALL_OPTION_CENSUS).sort();
    const prod = Object.keys(PRODUCTION_OPTION_CENSUS);
    const extra = call.filter((k) => !prod.includes(k));
    expect(extra, "the scan watches one entry point; this must be exactly that key").toEqual([
      ENTRY_POINT,
    ]);
    // 本番型が call 型の部分集合であること (本番キーが call から抜けると走査の前提が崩れる)。
    expect(prod.filter((k) => !call.includes(k))).toEqual([]);
  });
});
