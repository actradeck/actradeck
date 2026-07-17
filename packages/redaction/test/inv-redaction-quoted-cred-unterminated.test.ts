/**
 * INV-REDACTION-QUOTED-CRED-UNTERMINATED (SEC-1・fix/sec1-quoted-cred-eol-fallback):
 *   credential-assignment の quoted/bare 3 ルールは値 charset `[^"\r\n]` / `[^'\r\n]` / `[^\s"',;]` が
 *   **改行と閉じクォートを除外**するため、**閉じクォートが入力に無い (未終端) か、値が改行で分断される**
 *   と 3 ルール全てが match に失敗し、値が string path (raw text) で **一切マスクされず raw at-rest 残存**
 *   した (旧実測: `password="abc…(未終端)` / `password="line1\nline2"` が完全非マスク・50 字級の短い値でも
 *   window 長・エントロピー非依存で発火)。修正は credential-keyword + `[:=]` + 開始クォートを検出し、
 *   4 本目の fallback ルールで **branch1 (改行跨ぎ lazy → 閉じクォート `\2`) / branch2 (未終端 → EOL)** の
 *   2 branch で値を consume してマスクする (redactor.ts の credential-assignment fallback 参照)。
 *
 * ## falsifiability (backstop-free 値で per-case 反証):
 *   反証ベクタは **2 char-class (lowercase+digit)** の値を使う。high-entropy `{40,}` backstop は
 *   distinct char-class >= 3 が発火条件ゆえ 2-class 値では不発。したがって fallback ルールを revert
 *   すると各 case の値が **他ルールに拾われず** raw 残存し RED になる (fallback 単独が GREEN を駆動)。
 *   修正前 (fallback 追加前) は本ファイル全 case が RED であることを probe で実証済 (PR report の
 *   revert 実測ログ)。redact-before-truncate-or-straddle-leaks 準拠: 修正前 RED → 後 GREEN を pin する。
 *
 * ## scope (対称ルールの扱い):
 *   - npm-auth-token 未終端 quoted (`_authToken="…`) は キー名が credential-keyword (`auth`/`token`) を
 *     含むため本 fallback が mop-up する (専用テスト case あり)。
 *   - url-credential (`scheme://user:pass@host`) の `@` 欠落 leak は **本 fallback の対象外**
 *     (`@` は user:pass を host:port/path から判別する唯一の anchor で、欠落時 EOL マスクは正当な DB URL
 *     の port/path を誤マスクする)。別 fix で追跡 (redactor.ts url-credential 開示コメント参照)。
 */
import { describe, expect, it } from "vitest";

import { MAX_VALUE_LEN, PRE_REDACT_SLICE, redactString } from "@actradeck/redaction";

// FRAGMENT_MIN_LEN: apps/sidecar/e2e/safety-bench/bench.ts と同一の 8 字床 (partial disclosure の下限)。
const FRAGMENT_MIN_LEN = 8;

// 値は MAX_VALUE_LEN を大きく超える長さ (bounded fallback branch1 の上限を跨ぐ・改行分断の line2 も長尺)。
const VALUE_LEN = MAX_VALUE_LEN + 5000; // 9096

// --- 決定的 dummy 値生成 (合成・実鍵ではない) --------------------------------------------------
// NOTE (documented duplication): gen2 / longestSurvivingRun は inv-redaction-tail-survival.test.ts /
//   redactor.test.ts と同型の test-only helper。cross-file の相対 test import は脆く smell ゆえ
//   **意図的複製** (tail-survival の documented duplication 方針と同一)。
// gen2 = 2 char-class (lowercase+digit)。high-entropy stage-2 (distinct class >= 3) 不発で per-case 反証が本物。
//   ※周期性 (実測 period 36) はあるが assertNoSurvival は **coarse-but-sound な binary leak 検出器**:
//   マスクマーカー `[REDACTED:…]` に lower-digit の 8-gram が無い→偽陽性なし、leak があれば必ず ≥8 字一致→
//   偽陰性なし。ゆえに `<8` 判定は sound (周期性は「正確な run 長」を膨らませるが binary 判定には無影響)。
//   looksLikePath (記号 `/` `.` `:`) も踏まない (記号なし)。
const LOWER_DIGIT = "abcdefghijklmnopqrstuvwxyz0123456789";
const gen2 = (n: number, salt = 0): string => {
  let out = "";
  for (let i = 0; i < n; i++) out += LOWER_DIGIT[((i + salt) * 2654435761) % LOWER_DIGIT.length]!;
  return out;
};

// redacted に残存する body の最長 raw run 長 (≥minLen)。tail-survival と同じ線形実装。
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

/** `secret` の ≥8 字連続断片が `out` に生存せず、かつマスクマーカーが付いていることを反証する。 */
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

