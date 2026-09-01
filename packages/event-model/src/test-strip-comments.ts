/**
 * 走査正規化の単一出所 (TDA-CQ14-4 → TDA-CQ15-4 → task 01a059a7-173c)。
 *
 * 目的: tripwire / metatest がソースを走査するとき、識別子・source pin の出現を
 * 「コメント文言」から独立させる。コメントに逐語コピーを置くだけで pin が自己充足したり、
 * コメントに禁止語を書いただけで `not.toContain` が false RED になる状態を無くす。
 *
 * 消費者 (2026-09-01 時点): sidecar の inv-approval / inv-check-classifier /
 * inv-file-lock-testhooks-boundary / inv-policy-categories、backend の inv-agent-readiness /
 * inv-synthetic-retire-sentinel、webui の inv-action-modal-allowlist / inv-i18n、
 * event-model の inv-approval-timeout-ordering。**片側だけ強化される複製を作らない**
 * (以前は 5 site / 4 実装形が併存し、最も緩いコピーの強さで走査が決まっていた)。
 *
 * 配置理由: 4 workspace (sidecar / backend / webui / event-model) の test harness が共有する
 * 走査正規化ゆえ event-model に置く (`test-db-guard.ts` と同じ規範 — packages → apps の
 * 禁止方向 import を作らないための共有位置。runtime コードからは import しない)。
 *
 * ## 実測した被覆 (`inv-strip-comments.test.ts` が挙動で固定・全称の主張はしない)
 * - 行頭の行コメント (`  // note`) を落とす。行は空になり **改行は保存**する (行番号が保たれる)。
 * - **行末の行コメント (`code; // note`)** を落とす。直前の空白 / タブも一緒に落とす
 *   (逐語 pin が末尾空白でズレないため。行頭コメントの結果とも整合する)。
 * - ブロックコメントを行内でも複数行でも落とす。複数行ブロックの改行は落ちるため
 *   **ブロックコメントを跨ぐと行番号は保存されない** (旧実装と同じ)。
 * - 文字列 (`'…'` / `"…"`) とテンプレートリテラル (`` `…` ``) の中の `//` は **落とさない**
 *   (URL・シェル片・逐語ベクタが消えない)。旧 4 実装形のうち 3 つはここを誤って落としていた。
 * - **正規表現リテラルを skip 領域として扱う** (下記の位置ヒューリスティック)。regex の文字クラス内の
 *   quote / backtick / `/` が string mode やコメントを誤って開くのを防ぐ。実例: sidecar normalize.ts の
 *   SHELL_COMPOSITION_RE は文字クラスに backtick を含む regex で、regex を skip しない実装では
 *   そこでテンプレートリテラルを開き、ファイル残り全体の走査を desync させた (実測)。
 *
 * ## regex 位置ヒューリスティック (意図的に保守的)
 * `/` を regex 開始とみなすのは、直前の意味のある文字が無い (ファイル先頭) か
 * `( , = : [ ! & | ? + - * % ^ ~ ; {` のいずれか、または直前の語が
 * `return / typeof / case / in / of / do / else / yield / await / new / delete / void /
 * instanceof / throw` のときだけ。`)` `]` `}` `>` `<` と識別子文字は **除外**する
 * (`}` `>` は JSX の自己閉じ `/>` と、`)` `]` は除算と衝突するため)。除外側に倒れた `/` は
 * 従来どおり素の文字として扱う = regex を skip しないだけで、実コードを落とす方向ではない。
 * regex は改行を跨げないため、同一行内で閉じ `/` が見つからなければ regex とみなさない。
 *
 * ## 実測した非被覆 (残余・「閉じた」とは書かない)
 * - 上記ヒューリスティックが除外側に倒れる位置の regex (`if (x) /re/.test(s)` の `)` 直後や
 *   `xs.map((x) => /re/.test(x))` の `=>` 直後) は skip されない。その regex が **未 escape の**
 *   quote / backtick / `/` を含むと desync しうる。`'` / `"` mode は改行で resync する
 *   (JS/TS では生の改行を含む単引用 / 二重引用文字列は構文エラーゆえ desync が確定する) ので影響は
 *   その行内に閉じ、コメントが**落ち残る**方向 = 走査は厳しい側へ縮退する。テンプレートリテラルは
 *   複数行が正当ゆえ resync しない (backtick で開いた desync は次の backtick まで続く)。
 * - テンプレート補間 `${…}` の中のコメントは tpl mode ゆえ落とさない。
 * - 行継続 (`"abc\` + 改行 + `def"`) は改行 resync で code mode へ戻る。
 * - 文字列リテラルとして書かれた逐語コピー (`const s = "export function foo()"`) は落とさない
 *   (コメントではないため — これは lexical 走査の構造的天井であり本 helper の穴ではない)。
 *
 * corpus 実測 (2026-09-01・`inv-strip-comments.test.ts` の corpus ケースが機械化):
 * strip 後のソースが TypeScript parser で構文エラー無く parse されること = 実コードを誤って
 * 落としていないこと。CI では event-model の src/test 全ファイルで実走する。実装時には
 * apps/{sidecar,backend,webui} + packages/event-model の src/test 全体でも計測した:
 *   - 本実装: base 16f3bae の 487 ファイル / 本 PR 後の 488 ファイルとも **0 件**。
 *   - 旧 5 site (4 実装形) を base 16f3bae の同 487 ファイルへ当てると、
 *     sidecar util 1 件 / backend 手書き 1 件 / webui inv-action-modal-allowlist 113 件 /
 *     webui inv-i18n 8 件が壊れた (= その分だけ実コードを走査から落としていた)。
 *
 * tripwire 用途 (逐語コピー・改名の検出) には十分で、**証明ではない**。
 */
