/**
 * INV-REDACTION-URLCRED-ANCHORLESS (SEC-2・task 019f5ca4・ADR 019fd5d0):
 *   url-credential の @-rule は必須 anchor `@` の欠落 (`scheme://user:pass` で `@host` が無い) で match
 *   失敗し pass が raw 残存していた (裁定 019f5ca3 SEC-2・pre-existing)。`@` は user:pass を host:port/path
 *   から判別する最強 anchor だが唯一ではない — **port は数字のみ**という URL 構造事実を使い、
 *   port-shape gate (`1-5 桁数字 + 非 word 文字/終端` なら port とみなし不介入) 付きの @-less ルールで
 *   閉塞する。判別不能な「≤5 桁純数字 pass」のみ不介入 (開示残差・下で pin)。
 *
 * ## falsifiability (backstop-free 値で反証):
 *   反証ベクタは 2 char-class (lowercase+digit) の pass を使う。high-entropy backstop (distinct
 *   char-class >= 3) 不発ゆえ、@-less ルールを revert すると mask case が raw 残存し RED になる。
 *
 * ## ReDoS: pass 捕捉は atomic-group emulation `(?=([^\s@/]{1,}))\2` (ECMAScript lookahead は
 *   backtracking 状態を破棄) で `@` 後続時も backtrack しない = 線形。scaling test で実測固定。
 */
import { describe, expect, it } from "vitest";

import { redactString } from "@actradeck/redaction";

// FRAGMENT_MIN_LEN / gen2 / longestSurvivingRun: inv-redaction-quoted-cred-unterminated.test.ts と同型の
//   test-only helper (cross-file の相対 test import は脆く smell ゆえ意図的複製・documented duplication)。
const FRAGMENT_MIN_LEN = 8;
const LOWER_DIGIT = "abcdefghijklmnopqrstuvwxyz0123456789";
const gen2 = (n: number, salt = 0): string => {
  let out = "";
  for (let i = 0; i < n; i++) out += LOWER_DIGIT[((i + salt) * 2654435761) % LOWER_DIGIT.length]!;
  return out;
};
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

describe("INV-REDACTION-URLCRED-ANCHORLESS: @-less pass のマスク (SEC-2 閉塞)", () => {
  it("低エントロピー pass (@ 欠落) を pass のみマスクする", () => {
    expect(redactString(`postgres://user:sw0rdfish99`)).toBe(
      `postgres://user:[REDACTED:url-credential]`,
    );
    // 空ユーザ (password-only URL) も対称に捕捉。
    expect(redactString(`redis://:hunter2pw`)).toBe(`redis://:[REDACTED:url-credential]`);
  });

  it("長尺 pass でも ≥8 字断片が生存しない (tail-survival)", () => {
    const pass = gen2(9096);
    const out = redactString(`postgres://user:${pass}`);
    expect(longestSurvivingRun(out, pass)).toBeLessThan(FRAGMENT_MIN_LEN);
    expect(out).toContain("[REDACTED:url-credential]");
  });

  it("6 桁以上の純数字 pass はマスクする (valid port 形は 1-5 桁のみ)", () => {
    expect(redactString(`postgres://u:1234567`)).toBe(`postgres://u:[REDACTED:url-credential]`);
  });
});

describe("INV-REDACTION-URLCRED-ANCHORLESS: port-shape keep (over-redaction 防止・観測性維持)", () => {
  // port (1-5 桁数字 + 非 word 文字/終端) を持つ実 URL/DSN/log 形はバイト等価で温存する。
  it("実 URL/DSN/log の host:port 形を温存する (バイト等価)", () => {
    for (const input of [
      `postgres://app:5432/db`,
      `redis://localhost:6379`,
      `see (http://host:8080) ok`,
      `mongodb://h1:27017,h2:27017/db`,
      `at https://example.com:443.`,
      `tcp://0.0.0.0:8080`,
    ]) {
      expect(redactString(input), `keep: ${input}`).toBe(input);
    }
  });

  // 開示残差の pin (ADR 019fd5d0): ≤5 桁純数字 pass は port と構造的判別不能ゆえ不介入 (under-redaction
  //   側の狭い残差・意図的)。この keep が壊れて数字 port を飲み始めたら観測性 regression として RED。
  it("残差 pin: ≤5 桁純数字は pass でも port と判別不能ゆえ温存する (意図的不介入)", () => {
    expect(redactString(`postgres://u:12345`)).toBe(`postgres://u:12345`);
  });
});

describe("INV-REDACTION-URLCRED-ANCHORLESS: 既存 @-rule との整合 (二重マスクなし・冪等)", () => {
  it("@ がある形は既存 @-rule の単一マスクのまま (regression なし)", () => {
    expect(redactString(`postgres://user:pw123@host/db`)).toBe(
      `postgres://user:[REDACTED:url-credential]@host/db`,
    );
  });

  it("@-less マスク出力は冪等 (二重適用でバイト不変)", () => {
    for (const input of [
      `postgres://user:sw0rdfish99`,
      `redis://:hunter2pw`,
      `postgres://app:5432/db`,
      `postgres://user:pw123@host/db`,
    ]) {
      const once = redactString(input);
      expect(redactString(once), `冪等: ${input}`).toBe(once);
    }
  });
});

describe("INV-REDACTION-URLCRED-ANCHORLESS: ReDoS scaling (atomic emulation の線形性)", () => {
  // redosBestOfMs 同型 (redactor.test.ts の documented duplication 方針): best-of-N の最小値。
  const bestOf = (run: () => void, repeat = 15): number => {
    run();
    run();
    const samples: number[] = [];
    for (let i = 0; i < repeat; i++) {
      const t = process.hrtime.bigint();
      run();
      samples.push(Number(process.hrtime.bigint() - t) / 1e6);
    }
    return samples.reduce((a, b) => (b < a ? b : a), Infinity);
  };
  const REDOS_RATIO_MAX = 3.5;

  it("adversarial: 長大 pass + 末尾 @ (lookahead 不成立 backtrack 誘発形) が線形", () => {
    // `scheme://a:<pass>@` は @-less ルールの末尾 lookahead を pass 全長で不成立にする最悪形。
    // atomic emulation が無ければ pass 内 backtrack で超線形化する。
    const mk = (n: number): string => `https://a:${"b".repeat(n)}@`;
    const n = 64 * 1024;
    const tN = bestOf(() => redactString(mk(n)));
    const t2N = bestOf(() => redactString(mk(2 * n)));
    const floored = Math.max(tN, 0.5); // 過小分母によるノイズ比防止
    const ratio = t2N / floored;
    expect(
      ratio,
      `anchorless url-credential ratio t(2n)/t(n)=${ratio.toFixed(2)} (>= ${REDOS_RATIO_MAX} ⇒ super-linear / ReDoS の疑い)`,
    ).toBeLessThan(REDOS_RATIO_MAX);
  }, 20_000);

  it("adversarial: scheme://x:port 反復 (gate 発火の稠密形) が線形", () => {
    const unit = `http://h:8080) `;
    const mk = (n: number): string => unit.repeat(Math.ceil(n / unit.length));
    const n = 64 * 1024;
    const tN = bestOf(() => redactString(mk(n)));
    const t2N = bestOf(() => redactString(mk(2 * n)));
    const floored = Math.max(tN, 0.5);
    const ratio = t2N / floored;
    expect(ratio, `port-gate dense ratio t(2n)/t(n)=${ratio.toFixed(2)}`).toBeLessThan(
      REDOS_RATIO_MAX,
    );
  }, 20_000);
});
