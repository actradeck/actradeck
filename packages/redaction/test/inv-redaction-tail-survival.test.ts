/**
 * INV-REDACTION-TAIL-SURVIVAL (P1 hardening・task 019f5b5e-f9e9 / 裁定 019f5b86 CONDITIONAL unblock 1):
 *   value を「マスクする」系ルールの **値捕捉が有界 (MAX_VALUE_LEN)** だと、値が上限を超えたとき
 *   bounded capture を超えた **tail が raw 残存** する (fragment-survival)。あるいは閉じ区切り
 *   (`"` / `'` / `@`) を上限内に見つけられず **match 全体が失敗して full leak** になる。修正は各値捕捉を
 *   単一 charset の**無界**量指定子 (`{1,}` / `{0,}` / `{40,}`) へ緩めた (ReDoS-safe: nested/alternation
 *   なし = 線形)。≤MAX_VALUE_LEN の既存挙動はバイト等価。
 *
 * ## per-rule 個別反証 (SEC-2 ≡ QA-1・mutation 実証で判明した falsifiability gap):
 *   初版の反証ベクタは全て **3 char-class** (upper+lower+digit) で構成していたため、どの値も
 *   high-entropy `{40,}` backstop が丸ごとマスクしてしまい、**10+ capture 中 high-entropy 1 箇所だけ**が
 *   RED→GREEN を駆動していた (他 capture を個別 revert してもテストは緑=反証になっていなかった)。
 *   本版は **high-entropy backstop が発火しない値**で各 capture を個別に pin する:
 *     - 2 char-class 値 (lowercase+digit のみ) → high-entropy stage-2 (distinct class >= 3) が不発。
 *       ⇒ 当該 capture を bound へ revert すると tail/full が **他ルールに拾われず** raw 残存 = RED。
 *     - npm-auth-token は `_authToken` が cred キーワード (auth/token) を含み credential-assignment
 *       bare に二重被覆される。**comma isolator** で分離する: npm 値 `[^\s"']` は `,` を含むが cred-bare
 *       値 `[^\s"',;]` は `,` で停止するため、npm を revert すると post-comma tail が cred の mop-up を
 *       逃れて残存する。
 *     - url-credential は **long user** (>MAX_VALUE_LEN) で user capture を pin する: user を bound へ
 *       revert すると `:`/`@` 区切りが上限外に落ち rule 全体が match せず pass が非マスクで leak する。
 *   各 capture の「その rule 単独を bound へ revert すると RED」は PR report の per-rule revert 実測ログ
 *   (10/10 個別 pin) が falsifiability を保証する。redactor.ts は revert 後 byte 一致へ復元済 (git diff empty)。
 */
import { describe, expect, it } from "vitest";

import { MAX_VALUE_LEN, redactString, redactDeep } from "@actradeck/redaction";

// FRAGMENT_MIN_LEN: apps/sidecar/e2e/safety-bench/bench.ts と同一の 8 字床 (partial disclosure の下限)。
const FRAGMENT_MIN_LEN = 8;

// 値は MAX_VALUE_LEN を「大きく」超える長さ (bench の 9000 字と同オーダー・定数から導出)。
const TAIL_VALUE_LEN = MAX_VALUE_LEN + 5000; // 9096
// url-credential の user pin 用: user が MAX_VALUE_LEN を超えると bound revert 時に rule が match しない。
const LONG_USER_LEN = MAX_VALUE_LEN + 904; // 5000

// --- 決定的 dummy 値生成 (合成・実鍵ではない) --------------------------------------------------
// NOTE (documented duplication): genChars / longestSurvivingRun は redactor.test.ts と同型の
//   test-only helper。cross-file の相対 test import は脆く smell ゆえ **意図的複製** (redactor.test.ts
//   の「ReDoS scaling 共通基盤」/「straddle 系共通ヘルパ」と同じ documented duplication 方針)。
// gen2 = **2 char-class** (lowercase+digit)。high-entropy stage-2 (distinct class >= 3) を満たさないため
//   backstop が発火せず、個別 capture の revert 反証が本物になる。非周期ゆえ gram が distinct で
//   longestSurvivingRun は正確。looksLikePath (`://` / path-body / `.<ext>`) も踏まない (記号なし)。
const LOWER_DIGIT = "abcdefghijklmnopqrstuvwxyz0123456789";
const gen2 = (n: number, salt = 0): string => {
  let out = "";
  for (let i = 0; i < n; i++) out += LOWER_DIGIT[((i + salt) * 2654435761) % LOWER_DIGIT.length]!;
  return out;
};
// gen3 = **3 char-class** (upper+lower+digit)。high-entropy 標準ルール自体を pin する用。
const ALNUM3 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const gen3 = (n: number): string => {
  let out = "";
  for (let i = 0; i < n; i++) out += ALNUM3[(i * 2654435761) % ALNUM3.length]!;
  return out;
};

