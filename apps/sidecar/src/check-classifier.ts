/**
 * Check 分類器 (ADR 0015 §D6・B1)。
 *
 * command 文字列を「検証チェック (test/lint/typecheck/build/format)」として分類し、closed enum
 * `check_kind` / `check_match` を付与する。sidecar emit 時にのみ走り、`packages/projection` は生
 * command を一切パースしない (§D6 layering + `security-gate-reuse-canonical-parser`)。
 *
 * ⚠️ **第二パーサ禁止**: 危険コマンド分類器 (normalize.ts) と **同一の正準チェーン**
 *   (`splitSegments` → `tokenize` → `skipCommandPrefixWords` → `stripRunnerWrappers` →
 *    `commandName` → `normalizeCommandName`) を import して使う。独自のトークナイズ/basename 抽出を
 *   書かない (path/quote/wrapper/version 接尾辞の扱いがドリフトする source を作らない・受入 11 の meta-test
 *   が正準チェーン消費を behavioral に固定する)。
 *
 * ## 判定の性質 (§D6)
 * - false-negative は「証拠なし」= 正直な既定。`other_check` backstop は作らない (security gate でない)。
 * - **mutating 変種は非認定**: `eslint --fix` / `prettier --write` はツリーを書き換える = 検証証拠でない
 *   (verify しようとする fingerprint 自体を無効化する)。
 * - `check_match`:
 *   - `program` = 正規化後の program basename が既知チェックツール (vitest/pytest/eslint/tsc/…)。
 *   - `script`  = runner (pnpm/npm/yarn/make/…) 経由の script/target 名がチェック語彙に一致 (弱い証拠・
 *     UI は inferred 表示)。
 *
 * ## NO-RAW
 * 戻り値は closed enum のみ (生 command 断片・secret を一切載せない)。command 文字列自体の保存/送信は
 * 既存の redaction choke (sink.emit) が担保する — 本分類器は enum を返すだけ。
 */
import type { CheckKind, CheckMatch } from "@actradeck/event-model";

import {
  commandName,
  normalizeCommandName,
  programTokens,
  splitSegments,
  stripRunnerWrappers,
  tokenize,
} from "./normalize.js";

export interface CheckClassification {
  readonly check_kind: CheckKind;
  readonly check_match: CheckMatch;
}

/**
 * ツリーを書き換える (= 検証証拠でない) フラグ。§D6 が明示する `--fix` / `--write` を core とし、
 * よくある同義形を保守的に追加する。いずれかがコマンドに現れたらそのセグメントはチェック非認定。
 *
 * QA-B1-3: `-w` は **含めない**。`prettier -w` (=--write) では mutating だが、`pnpm -w test` /
 *   `npm test -w pkg` では workspace 選択フラグであり mutating でない。program 横断で `-w` を mutating
 *   扱いすると workspace runner を軒並みチェック非認定にする実バグ (実 replay で判明)。`-w` の mutating
 *   判定は formatter 文脈 (FORMAT_REQUIRE_FLAG_PROGRAMS) に限定する (下記 classifyStrippedTokens 参照)。
 *   `--fix` / `--write` は語形衝突が無いため無条件で維持する。
 */
const MUTATING_FLAGS: ReadonlySet<string> = new Set([
  "--fix",
  "--write",
  "--fix-dry-run", // eslint: dry だがゲート意味論を持たせない (保守的に除外)
]);

/** formatter 文脈でのみ mutating とみなす短縮フラグ (`prettier -w` = --write)。 */
const FORMATTER_WRITE_FLAG = "-w";

/** program basename → check_kind (直接ツール・mutating フラグが無い限りチェック認定)。match=program。 */
const PROGRAM_KIND: ReadonlyMap<string, CheckKind> = new Map([
  // test runner
  ["vitest", "test"],
  ["jest", "test"],
  ["mocha", "test"],
  ["ava", "test"],
  ["pytest", "test"],
  ["py.test", "test"],
  ["tap", "test"],
  ["jasmine", "test"],
  ["phpunit", "test"],
  ["rspec", "test"],
  ["nextest", "test"],
  // lint
  ["eslint", "lint"],
  ["tslint", "lint"],
  ["pylint", "lint"],
  ["flake8", "lint"],
  ["rubocop", "lint"],
  ["stylelint", "lint"],
  ["shellcheck", "lint"],
  ["biome", "lint"],
  // typecheck
  ["tsc", "typecheck"],
  ["mypy", "typecheck"],
  ["pyright", "typecheck"],
  ["flow", "typecheck"],
  ["tsd", "typecheck"],
  // build (bundler が既定で build する program)
  ["webpack", "build"],
  ["rollup", "build"],
  ["esbuild", "build"],
]);