export function stripComments(code: string): string {
  type Mode = "code" | "line" | "block" | "sq" | "dq" | "tpl";

  const buf: string[] = [];
  /** buf 末尾に連続する空白 / タブの文字数 (O(1) 更新・行コメント直前の空白除去に使う)。 */
  let wsRun = 0;
  /** 直前に出力した空白以外の 1 文字 (regex 位置ヒューリスティック用)。 */
  let lastSig = "";
  /** lastSig で終わる識別子の連なり (`return` 等のキーワード判定用)。 */
  let word = "";

  const push = (s: string): void => {
    buf.push(s);
    for (const ch of s) {
      wsRun = ch === " " || ch === "\t" ? wsRun + 1 : 0;
      if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") continue;
      lastSig = ch;
      // 末尾 16 文字で十分 (判定するキーワードは最長 10 文字)。長い識別子で連結が伸び続けない。
      word = IDENT_CHAR_RE.test(ch) ? (word + ch).slice(-16) : "";
    }
  };

  /** 行コメント開始時に、その直前の空白 / タブを buf から取り除く。 */
  const dropPendingWhitespace = (): void => {
    let remaining = wsRun;
    while (remaining > 0 && buf.length > 0) {
      const last = buf[buf.length - 1] as string;
      if (last.length <= remaining) {
        remaining -= last.length;
        buf.pop();
      } else {
        buf[buf.length - 1] = last.slice(0, last.length - remaining);
        remaining = 0;
      }
    }
    wsRun = 0;
  };

  const atRegexPosition = (): boolean => {
    if (lastSig === "") return true;
    if (REGEX_PRECEDERS.has(lastSig)) return true;
    return IDENT_CHAR_RE.test(lastSig) && REGEX_PRECEDING_KEYWORDS.has(word);
  };

  let i = 0;
  const n = code.length;
  let mode: Mode = "code";

  while (i < n) {
    const c = code[i] as string;
    const c2 = i + 1 < n ? (code[i + 1] as string) : "";

    if (mode === "code") {
      // escape 素通し: skip されなかった regex 内の `\/` が後続 `/` と組んで `//` に化けるのを防ぐ
      // (code mode の生の `\` は JS/TS では構文エラーゆえ、ここに来るのは regex 内だけ)。
      if (c === "\\") {
        push(c + c2);
        i += 2;
        continue;
      }
      // コメント判定を regex 判定より先に置く: `//` は空 regex ではなく行コメント、
      // JSX の `{/* … */}` もここで落ちる。
      if (c === "/" && c2 === "/") {
        dropPendingWhitespace();
        mode = "line";
        i += 2;
        continue;
      }
      if (c === "/" && c2 === "*") {
        mode = "block";
        i += 2;
        continue;
      }
      if (c === "/" && atRegexPosition()) {
        const end = scanRegexLiteral(code, i);
        if (end > i) {
          push(code.slice(i, end));
          i = end;
          continue;
        }
      }
      if (c === "'" || c === '"' || c === "`") {
        mode = c === "'" ? "sq" : c === '"' ? "dq" : "tpl";
        push(c);
        i++;
        continue;
      }
      push(c);
      i++;
      continue;
    }

    if (mode === "line") {
      if (c === "\n") {
        mode = "code";
        push(c);
      }
      i++;
      continue;
    }

    if (mode === "block") {
      if (c === "*" && c2 === "/") {
        mode = "code";
        i += 2;
      } else {
        i++;
      }
      continue;
    }

    // 文字列 / テンプレートリテラル内: そのまま残し、エスケープと閉じを追う。
    // resync: 単引用 / 二重引用文字列は生の改行を含めない (構文エラー) ため、改行に達したら
    // 「skip されなかった regex 内の quote 等で誤って開いた」と判定して code mode へ戻す
    // (desync の影響を 1 行に閉じる)。
    if ((mode === "sq" || mode === "dq") && c === "\n") {
      mode = "code";
      push(c);
      i++;
      continue;
    }
    if (c === "\\") {
      push(c + c2);
      i += 2;
      continue;
    }
    if (
      (mode === "sq" && c === "'") ||
      (mode === "dq" && c === '"') ||
      (mode === "tpl" && c === "`")
    ) {
      mode = "code";
    }
    push(c);
    i++;
  }

  return buf.join("");
}