// redacted に残存する body の最長 raw run 長 (≥minLen)。redactor.test.ts と同じ線形実装。
const longestSurvivingRun = (redacted: string, body: string, minLen = FRAGMENT_MIN_LEN): number => {
  if (body.length < minLen) return 0;
  const grams = new Set<string>();
  for (let j = 0; j + minLen <= redacted.length; j++) grams.add(redacted.slice(j, j + minLen));
  let longest = 0;
  let i = 0;
  while (i + minLen <= body.length) {
    if (!grams.has(body.slice(i, i + minLen))) {
      i++;
      continue;
    }
    let end = i + minLen;
    while (end < body.length && grams.has(body.slice(end - minLen + 1, end + 1))) end++;
    if (end - i > longest) longest = end - i;
    i = end - minLen + 1;
  }
  return longest;
};

/** `secret` の ≥8 字連続断片が `out` に生存しないことを反証する。 */
function assertNoSurvival(label: string, out: string, secret: string): void {
  const run = longestSurvivingRun(out, secret);
  expect(
    run,
    `${label}: ${run} 字の raw secret 断片が生存 (>=${FRAGMENT_MIN_LEN} は leak)・out tail: ${JSON.stringify(
      out.slice(-48),
    )}`,
  ).toBeLessThan(FRAGMENT_MIN_LEN);
  expect(out, `${label}: マスクマーカー無し (value 全体が素通り)`).toContain("[REDACTED:");
}