/**
 * program → subcommand → check_kind。第1非フラグ引数を subcommand とみなす (canonical chain が剥がした
 * 実 program に対して)。match=program。`go test` / `cargo test|clippy|check|build` / `ruff check` /
 * `deno test|lint|check` / `dotnet test|build` / `vite build` 等。
 */
const SUBCOMMAND_KIND: ReadonlyMap<string, ReadonlyMap<string, CheckKind>> = new Map([
  [
    "go",
    new Map<string, CheckKind>([
      ["test", "test"],
      ["vet", "lint"],
      ["build", "build"],
    ]),
  ],
  [
    "cargo",
    new Map<string, CheckKind>([
      ["test", "test"],
      ["nextest", "test"],
      ["clippy", "lint"],
      ["check", "typecheck"],
      ["build", "build"],
    ]),
  ],
  ["ruff", new Map<string, CheckKind>([["check", "lint"]])],
  [
    "deno",
    new Map<string, CheckKind>([
      ["test", "test"],
      ["lint", "lint"],
      ["check", "typecheck"],
    ]),
  ],
  [
    "dotnet",
    new Map<string, CheckKind>([
      ["test", "test"],
      ["build", "build"],
    ]),
  ],
  ["vite", new Map<string, CheckKind>([["build", "build"]])],
  [
    "next",
    new Map<string, CheckKind>([
      ["build", "build"],
      ["lint", "lint"],
    ]),
  ],
]);

/**
 * script runner (pnpm/npm/yarn/make/…)。script/target 名をチェック語彙へ写す (match=script・弱い証拠)。
 *
 * QA-B1-2 (comment 整合): npx/pnpx 等の exec-runner は canonical chain (stripRunnerWrappers) が **剥がさない**
 *   (RUNNER_WRAPPERS 非収録)。以前の「canonical chain が扱う対象」というコメントは誤記で、実際は分類器が
 *   `npx vitest run` を undefined にしていた。exec-runner (`npx` / `pnpx` / `bunx` / `pnpm exec|dlx` 等) は
 *   下記 `unwrapExecRunner` で **check-classifier 局所に** 貫通させ、内側 program を program-match で再分類する
 *   (RUNNER_WRAPPERS を触らない = 危険コマンド分類器の挙動を変えない)。
 */
/**
 * package manager 名 (TDA-B1R2-3: 単一 base)。script runner でも exec-subcommand runner でもあるため、
 * 両集合 (SCRIPT_RUNNERS / EXEC_SUBCOMMAND_RUNNERS) をこの 1 つの base から導出し、2 セットの並置ドリフトを防ぐ。
 */
const PACKAGE_MANAGERS = ["npm", "pnpm", "yarn", "bun"] as const;

const SCRIPT_RUNNERS: ReadonlySet<string> = new Set([...PACKAGE_MANAGERS, "make", "just", "task"]);

/**
 * exec-runner (QA-B1-2): 後続を **program 直起動**として実行するラッパ。canonical chain は剥がさないため
 * check-classifier 局所で貫通し、内側 program を再分類する (`npx vitest run` → vitest → test/program)。
 *  - 前置形: `npx <prog>` / `pnpx <prog>` / `bunx <prog>`。
 *  - subcommand 形: `pnpm exec <prog>` / `pnpm dlx <prog>` / `yarn exec|dlx <prog>` / `npm exec <prog>` /
 *    `bun x <prog>`。
 */
const EXEC_RUNNERS: ReadonlySet<string> = new Set(["npx", "pnpx", "bunx"]);
// TDA-B1R2-3: SCRIPT_RUNNERS と同じ PACKAGE_MANAGERS base から導出 (package manager 名の 2 セット並置を回避)。
const EXEC_SUBCOMMAND_RUNNERS: ReadonlySet<string> = new Set(PACKAGE_MANAGERS);
const EXEC_SUBCOMMANDS: ReadonlySet<string> = new Set(["exec", "dlx", "x"]);
/** exec-runner 貫通の最大反復 (`npx npx eslint` 様の多重も有界に止める)。 */
const MAX_EXEC_UNWRAP = 3;
/** exec-runner 自身の値付きフラグ (次トークンが値・スキップ対象)。`npx -p pkg eslint` 等。 */
const EXEC_VALUE_FLAGS: ReadonlySet<string> = new Set(["-p", "--package", "-c", "--call"]);