const IDENT_CHAR_RE = /[A-Za-z0-9_$]/;

/**
 * この文字の直後の `/` は regex 開始とみなす (被演算子が来る位置)。
 * `)` `]` `}` `>` `<` は意図的に除外 — JSX の自己閉じ `/>` と除算に衝突するため。
 */
const REGEX_PRECEDERS: ReadonlySet<string> = new Set([
  "(",
  ",",
  "=",
  ":",
  "[",
  "!",
  "&",
  "|",
  "?",
  "+",
  "-",
  "*",
  "%",
  "^",
  "~",
  ";",
  "{",
]);

/** この語の直後の `/` は regex 開始とみなす。 */
const REGEX_PRECEDING_KEYWORDS: ReadonlySet<string> = new Set([
  "return",
  "typeof",
  "case",
  "in",
  "of",
  "do",
  "else",
  "yield",
  "await",
  "new",
  "delete",
  "void",
  "instanceof",
  "throw",
]);

/**
 * `start` の `/` から始まる regex リテラルの終端 (flags の次の index) を返す。
 * 文字クラス `[…]` 内の `/` は終端にしない。regex は改行を跨げないため、改行に達したら
 * 「regex ではなかった」として -1 を返す (呼び出し側は素の `/` として扱う = 安全側)。
 */
function scanRegexLiteral(src: string, start: number): number {
  let k = start + 1;
  let inClass = false;
  while (k < src.length) {
    const ch = src[k] as string;
    if (ch === "\n") return -1;
    if (ch === "\\") {
      k += 2;
      continue;
    }
    if (inClass) {
      if (ch === "]") inClass = false;
      k++;
      continue;
    }
    if (ch === "[") {
      inClass = true;
      k++;
      continue;
    }
    if (ch === "/") {
      k++;
      while (k < src.length && IDENT_CHAR_RE.test(src[k] as string)) k++;
      return k;
    }
    k++;
  }
  return -1;
}
