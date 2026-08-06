/**
 * INV-REDACTION-QUOTED-CRED-UNTERMINATED (SEC-1・fix/sec1-quoted-cred-eol-fallback):
 *   credential-assignment の quoted/bare 3 ルールは値 charset `[^"\r\n]` / `[^'\r\n]` / `[^\s"',;]` が
 *   **改行と閉じクォートを除外**するため、**閉じクォートが入力に無い (未終端) か、値が改行で分断される**
 *   と 3 ルール全てが match に失敗し、値が string path (raw text) で **一切マスクされず raw at-rest 残存**
 *   した (旧実測: `password="abc…(未終端)` / `password="line1\nline2"` が完全非マスク・50 字級の短い値でも
 *   window 長・エントロピー非依存で発火)。
 *
 * ## 閉塞機構 (task 019f5ca4 で更新・SEC-5/TDA-5 訂正):
 *   主閉塞は **構造 scanner `maskMultilineQuotedCredentials`** (redactString の regex ループ前・単一行
 *   terminated 不介入 / suspicious-close chain / 真の未終端は window 末尾まで greedy)。regex 4 本目
 *   fallback (branch1/branch2) は scanner が subsume した **defense-in-depth バックストップ**であり、
 *   scanner を revert しても旧 partial-closure の範囲では GREEN を保つ (= 本ファイルの基本 6 case は
 *   backstop でも緑)。**scanner 単独を反証するのは full-closure ブロック (B1/B1'/A1) と直接 unit
 *   ブロック**である (scanner 配線除去でそれらのみ RED になることを実装時 mutation probe で実証済)。
 *
 * ## falsifiability (backstop-free 値で per-case 反証):
 *   反証ベクタは **2 char-class (lowercase+digit)** の値を使う。high-entropy `{40,}` backstop は
 *   distinct char-class >= 3 が発火条件ゆえ 2-class 値では不発。
 *
 * ## scope (対称ルールの扱い):
 *   - npm-auth-token 未終端 quoted (`_authToken="…`) は キー名が credential-keyword (`auth`/`token`) を
 *     含むため scanner (+ backstop) が mop-up する (専用テスト case あり)。
 *   - url-credential (`scheme://user:pass`) の `@` 欠落 leak は port-shape gate 付き @-less ルールが閉塞
 *     (INV-REDACTION-URLCRED-ANCHORLESS 参照)。
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
  //     含むため scanner (+ backstop) が拾う (npm-auth-token 専用ルールは `\2` 未閉じで失敗)。
  it("npm _authToken 未終端 quoted を credential-assignment 経路で mop-up する", () => {
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

describe("INV-REDACTION-QUOTED-CRED-UNTERMINATED: full-closure (旧残差 B1/B1'/A1 の閉塞・task 019f5ca4)", () => {
  // load-bearing tripwire: realistic ケース (単一行未終端 / window 内で閉じる改行分断) は **run=0 で完全
  //   閉塞**し続けること。scanner/branch/truncation 順の regression でこれらが leak を realistic size へ
  //   silent 拡大させたら RED になる (assertNoSurvival が ≥8 字生存を検出)。
  it("realistic: 単一行未終端 と window 内改行分断 は run=0 で完全閉塞", () => {
    const V = gen2(MAX_VALUE_LEN + 5000); // 9096 < PRE_REDACT_SLICE ゆえ全マスク
    assertNoSurvival("single-line-unterminated", redactString(`password="${V}`), V);
    assertNoSurvival("in-window-newline-split", redactString(`password="l1\n${V}"`), V);
  });

  // 旧残差の閉塞 (ADR 019fd5d0): 旧 tripwire は「anchor 行のみマスク (partial-closure 下限)」を pin して
  //   いたが、構造 scanner (maskMultilineQuotedCredentials) の導入で継続行も閉塞した。ここからは
  //   **full-closure (継続行/後続値も ≥8 字断片が生存しない)** を assert する。
  //   反証: scanner の redactString 配線を外す (旧挙動へ戻す) と B1/B1'/A1 全 case が RED になる。
  it("B1: 多行かつ真に未終端の継続行を window 末尾まで greedy にマスクする", () => {
    const cont = gen2(VALUE_LEN, 7); // 継続行の低エントロピー値 (2-class・backstop 不発)
    assertNoSurvival(
      "b1-continuation",
      redactString(`password="l1\n${cont}\n${gen2(200, 9)}`),
      cont,
    );
  });

  // NOTE (QA-3 訂正): この >window ベクタが実際に pin するのは「閉じクォートが pre-redact slice で
  //   切り落とされた後の未終端 greedy」= truncation 経路。CR **検出**そのものの pin は下の直接 unit
  //   ブロック (in-window CR) が担う。
  it("B1': >window 改行分断 / CR-only 分断の in-window 継続部をマスクする (truncation 経路)", () => {
    const big = gen2(PRE_REDACT_SLICE + 5000); // > window: 閉じクォートが window 外へ落ちる
    assertNoSurvival("over-window-newline-split", redactString(`password="l1\n${big}"`), big);
    assertNoSurvival("cr-split-over-window", redactString(`password="l1\r${big}"`), big);
  });

  it("A1: 未終端 + 後続の別未終端 credential の低エントロピー値をマスクする (suspicious-close chain)", () => {
    const second = gen2(50, 5);
    assertNoSurvival(
      "merge-following-credential",
      redactString(`password="l1\napi_key="${second}`),
      second,
    );
  });

  // SEC-2 (H・full 再監査): chain は改行有無に依らない。単一行 A1 (`password="x api_key="SECRET"`) は
  //   旧実装で「マーカーは立つが 2 個目の値が raw」= redaction 済みに見えて漏れていた。1 行 env ダンプ /
  //   コマンドエコー / 切り詰め 1 行 JSON は多行版より現実的な形。
  it("単一行 A1: 同一行の後続 credential 値も chain で単一 marker へ畳む (SEC-2)", () => {
    const cases: ReadonlyArray<readonly [string, string, string]> = [
      [`env: password="x api_key="${gen2(24, 3)}"`, `env: password="`, gen2(24, 3)],
      [`PASSWORD="oops API_KEY="${gen2(20, 11)}"`, `PASSWORD="`, gen2(20, 11)],
      [`client_secret='v1 password='${gen2(16, 7)}'`, `client_secret='`, gen2(16, 7)],
      [`TOKEN='abc api_key='${gen2(16, 13)}'`, `TOKEN='abc api_key='`, gen2(16, 13)],
    ];
    for (const [input, , secret] of cases) {
      assertNoSurvival(`single-line-a1: ${input.slice(0, 20)}`, redactString(input), secret);
    }
    expect(redactString(`env: password="x api_key="${gen2(24, 3)}"`)).toBe(
      `env: password="[REDACTED:credential-assignment]"`,
    );
  });

  // QA-3 (M): CR + A1-chain。`\r` 検出 (charCode 13) が落ちても chain 自体は tail 形で発火するが、
  //   in-window CR 分断の正しい多行判定は直接 unit ブロックが scanner 単独で pin する。
  it("CR + A1: CR 分断でも後続 credential 値をマスクする", () => {
    const second = gen2(50, 5);
    assertNoSurvival(
      "cr-merge-following-credential",
      redactString(`password="l1\rapi_key="${second}`),
      second,
    );
  });

  // over-redaction 意味論の pin: 未終端 opener 以降は構造的に「文字列内部」として単一 marker に飲まれ、
  //   改行を跨いだ swallow は ` [REDACT-SWALLOWED:n]` (消費 byte 数) で開示される (SEC-3・private-key/jwt
  //   の greedy fallback と同一意味論 + 長さヒント)。
  it("未終端 opener 以降の後続テキストは marker に飲まれ、swallow 長がヒントで開示される", () => {
    expect(redactString(`password="x\nfollowing line`)).toBe(
      `password="[REDACTED:credential-assignment]" [REDACT-SWALLOWED:16]`,
    );
    // 単一行未終端 (EOF まで) は旧 branch2 とバイト等価 (ヒント無し)。
    expect(redactString(`password="abc`)).toBe(`password="[REDACTED:credential-assignment]"`);
  });
});

describe("INV-REDACTION-QUOTED-CRED-UNTERMINATED: opener family 網羅 (QA-1・CRED_KEY_PART_SRC 走査範囲の pin)", () => {
  // QA-1 (M): full-closure は bare `key="` 形だけでなく **opener family 全形** で成立すること。
  //   scanner の opener regex が CRED_KEY_PART_SRC から drift (例: key 側 quote `["']?` の脱落) すると
  //   JSON quoted-key 形だけ silent に旧挙動へ落ちる — ここが RED になる。
  it("全 opener family の多行未終端で継続行が生存しない", () => {
    const cont = gen2(60, 17);
    const families: ReadonlyArray<readonly [string, string]> = [
      ["bare-eq", `password="l1\n${cont}`],
      ["yaml-colon", `password: "l1\n${cont}`],
      ["json-spaced", `"password": "l1\n${cont}`],
      ["json-tight", `"password":"l1\n${cont}`],
      ["squote-json", `'api_key': 'l1\n${cont}`],
    ];
    for (const [label, input] of families) {
      assertNoSurvival(`family-${label}`, redactString(input), cont);
    }
  });
});

describe("INV-REDACTION-QUOTED-CRED-UNTERMINATED: 直接 unit + source-coupling metatest", () => {
  // QA-10: scanner の 3 分岐契約を redactString 越しでなく直接 pin する (backstop rule-4 が救済しない
  //   scanner 単独の falsifiability — 例えば CR 検出 (charCode 13) の脱落はここだけが RED にできる)。
  it("scanner 直接: in-window CR 分断を多行として全体マスクする (CR 検出の pin)", async () => {
    const { maskMultilineQuotedCredentials } = await import("@actradeck/redaction");
    const secret = gen2(40, 19);
    // CR 分断・window 内 close: scanner 単独で値全体が畳まれること (regex backstop は通らない)。
    expect(maskMultilineQuotedCredentials(`password="l1\r${secret}"`)).toBe(
      `password="[REDACTED:credential-assignment]"`,
    );
    // LF 分断も同様。
    expect(maskMultilineQuotedCredentials(`password="l1\n${secret}"`)).toBe(
      `password="[REDACTED:credential-assignment]"`,
    );
    // 単一行 terminated は不介入 (identity)。
    expect(maskMultilineQuotedCredentials(`password="v" rest`)).toBe(`password="v" rest`);
  });

  // TDA-2 (M): opener regex と suspicious-close tail regex は CRED_KEY_PART_SRC からの**導出**であること。
  //   手書き再構成に戻すと CRED_KEY_PART_SRC 拡張時に chain 判定だけ取り残され A1 の穴が silent に再開する
  //   (再監査で `[:=]`→`[:=]{1,2}` 注入により run=50 raw 生存を実証)。source 文字列レベルで結合を固定する。
  it("metatest: opener/suspicious-close regex は CRED_KEY_PART_SRC から導出されている", async () => {
    const mod = (await import("@actradeck/redaction")) as unknown as {
      MULTILINE_CRED_OPENER_RE: RegExp;
      SUSPICIOUS_CLOSE_TAIL_RE: RegExp;
    };
    const opener = mod.MULTILINE_CRED_OPENER_RE.source;
    const tail = mod.SUSPICIOUS_CLOSE_TAIL_RE.source;
    // opener = `(KEY_PART)(["'])` / tail = `(?:KEY_PART)$` — 共通の KEY_PART 部分が一致すること。
    const openerKeyPart = opener.slice(1, opener.indexOf(`)(["'])`));
    const tailKeyPart = tail.slice("(?:".length, tail.length - ")$".length);
    expect(openerKeyPart.length).toBeGreaterThan(40); // 実質的な keyPart が入っている
    expect(openerKeyPart).toBe(tailKeyPart);
    // 両者が credential keyword を実際に含む (空文字同士の偽陽性一致を排除)。
    expect(openerKeyPart).toContain("passw");
  });
});

describe("INV-REDACTION-QUOTED-CRED-UNTERMINATED: over-redaction blast radius の pin (QA-7)", () => {
  // keyword は contains-match ゆえ opener 面は benign キー (`author`←auth / `signature`←sig) にも及び、
  //   `\s{0,8}` は改行を跨げる (`Auth:\n'…`)。これは既存 quoted ルールと同一の keyword 面だが、多行
  //   未終端では greedy swallow に増幅される。ここでは**現在の blast radius を契約として pin** し、
  //   将来 keyword/separator 面が広がったら気づけるようにする (縮小方向の改善は歓迎 = テスト更新)。
  it('substring-keyword opener (`author: "`) の多行未終端は swallow する (現状契約)', () => {
    const out = redactString(`author: "John\nline2 of bio\nline3`);
    expect(out).toContain("[REDACTED:credential-assignment]");
    expect(out).toContain("[REDACT-SWALLOWED:");
    expect(out).not.toContain("line2");
  });

  it("非 keyword キー (`note=`) の多行 quoted は不介入 (blast radius の外側境界)", () => {
    const input = `note="hello\nworld" password=x`;
    expect(redactString(input)).toBe(
      `note="hello\nworld" password=[REDACTED:credential-assignment]`,
    );
  });
});