/** prettier / black 等「明示チェックフラグがある時だけ format チェック」の program。 */
const FORMAT_CHECK_FLAGS: ReadonlySet<string> = new Set(["--check", "-c", "--list-different"]);
const FORMAT_REQUIRE_FLAG_PROGRAMS: ReadonlySet<string> = new Set(["prettier", "black", "dprint"]);

/** セグメントに mutating フラグがあるか (args のみ・program token は除く)。 */
function hasMutatingFlag(args: readonly string[]): boolean {
  return args.some((t) => MUTATING_FLAGS.has(t));
}

/** script/target 名 → check_kind (keyword-based・mutating 名は除外)。undefined = チェックでない。 */
function scriptKeywordKind(rawName: string): CheckKind | undefined {
  const name = rawName.toLowerCase();
  // fix/write を含む script 名 (`lint:fix` / `format:write`) は mutating → 非認定。
  if (/fix|write/.test(name)) return undefined;
  if (/typecheck|type-check|tsc|typing|types\b/.test(name)) return "typecheck";
  if (/lint/.test(name)) return "lint";
  if (/(^|[^a-z])tests?([^a-z]|$)/.test(name)) return "test";
  if (/build/.test(name)) return "build";
  // format/fmt は script 経由だと write 系が支配的で false-green 源ゆえ script 認定しない (§D6 保守側)。
  return undefined;
}

/** script runner の第1 script/target 名を取り出す (`run`/`run-script` を1つスキップ)。 */
function scriptTargetName(args: readonly string[]): string | undefined {
  let i = 0;
  // 先頭のフラグ (`--silent` 等) をスキップ。
  while (i < args.length && args[i]!.startsWith("-")) i++;
  const head = args[i];
  if (head === undefined) return undefined;
  if (head === "run" || head === "run-script") {
    let j = i + 1;
    while (j < args.length && args[j]!.startsWith("-")) j++;
    return args[j];
  }
  return head;
}

/** subcommand-program の第1非フラグ subcommand を取り出す。 */
function firstSubcommand(args: readonly string[]): string | undefined {
  for (const t of args) {
    if (!t.startsWith("-")) return t.toLowerCase();
  }
  return undefined;
}

/**
 * exec-runner (QA-B1-2) を検出し、内側 program 起動のトークン列を返す。exec-runner でなければ undefined。
 * `npx <flags> prog args` / `pnpm exec <flags> prog args` 等の runner + そのフラグを剥がす。
 */
function unwrapExecRunner(name: string, args: readonly string[]): string[] | undefined {
  if (EXEC_RUNNERS.has(name)) {
    return stripExecRunnerFlags(args);
  }
  if (EXEC_SUBCOMMAND_RUNNERS.has(name)) {
    // 先頭フラグ (`pnpm --silent exec ...`) をスキップして subcommand を見る。
    let i = 0;
    while (i < args.length && args[i]!.startsWith("-")) i++;
    const sub = args[i];
    if (sub !== undefined && EXEC_SUBCOMMANDS.has(sub)) {
      return stripExecRunnerFlags(args.slice(i + 1));
    }
  }
  return undefined;
}

/** exec-runner 自身のオプション (`-y` / `--yes` / `-p pkg` 等) を剥がし、内側 program 以降を返す。 */
function stripExecRunnerFlags(args: readonly string[]): string[] {
  let i = 0;
  while (i < args.length) {
    const t = args[i]!;
    if (t === "--") {
      i++;
      break;
    }
    if (!t.startsWith("-")) break; // 内側 program。
    if (EXEC_VALUE_FLAGS.has(t)) {
      i += 2; // 値付きフラグ (`-p pkg`)。
      continue;
    }
    i++; // 単独フラグ (`-y` / `--yes` / `--package=pkg`)。
  }
  return args.slice(i);
}

/**
 * 正準チェーンで前処理済みのトークン列を分類する。undefined = チェックでない。
 * exec-runner (`npx` 等) は内側 program を再帰的に再分類する (QA-B1-2・有界 depth)。
 */