describe("INV-REDACTION-QUOTED-CRED-UNTERMINATED: 未終端 / 改行分断 quoted-credential (backstop-free)", () => {
  const V = gen2(VALUE_LEN); // 2-class・high-entropy backstop 非発火

  // (1) 未終端 double-quote: 閉じ `"` が入力に無い → 旧 dquote/squote/bare 全滅 → branch2 が EOL までマスク。
  it("未終端 double-quote (閉じクォート無し) をマスクする", () => {
    assertNoSurvival("unterminated-dquote", redactString(`password="${V}`), V);
  });

  // (2) 未終端 single-quote。
  it("未終端 single-quote (閉じクォート無し) をマスクする", () => {
    assertNoSurvival("unterminated-squote", redactString(`client_secret='${V}`), V);
  });

  // (3) 改行分断 double-quote: 閉じ `"` は次行にあるが単一行 `[^"\r\n]` は改行を越えられず line2 が
  //     raw 残存していた。branch1 (改行跨ぎ lazy → `\2`) が値全体をマスクする。secret=line2 の V。
  it("改行分断 double-quote の後続行 value をマスクする", () => {
    assertNoSurvival("newline-split-dquote", redactString(`password="line1\n${V}"`), V);
  });

  // (4) 改行分断 single-quote。
  it("改行分断 single-quote の後続行 value をマスクする", () => {
    assertNoSurvival("newline-split-squote", redactString(`api_token='part1\n${V}'`), V);
  });

  // (5) JSON quoted-key で未終端 (`"password": "…` 閉じ無し)。keyPart の `["']?` が key 側 quote を吸収し、
  //     値側 開始 quote を `\2` に取る。
  it("JSON quoted-key の未終端値をマスクする", () => {
    assertNoSurvival("json-quoted-key-unterminated", redactString(`"password": "${V}`), V);
  });

  // (6) npm-auth-token 未終端 quoted の mop-up: キー名 `_authToken` が credential-keyword (auth/token) を
  //     含むため credential-assignment fallback が拾う (npm-auth-token 専用ルールは `\2` 未閉じで失敗)。
  it("npm _authToken 未終端 quoted を credential-assignment fallback で mop-up する", () => {
    assertNoSurvival(
      "npm-authtoken-unterminated",
      redactString(`//r.npmjs.org/:_authToken="${V}`),
      V,
    );
  });
});

describe("INV-REDACTION-QUOTED-CRED-UNTERMINATED: 既存挙動の非回帰 (byte-equivalence / 冪等 / over-redaction)", () => {
  // terminated quoted/bare は上の 3 ルールが先に処理する。fallback は既マスク値を再マッチしても
  //   同一 byte を返す (冪等) ため、出力は fallback 追加前とバイト等価であること。
  it("terminated quoted/bare の出力が従来どおり単一マーカー (byte-equivalence)", () => {
    expect(redactString(`password="secretval"`)).toBe(
      `password="[REDACTED:credential-assignment]"`,
    );
    expect(redactString(`client_secret='xyz'`)).toBe(
      `client_secret='[REDACTED:credential-assignment]'`,
    );
    expect(redactString(`api_key=ABCdef123`)).toBe(`api_key=[REDACTED:credential-assignment]`);
    expect(redactString(`"password": "topsecret"`)).toBe(
      `"password": "[REDACTED:credential-assignment]"`,
    );
  });

  // fallback が新規マスクする未終端/改行分断も含め、redactString は冪等 (二重適用でマーカー不変)。
  it("未終端 / 改行分断 / terminated すべてで redactString が冪等", () => {
    const V = gen2(200);
    for (const input of [
      `password="secretval"`,
      `password="${V}`, // 未終端
      `password="line1\n${V}"`, // 改行分断
    ]) {
      const once = redactString(input);
      expect(redactString(once), `冪等: ${JSON.stringify(input.slice(0, 24))}`).toBe(once);
    }
  });

  // over-redaction 防止: credential-keyword を **含まない** キーの quoted 値は素通り (観測性維持)。
  //   fallback は credential-keyword'd キーのみ発火するため一般テキストを飲まない。
  it("非 credential キーの quoted 値は温存する (over-redaction なし)", () => {
    for (const input of [
      `name="John Doe"`,
      `message="hello world"`,
      `path="/usr/local/bin"`,
      `title="quarterly report"`,
    ]) {
      expect(redactString(input), `keep: ${input}`).toBe(input);
    }
  });
});

describe("INV-REDACTION-QUOTED-CRED-UNTERMINATED: 残差 tripwire (partial-closure の pin・QA-1)", () => {
  // load-bearing tripwire: realistic ケース (単一行未終端 / window 内で閉じる改行分断) は **run=0 で完全
  //   閉塞**し続けること。branch1/branch2/truncation 順の regression でこれらが leak を realistic size へ
  //   silent 拡大させたら RED になる (assertNoSurvival が ≥8 字生存を検出)。
  it("realistic: 単一行未終端 と window 内改行分断 は run=0 で完全閉塞", () => {
    const V = gen2(MAX_VALUE_LEN + 5000); // 9096 < PRE_REDACT_SLICE ゆえ branch1/branch2 が全マスク
    assertNoSurvival("single-line-unterminated", redactString(`password="${V}`), V);
    assertNoSurvival("in-window-newline-split", redactString(`password="l1\n${V}"`), V);
  });

  // 開示済み残差 (SEC-1/QA-1・task 019f5ca4): window 内にクレデンシャル自身の行の閉じクォート皆無 (真の
  //   多行未終端 / >window 改行分断 / 後続別 credential の merge) では branch2 が 1 行目のみマスクし継続行が
  //   raw 残存しうる。ここでは **anchor 行がマスクされること (branch2 が発火し続けること = partial-closure の
  //   下限保証)** を pin する。継続行の raw は accepted residual ゆえ assert しない (leak を assert するのは
  //   脆い)。branch2 が壊れて anchor 行すら素通りしたら RED。恒久 fix (keyword-anchor 非依存) は task 019f5ca4。
  it("残差: >window 改行分断 / CR 分断 / merge でも anchor 行はマスクされる (partial-closure 下限)", () => {
    const big = gen2(PRE_REDACT_SLICE + 5000); // > window: 閉じクォートが window 外へ落ちる
    const cases: ReadonlyArray<readonly [string, string]> = [
      ["over-window-newline-split", `password="l1\n${big}"`],
      ["cr-split-over-window", `password="l1\r${big}"`],
      ["merge-following-credential", `password="l1\napi_key="${gen2(50, 5)}`],
    ];
    for (const [label, input] of cases) {
      expect(redactString(input), `${label}: anchor 行が非マスク (branch2 regression)`).toContain(
        "[REDACTED:credential-assignment]",
      );
    }
  });
});
