/**
 * 走査正規化の単一出所 (TDA-CQ14-4 → TDA-CQ15-4 → task 01a059a7-173c)。
 *
 * 目的: tripwire / metatest がソースを走査するとき、識別子・source pin の出現を
 * 「コメント文言」から独立させる。コメントに逐語コピーを置くだけで pin が自己充足したり、
 * コメントに禁止語を書いただけで `not.toContain` が false RED になる状態を無くす。
 *
 * 消費者 (2026-09-01 実測 10 ファイル / 18 呼び出し点): sidecar の inv-approval /
 * inv-check-classifier / inv-file-lock-testhooks-boundary / inv-policy-categories、backend の
 * inv-agent-readiness / inv-synthetic-retire-sentinel、webui の inv-action-modal-allowlist /
 * inv-i18n / inv-semantic-first、event-model の inv-approval-timeout-ordering。
 * **片側だけ強化される複製を作らない** (以前は 7 site / 6 実装形が併存し、最も緩いコピーの強さで
 * 走査が決まっていた)。
 *
 * 配置理由: 4 workspace (sidecar / backend / webui / event-model) の test harness が共有する
 * 走査正規化ゆえ event-model に置く (`test-db-guard.ts` と同じ規範 — packages → apps の
 * 禁止方向 import を作らないための共有位置。runtime コードからは import しない)。
 *
 * ## 実測した被覆 (`inv-strip-comments.test.ts` が挙動で固定・全称の主張はしない)
 * - 行頭の行コメント (`  // note`) を落とす。行は空になり **改行は保存**する (行番号が保たれる)。
 * - **行末の行コメント (`code; // note`)** を落とす。直前の空白 / タブも一緒に落とす。
 *   空白を挟まない `code;//note` も落ちる。
 * - ブロックコメントを行内でも複数行でも落とす。複数行ブロックの改行は落ちるため
 *   **ブロックコメントを跨ぐと行番号は保存されない**。
 * - 文字列 (`'…'` / `"…"`) とテンプレート**本文**の中の `//` は **落とさない**。
 * - **テンプレート補間 `${…}` の中はコードとして走査する**: 補間内の行末 / ブロックコメントは落ち、
 *   入れ子テンプレート (`` `a${ `inner` }b` ``) でも backtick の parity は反転しない。
 *   これを欠くと、補間内へ置いた `// was: …` 型のコメント 1 本で presence pin が自己充足した
 *   (backend inv-synthetic-retire-sentinel で base 対照つきに実証・SEC-CSX-1(a))。
 * - **正規表現リテラルを skip 領域として扱う**。位置ヒューリスティックは下記のとおり保守的で、
 *   arrow `=>` の直後も受ける (`(t) => /^alias\.[^=\s]+=!/i` は実在の形)。
 * - **fail-closed 2 種**:
 *   (1) regex の終端候補の直後が `/` (= 直後が行コメント) の形は regex と認めない。これを欠くと
 *       終端 `/` が新しい regex の開始と誤認され、直後の `//` の片方を飲んで行末コメントが
 *       view に残る (SEC-CSX-1(b)・sidecar normalize.ts で実測)。
 *   (2) 閉じないブロックコメントはコメントとみなさず逐語で戻す。これを欠くと、regex の文字クラス内の
 *       `/*` (`/[^/*]/` の綴り) がファイル残り全体を飲み、当該ファイルが全 tripwire の view から
 *       空になる (SEC-CSX-2)。
 * - 行継続 (`"abc\` + 改行 + `def"`) は escape 分岐が `\` と改行を**対で**消費するため、
 *   改行 resync は発火せず文字列として正しく継続する (TDA-CSX-5 の訂正: 以前この機構の説明が逆だった)。
 *
 * ## regex 位置ヒューリスティック (意図的に保守的)
 * `/` を regex 開始とみなすのは、直前の意味のある文字が無い (ファイル先頭) か
 * `( ) , = : [ ] ! & | ? + - * % ^ ~ ; {` のいずれか、直前 2 文字が arrow `=>`、または直前の語が
 * `return / typeof / case / in / of / do / else / yield / await / new / delete / void /
 * instanceof / throw` のときだけ。`}` と裸の `>` と `<` と識別子文字は **除外**する
 * (JSX の `{...p} />` / `<Foo>` と衝突し、JSX コメント `{/* … *\/}` を飲む方向へ倒れるため)。
 * `)` `]` の直後は有効な JS では除算だが、`if (x) /re/.test(s)` の形が実在するので受ける —
 * 除算を誤って regex とみなしても span は**逐語で出力**されるのでコードは失われない。
 * regex は改行を跨げないため、同一行内で閉じ `/` が見つからなければ regex とみなさない。
 *
 * ## 実測した非被覆 (残余・「閉じた」とは書かない)
 * **方向は consumer 種別で逆になる**ので全称で「安全側」とは書かない:
 * 落とし残し (コメントが view に残る) は `not.toContain` 系には**厳しい側**だが、
 * `toContain` の presence pin には**緩い側** (コメント 1 本で pin が自己充足する)。
 * 落とし過ぎ (実コードが view から消える) は逆に `not.toContain` を盲目にする。
 *
 * - 上のヒューリスティックが除外側に倒れる位置 (識別子 / `}` / 非 arrow の `>` / `<` / quote の直後)
 *   に置かれた regex が未 escape の quote / backtick / `/*` を含むと desync する。
 *   `'` / `"` は改行で resync する (生の改行を含む単引用 / 二重引用文字列は構文エラーゆえ desync が
 *   確定する) ので影響はその行に閉じる。backtick は resync しないため次の backtick まで続く。
 *   `/*` は閉じなければ fail-closed で戻るが、**ファイル後方に `*\/` があればその間を飲む** (DROP 残余)。
 * - JSX text 中の `//` 以降を落とす (base 実装と同値の pre-existing・SEC-CSX-7)。
 * - shebang 行の末尾に行コメントを付けた形は TS の trivia 判定と食い違う (marker 注入でのみ観測)。
 * - 文字列リテラルとして書かれた逐語コピー (`const s = "export function foo()"`) は落とさない
 *   (コメントではないため — lexical 走査の構造的天井であり本 helper の穴ではない)。
 * - `INV-STRIP-COMMENTS-SINGLE-SOURCE` の検出器は識別子 `stripComments` の綴りに束縛されている。
 *   別名のローカル実装 (`stripSourceComments`) やメソッド短縮形は検出しない (SEC-CSX-5 / QA-CSX-3)。
 *   構造 (mode machine / コメント除去 regex 対) の軸へ広げるのは追跡 task。
 *
 * ## corpus 実測 (導出を明記する・TDA-CSX-6)
 * `inv-strip-comments.test.ts` の corpus ケースが CI で機械化する: 走査集合は **`git ls-files` の
 * `.ts` / `.tsx` / `.mts` / `.cts`** (repo 全体・4 workspace)。各ファイルについて
 *   (1) TS パーサが列挙した**コメント範囲だけ**を除いたテキストと strip 出力が空白無視で一致するか
 *       (落とし過ぎ / 落とし残しの双方向)
 *   (2) leaf token 列が strip 前後で一致するか (実コード喪失)
 * を照合し、判定器自身へ既知陽性 4 方向 + 既知陰性を流す。
 * **正直な限界**: 落とし残した行コメントは strip 出力を再 parse したときもコメントとして読まれるので
 * (2) では見えない — MISS 方向を担うのは (1)。
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
  /** lastSig の 1 つ前の空白以外の文字 (`=>` の 2 文字判定用)。 */
  let prevSig = "";
  /** lastSig で終わる識別子の連なり (`return` 等のキーワード判定用)。 */
  let word = "";

  const push = (s: string): void => {
    buf.push(s);
    for (const ch of s) {
      wsRun = ch === " " || ch === "\t" ? wsRun + 1 : 0;
      if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") continue;
      prevSig = lastSig;
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
    // arrow `=>` の直後は被演算子位置。JSX の `/>` や generics の `>` と衝突しないよう
    // 「直前が `=` の `>`」に限定する (裸の `>` は regex 位置に入れない)。
    if (lastSig === ">" && prevSig === "=") return true;
    return IDENT_CHAR_RE.test(lastSig) && REGEX_PRECEDING_KEYWORDS.has(word);
  };

  let i = 0;
  const n = code.length;
  let mode: Mode = "code";
  /** code mode の `{` の深さ。テンプレート補間の閉じ `}` を見分けるために数える。 */
  let braceDepth = 0;
  /** `${` を開いた時点の braceDepth のスタック (入れ子テンプレートに対応)。 */
  const interpDepths: number[] = [];
  /** block mode を開いた `/*` の位置 (閉じずに EOF へ達したときの fail-closed 復元用)。 */
  let blockStart = -1;

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
        blockStart = i;
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
      if (c === "{") {
        braceDepth++;
        push(c);
        i++;
        continue;
      }
      if (c === "}") {
        const top = interpDepths.length > 0 ? interpDepths[interpDepths.length - 1] : -1;
        if (interpDepths.length > 0 && braceDepth === top) {
          // テンプレート補間の閉じ。開いた側のテンプレート本文へ戻る。
          interpDepths.pop();
          mode = "tpl";
          push(c);
          i++;
          continue;
        }
        if (braceDepth > 0) braceDepth--;
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
        blockStart = -1;
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
    // テンプレート補間 `${…}` の中は **コード**。code mode で走査してコメントを落とす。
    if (mode === "tpl" && c === "$" && c2 === "{") {
      interpDepths.push(braceDepth);
      mode = "code";
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

  // fail-closed: 閉じないブロックコメントは「コメントではなかった」とみなし逐語で戻す。
  // これが無いと、regex の文字クラス内の `/*` (`/[^/*]/` の綴り) がファイル残り全体を飲み、
  // 当該ファイルが全 tripwire の view から空になる (SEC-CSX-2)。落とし残しへ縮退させる。
  if (mode === "block" && blockStart >= 0) push(code.slice(blockStart));

  return buf.join("");
}

const IDENT_CHAR_RE = /[A-Za-z0-9_$]/;

/**
 * この文字の直後の `/` は regex 開始とみなす (被演算子が来る位置)。
 * `)` と `]` は有効な JS では除算だが、`if (x) /re/.test(s)` の形が実在するため入れる —
 * 誤って regex とみなしても span は**逐語で出力**されるのでコードは失われない。
 * `}` と裸の `>` と `<` は **入れない**: JSX の `{...p} />` / `<Foo>` と衝突し、JSX コメント
 * `{/* … *\/}` を飲む方向へ倒れるため。arrow `=>` だけは 2 文字判定で別途受ける。
 */
const REGEX_PRECEDERS: ReadonlySet<string> = new Set([
  "(",
  ")",
  ",",
  "=",
  ":",
  "[",
  "]",
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
 *
 * fail-closed (SEC-CSX-1(b)): 終端候補の直後が `/` の形 (= 直後が行コメント) は regex と
 * 認めない。`(t) => /^alias\.[^=\s]+=!/i` のように終端直前の文字が regex 開始位置に見えると、
 * 終端 `/` が新しい regex の開始と誤認され、直後の `//` の片方を飲んで行末コメントが
 * view に残る (実測・sidecar normalize.ts)。
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
      if (src[k + 1] === "/") return -1;
      k++;
      while (k < src.length && IDENT_CHAR_RE.test(src[k] as string)) k++;
      return k;
    }
    k++;
  }
  return -1;
}