describe("INV-REDACTION-TAIL-SURVIVAL: per-capture 個別反証 (backstop-free 値)", () => {
  const V = gen2(TAIL_VALUE_LEN); // 2-class・high-entropy backstop 非発火
  const longUser = "a".repeat(LONG_USER_LEN); // 1-class benign・pass と非衝突
  const pass = gen2(20, 7); // distinct short pass (salt でシーケンスを user と分離)

  // (1) credential-assignment bare: value `[^\s"',;]{1,}`。revert {1,4096} → tail 5000 が 2-class ゆえ
  //     high-entropy 非発火で raw 残存。
  it("credential-assignment (bare) capture を pin する", () => {
    assertNoSurvival("cred-bare", redactString(`password=${V}`), V);
  });

  // (2) credential-assignment double-quote: value `[^"\r\n]{0,}`。revert {0,4096} → 閉じ quote が上限外で
  //     rule 全体失敗 → 2-class ゆえ backstop 無しで full leak。
  it("credential-assignment (double-quote) capture を pin する", () => {
    assertNoSurvival("cred-dquote", redactString(`password="${V}"`), V);
  });

  // (3) credential-assignment single-quote: value `[^'\r\n]{0,}`。同上。
  it("credential-assignment (single-quote) capture を pin する", () => {
    assertNoSurvival("cred-squote", redactString(`client_secret='${V}'`), V);
  });

  // (4) auth-header-scheme: value `[^\r\n]{1,}`。revert → tail 残存 (cred は scheme 語 `ApiKey` までしか
  //     マスクせず tail は 2-class ゆえ backstop 無し)。
  it("auth-header-scheme capture を pin する", () => {
    assertNoSurvival("auth-header-scheme", redactString(`Authorization: ApiKey ${V}`), V);
  });

  // (5) auth-scheme-value (行頭 scheme・object 値経路): value `[^\r\n]{1,}`。`Authorization:` prefix 無し
  //     ゆえ auth-header-scheme は非該当・`[:=]` 無しゆえ cred も非該当 → 本 rule 単独。
  it("auth-scheme-value capture を pin する", () => {
    assertNoSurvival("auth-scheme-value", redactString(`ApiKey ${V}`), V);
  });

  // (6) AUTH_HEADER_VALUE_RE (object 経路の redactAuthHeaderValue): value `[^\r\n]{1,}$`。object key が
  //     auth ヘッダ・scheme 語は **auth-scheme-value 既知集合外の `CustomScheme`** にして、revert 時に
  //     redactString fallback でも他 rule に拾われないよう分離する。
  it("AUTH_HEADER_VALUE_RE (object auth ヘッダ値) capture を pin する", () => {
    const out = JSON.stringify(redactDeep({ Authorization: `CustomScheme ${V}` }));
    assertNoSurvival("auth-header-value-obj", out, V);
  });

  // (7) npm-auth-token: value `[^\s"']{6,}`。comma isolator: npm 値は `,` を含むが cred-bare 値
  //     `[^\s"',;]` は `,` で停止。nA>MAX_VALUE_LEN で comma を bounded npm mask の外へ置き、revert 時に
  //     post-comma nB が cred の mop-up を逃れて残存する。nB は 2-class ゆえ backstop 無し。
  it("npm-auth-token capture を pin する (comma isolator)", () => {
    const nA = gen2(MAX_VALUE_LEN + 200); // 4296 (> MAX_VALUE_LEN)
    const nB = gen2(5000, 13); // distinct post-comma tail
    assertNoSurvival(
      "npm-auth-token",
      redactString(`//registry.npmjs.org/:_authToken=${nA},${nB}`),
      nB,
    );
  });

  // (8) url-credential rule1 pass `[^\s@/]{1,}`。revert → pass が `@` を上限内に見つけられず rule1 失敗
  //     → 2-class pass が非マスクで leak (rule2 は scheme:// 形を pre-boundary 非該当で拾わない)。
  it("url-credential rule1 pass capture を pin する", () => {
    assertNoSurvival("url1-pass", redactString(`postgres://app:${V}@db.internal:5432/x`), V);
  });

  // (9) url-credential rule1 user `[^\s:/@]{0,}`。long user (>MAX_VALUE_LEN) を revert すると `:` 区切りが
  //     上限外で rule1 失敗 → pass 非マスク。secret=pass (user は echo ゆえ非 secret・longUser と非衝突)。
  it("url-credential rule1 user capture を pin する (long user)", () => {
    assertNoSurvival(
      "url1-user",
      redactString(`postgres://${longUser}:${pass}@db.internal:5432/x`),
      pass,
    );
  });

  // (10) url-credential rule2 pass `[^\s:/@]{1,}` (bare user:pass@host)。revert → `@` 上限外で rule2 失敗
  //      → 2-class pass leak。
  it("url-credential rule2 pass capture を pin する", () => {
    assertNoSurvival("url2-pass", redactString(`user:${V}@example.internal`), V);
  });

  // (11) url-credential rule2 user `[A-Za-z0-9._-]{1,}`。long user を revert すると `:` 上限外で rule2 失敗
  //      → pass leak。
  it("url-credential rule2 user capture を pin する (long user)", () => {
    assertNoSurvival("url2-user", redactString(`${longUser}:${pass}@example.internal`), pass);
  });

  // (12) high-entropy-secret standalone `[A-Za-z0-9+/_-]{40,}`。3-class の連続 run を単独で置き、revert
  //      {40,4096} → >4096 run の trailing lookahead が anchor できず full leak。本 rule 単独 pin。
  it("high-entropy-secret standalone capture を pin する (3-class)", () => {
    assertNoSurvival("high-entropy", redactString(gen3(5000)), gen3(5000));
  });
});

describe("INV-REDACTION-TAIL-SURVIVAL: 全体パイプライン + バイト等価", () => {
  // defense-in-depth 統合 (3-class 値)。個別 capture の pin ではない (high-entropy backstop が併走で
  //   マスクしうる) が、実運用で最も起きうる 3-class secret の end-to-end マスクを担保する。
  it("3-class 値 (integration): 全 rule 経路で ≥8 字断片が生存しない", () => {
    const W = gen3(TAIL_VALUE_LEN);
    for (const input of [
      `HUGE_SECRET_BLOB=${W}`,
      `api_secret="${W}"`,
      W, // standalone high-entropy
      `Authorization: ApiKey ${W}`,
      `postgres://app:${W}@db.internal:5432/x`,
    ]) {
      assertNoSurvival(`integration:${input.slice(0, 20)}`, redactString(input), W);
    }
  });

  // ≤MAX_VALUE_LEN の値は上限に達しないため出力バイト等価 (境界 regression 監視)。
  it("MAX_VALUE_LEN ちょうど / 直下の値は従来どおり単一マーカーへ潰れる (byte-equivalence)", () => {
    for (const len of [64, MAX_VALUE_LEN - 1, MAX_VALUE_LEN]) {
      const v = gen3(len);
      const out = redactString(`api_key=${v}`);
      expect(out, `len=${len} bare cred`).toBe("api_key=[REDACTED:credential-assignment]");
    }
  });
});
