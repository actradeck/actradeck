/**
 * INV-REDACTION-URLCRED-ANCHORLESS (SEC-2・task 019f5ca4・ADR 019fd5d0 + full 再監査所見の反映):
 *   url-credential の @-rule は必須 anchor `@` の欠落 (`scheme://user:pass` で `@host` が無い) で match
 *   失敗し pass が raw 残存していた (裁定 019f5ca3 SEC-2・pre-existing)。port-shape gate (「1-5 桁数字 +
 *   URL authority 終端子」のみ port とみなす) + RFC-3986 userinfo 合法文字への捕捉限定で閉塞する。
 *
 * 再監査所見の反映 (どれかが壊れたら該当所見が再発する):
 *   - SEC-1 (H): gate 終端子を「非 word 文字全般」にすると `admin:2024!Summer` 級の「数字始まり + 記号」
 *     現実的パスワードが全 raw になる → mask ブロックの digit+punct 群が pin。
 *   - TDA-1 (M): 捕捉を `[^\s@/]` にするとテンプレートリテラル `:${…}` / IPv6 `[::1]:8080` を破壊する
 *     → keep ブロックが pin。
 *   - QA-2 (M): 純数字境界は 5-keep / 6-mask を両側 pin。
 *   - QA-5/QA-6 (M): IPv6・trailing punctuation の挙動と、開示残差 (数字+構造区切り / URL 非合法文字での
 *     部分マスク / 改行分断) を pin。
 *
 * ## falsifiability (backstop-free 値で反証):
 *   反証ベクタは 2 char-class (lowercase+digit または digit+記号) の pass を使う。high-entropy backstop
 *   (distinct char-class >= 3) 不発ゆえ、@-less ルールを revert すると mask case が raw 残存し RED になる。
 *
 * ## ReDoS: scaling は redactor.test.ts の INV-REDACTION-REDOS-SCALING corpus に統合
 *   (port-gate dense case・redosBestOfMs 単一 basis)。atomic-group emulation は defensive-by-construction
 *   (@-rule が先行するため backtrack 誘発形は redactString 経由で到達不能・QA-4) — 本ファイルでは計測しない。
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

  // SEC-1 (H) pin: 「数字始まり + 記号」の現実的パスワード形。gate 終端子を非 word 文字全般へ緩めると
  //   これらが全 raw になる (再監査で実証された leak クラス)。
  it("数字始まり + 記号の pass をマスクする (SEC-1 の port-gate 残差クラス)", () => {
    for (const [input, expected] of [
      [`mongodb://root:123$ecurePAssw0rd`, `mongodb://root:[REDACTED:url-credential]`],
      [`redis://cache:8080.Xk9pQmZr7wLtBv3nCs8hJd`, `redis://cache:[REDACTED:url-credential]`],
      [`mysql://root:1234;abcdefghijklmnop`, `mysql://root:[REDACTED:url-credential]`],
      [`postgres://u:31337~correcthorsebatterystaple`, `postgres://u:[REDACTED:url-credential]`],
      [`postgres://u:12345:morepass`, `postgres://u:[REDACTED:url-credential]`],
      [`redis://:2024!Summer`, `redis://:[REDACTED:url-credential]`],
      [`postgres://user:$ecret123`, `postgres://user:[REDACTED:url-credential]`],
      [`postgres://user:P!ssw0rd*2026`, `postgres://user:[REDACTED:url-credential]`],
    ] as const) {
      expect(redactString(input), `mask: ${input}`).toBe(expected);
    }
  });

  it("長尺 pass でも ≥8 字断片が生存しない (tail-survival)", () => {
    const pass = gen2(9096);
    const out = redactString(`postgres://user:${pass}`);
    expect(longestSurvivingRun(out, pass)).toBeLessThan(FRAGMENT_MIN_LEN);
    expect(out).toContain("[REDACTED:url-credential]");
  });

  // QA-2 (M) pin: 純数字境界は両側で固定する (5 = port 判別不能で keep / 6 = valid port 外でマスク)。
  //   gate の `{1,5}` を 1 文字緩めるとここが RED になる。
  it("純数字 pass の境界: 6 桁はマスク・(5 桁 keep は port-shape keep ブロックで pin)", () => {
    expect(redactString(`postgres://u:123456`)).toBe(`postgres://u:[REDACTED:url-credential]`);
    expect(redactString(`postgres://u:123456/db`)).toBe(
      `postgres://u:[REDACTED:url-credential]/db`,
    );
    expect(redactString(`postgres://u:1234567`)).toBe(`postgres://u:[REDACTED:url-credential]`);
  });
});

describe("INV-REDACTION-URLCRED-ANCHORLESS: port-shape keep (over-redaction 防止・観測性維持)", () => {
  // port (1-5 桁数字 + URL authority 終端子) を持つ実 URL/DSN/log 形はバイト等価で温存する。
  it("実 URL/DSN/log の host:port 形を温存する (バイト等価)", () => {
    for (const input of [
      `postgres://app:5432/db`,
      `redis://localhost:6379`,
      `see (http://host:8080) ok`,
      `mongodb://h1:27017,h2:27017/db`,
      `at https://example.com:443.`,
      `tcp://0.0.0.0:8080`,
      `https://example.com:443/v1/x`,
      `http://h:8080#frag`,
      `http://h:8080?q=1`,
    ]) {
      expect(redactString(input), `keep: ${input}`).toBe(input);
    }
  });

  // TDA-1 (M) / QA-5 (M) pin: 捕捉は RFC-3986 userinfo 合法文字のみ。`[^\s@/]` へ緩めるとテンプレート
  //   リテラルや IPv6 bracket URL (本製品自身の loopback/OTLP ログ形) を破壊し、ここが RED になる。
  it("テンプレートリテラル / IPv6 bracket URL を温存する (RFC-3986 charset の pin)", () => {
    for (const input of [
      "const base = `ws://127.0.0.1:${addr.port}`;",
      `http://[::1]:8080/health`,
      `connect to http://[::1]:4319/v1/traces now`,
    ]) {
      expect(redactString(input), `keep: ${input}`).toBe(input);
    }
  });

  // 開示残差の pin (ADR 019fd5d0・QA-6): under-redaction 側の意図的不介入。keep が壊れて port を飲み
  //   始めたら観測性 regression、mask 側へ倒れたら残差開示が虚偽になる — 両方向を RED にする。
  it("残差 pin (1): ≤5 桁純数字は port と判別不能ゆえ温存する", () => {
    expect(redactString(`postgres://u:12345`)).toBe(`postgres://u:12345`);
  });

  it("残差 pin (2): 数字 1-5 桁 + 構造区切り (`#` fragment) は port+fragment と構造同型ゆえ温存する", () => {
    expect(redactString(`amqp://svc:99#hunter2hunter2hunter2`)).toBe(
      `amqp://svc:99#hunter2hunter2hunter2`,
    );
  });

  it("残差 pin (3): URL 非合法文字を含む未エンコード pass は合法 prefix のみマスク (残部 raw)", () => {
    // `#` は RFC 構造区切りゆえ捕捉が止まり、`#Prod` は fragment として残る (prefix はマスクされる)。
    expect(redactString(`postgres://admin:2024!Summer#Prod`)).toBe(
      `postgres://admin:[REDACTED:url-credential]#Prod`,
    );
    // `/` も同様 (先頭セグメントのみマスク・SEC-4 個別追跡)。
    expect(redactString(`postgres://app:Sw0rd/fish99Secret`)).toBe(
      `postgres://app:[REDACTED:url-credential]/fish99Secret`,
    );
  });

  it("残差 pin (4): 改行分断 pass は改行以降が residual (charset が改行を除外)", () => {
    expect(redactString(`postgres://user:sw0rd\nplain following line`)).toBe(
      `postgres://user:[REDACTED:url-credential]\nplain following line`,
    );
  });

  // QA-5 挙動 pin: マスクされた pass に隣接する RFC 合法の文末記号は捕捉に含まれ marker に飲まれる
  //   (fail-safe 側の既知挙動・観測性コストは 1 文字)。
  it("挙動 pin: trailing punctuation (RFC 合法) は marker に飲まれる", () => {
    expect(redactString(`see (postgres://user:sw0rdfish99) ok`)).toBe(
      `see (postgres://user:[REDACTED:url-credential] ok`,
    );
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
      `postgres://admin:2024!Summer#Prod`,
      `postgres://app:5432/db`,
      `postgres://user:pw123@host/db`,
      `see (postgres://user:sw0rdfish99) ok`,
    ]) {
      const once = redactString(input);
      expect(redactString(once), `冪等: ${input}`).toBe(once);
    }
  });
});