function classifyStrippedTokens(
  tokens: readonly string[],
  depth: number,
): CheckClassification | undefined {
  if (tokens.length === 0) return undefined;
  const name = normalizeCommandName(commandName(tokens as string[]));
  const args = tokens.slice(1);

  // 0. exec-runner 貫通 (npx/pnpx/bunx/pnpm exec/…)。内側 program を program-match で再分類する。
  if (depth < MAX_EXEC_UNWRAP) {
    const inner = unwrapExecRunner(name, args);
    if (inner !== undefined) {
      if (inner.length === 0) return undefined;
      // 内側にラッパが積まれている稀な形も正準チェーンで剥がしてから再分類する。
      const { tokens: stripped } = stripRunnerWrappers([...inner]);
      return classifyStrippedTokens(stripped, depth + 1);
    }
  }

  // mutating 変種 (--fix / --write) は無条件で非認定 (§D6・fingerprint を無効化する)。
  if (hasMutatingFlag(args)) return undefined;

  // 1. program 直接 (vitest / eslint / tsc / …)。
  const direct = PROGRAM_KIND.get(name);
  if (direct !== undefined) return { check_kind: direct, check_match: "program" };

  // 2. subcommand program (go test / cargo clippy / ruff check / …)。
  const subMap = SUBCOMMAND_KIND.get(name);
  if (subMap !== undefined) {
    const sub = firstSubcommand(args);
    if (sub !== undefined) {
      const kind = subMap.get(sub);
      if (kind !== undefined) return { check_kind: kind, check_match: "program" };
    }
    return undefined;
  }

  // 3. format-require-flag program (prettier --check / black --check)。
  if (FORMAT_REQUIRE_FLAG_PROGRAMS.has(name)) {
    // QA-B1-3: `-w` (=--write) は formatter 文脈でのみ mutating。ここで非認定にする。
    if (args.includes(FORMATTER_WRITE_FLAG)) return undefined;
    if (args.some((t) => FORMAT_CHECK_FLAGS.has(t))) {
      return { check_kind: "format", check_match: "program" };
    }
    return undefined; // 素の prettier (stdout 出力) / --write は非認定。
  }

  // 4. script runner (pnpm test / npm run lint / make typecheck)。match=script (弱い証拠)。
  //    QA-B1-3: `-w` は workspace フラグゆえここでは mutating 扱いしない (`pnpm -w test` を貫通させる)。
  if (SCRIPT_RUNNERS.has(name)) {
    const target = scriptTargetName(args);
    if (target === undefined) return undefined;
    const kind = scriptKeywordKind(target);
    if (kind !== undefined) return { check_kind: kind, check_match: "script" };
    return undefined;
  }

  return undefined;
}

/** 1 セグメントを分類する。undefined = このセグメントはチェックでない。 */
function classifySegment(segment: string): CheckClassification | undefined {
  const rawTokens = tokenize(segment);
  if (rawTokens.length === 0) return undefined;
  // **予約語は読み飛ばさない (QA-CQ11-2 ≡ SEC-CQ11-2・R11 監査 H)**: `if false; then pytest; fi` は
  //   exit 0 で pytest を実行せず、`! pytest` は exit を反転する。予約語を飛ばして内側を認定すると
  //   失敗したテストが passed バッジになる (ADR 0015 が禁じる fake-green)。env 代入だけを飛ばし、
  //   複合文の内側は認定しない (under-credit = 安全方向)。導出鎖は分類器と同じ `programTokens`。
  const { tokens } = programTokens(rawTokens, { reservedWords: false });
  return classifyStrippedTokens(tokens, 0);
}

/**
 * command 文字列を check 分類する (§D6)。複数セグメント (`ruff check . && pytest`) は **最初に
 * チェック認定できたセグメント**を返す (最頻の単一チェックを拾い、false-positive を避ける保守判定)。
 * どのセグメントもチェックでなければ undefined (= 証拠なし・honest)。
 */
export function classifyCheck(command: string): CheckClassification | undefined {
  if (typeof command !== "string" || command.length === 0) return undefined;
  for (const seg of splitSegments(command)) {
    const c = classifySegment(seg);
    if (c !== undefined) return c;
  }
  return undefined;
}

/**
 * payload へ展開する薄ヘルパ。分類できたときのみ `{ check_kind, check_match }` を返し、そうでなければ
 * 空オブジェクト (spread して no-op)。emit 側で `{ ...checkFields(cmd) }` として使う。
 */
export function checkFields(command: string): Partial<CheckClassification> {
  return classifyCheck(command) ?? {};
}
