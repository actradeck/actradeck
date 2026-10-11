/**
 * PreToolUse command shim の **entry** (`node <dist>/hook-shim.js …`・ADR 0016)。
 *
 * 判定なしで常に {@link runHookShim} を走らせて process に結線する。本体は `hook-shim-core.ts`
 * (library・直接起動しても何もしない)。旧版は 1 ファイルで「直接起動されたか」を argv から判定して
 * おり、拡張子なしの起動形などで判定が偽になると何もせず exit 0 = gate が無音で外れた (SEC-HS-2)。
 *
 * **このファイルを import しない**: top-level で shim を走らせて `process.exit` するので、import した
 * process は stdin を読み (引数不正なら最大 10s)、exit 2 で終わる。entry を import する module は無い
 * (2026-10-06 grep)。test は実プロセスとして起動する。
 *
 * ## core は dynamic import で読む (SEC-HS-R2-1)
 * 静的 import だと、core (`hook-shim-core.js`) を解決・評価できないとき entry ごと読込みに失敗して
 * exit 1 (= 上流では non-blocking・素通り) になる。dynamic import の reject を床で受けて exit 2 にする。
 * core の評価が決着しない (top-level await が永久に pending) 場合は reject も来ないので、event loop が
 * 空になった時点の `beforeExit` でも床を走らせる (SEC-HSH-1)。床は `--on-unreachable allow` でも block。
 * INV で実測した形は 4 つ (各 block / allow): entry 単体の symlink を `--preserve-symlinks-main` で
 * 起動・entry だけを別 dir へコピー・core の途中切断・決着しない top-level await を持つ core。entry
 * 自身を読めない (不在・構文が壊れている) 場合、Node を起動できない場合、CC から継承した
 * `NODE_OPTIONS` の preload (`--require` / `--import`) が失敗する場合は、このファイルが走らないので
 * 依然 exit 1 / 起動失敗 (= non-blocking・ADR 0016 に開示)。
 *
 * ## 床の stderr は core の固定文の 2 コピー目
 * 床は core を読めない場合にも走るので、core の `formatHookShimStderr` を使えない。よって
 * {@link FLOOR_STDERR} は `formatHookShimStderr("unreachable")` と**全文同一**の文字列をここに持つ。
 * 一致は INV-HOOK-SHIM-FAIL-CLOSED が挙動で固定する (core 欠落の実プロセス行の stderr と、表の
 * core 経由の stderr が、test 側の同じリテラルに全文一致する)。片側だけ文面を変えると RED。
 *
 * 終了コード: 200 JSON の逐語転送 = 0 / `--on-unreachable allow` の素通り = 0 / それ以外 = 2。
 * stdout へ書けなかったときは mode によらず 2 (`output_failed`・書けなかった deny を捨てて 0 に
 * しない・SEC-HS-4)。
 *
 * ## 'error' listener は冗長 (開示・QA-HS-R2-4 / TDA-HS-R2-1 (g))
 * stdout / stderr とも、Node 22 / Linux の pipe では EPIPE が write の callback に渡り、listener を
 * 外しても exit code は変わらない (stdout は実装者の変異、stderr は QA / TDA R2 が dist で実測: 読み側を
 * 閉じても listener の有無によらず exit 2)。'error' が listener 無しで emit されると例外で exit 1
 * (= non-blocking) になるので、版差に備えて両方に残す。無 pin の保険であり、INV はこれを捕まえない。
 *
 * ## 床が守らないもの (開示)
 * core を読めずに床で終わる経路は stdin を読まずに exit する (core の `drainInput` を使えないため)。
 * pipe buffer を超える入力では書き手 (CC) 側が EPIPE を受けうる。その場合の上流の扱いは未実測
 * (base は同じ状況で exit 1 = 必ず素通りだったので、exit 2 にした分だけ base より強い)。
 */
import type * as ShimCore from "./hook-shim-core.js";

const EXIT_BLOCK = 2;

/**
 * 床の stderr。`formatHookShimStderr("unreachable")` と全文同一 (上記・INV が挙動で結合する)。
 * gate を外す手順・コマンド・endpoint を含めない (SEC-HS-3)。
 */
const FLOOR_STDERR =
  "actradeck hook-shim: blocked PreToolUse (cause=unreachable)\n" +
  "This tool call was blocked because ActraDeck could not get an approval decision for it. " +
  "Ask the user to check the ActraDeck daemon; do not change ActraDeck settings or processes yourself.\n";

let exiting = false;
function exitWith(code: number): void {
  if (exiting) return;
  exiting = true;
  process.exit(code);
}

let blocking = false;
function block(stderr: string): void {
  // stdout の 'error' と write の callback の両方から来うる。理由の行は 1 回だけ書く。
  if (blocking || exiting) return;
  blocking = true;
  process.stderr.write(stderr, () => exitWith(EXIT_BLOCK));
}

// stderr にも書けないなら理由は伝えられないが、block の exit code だけは返す (冗長な保険・上記)。
process.stderr.on("error", () => exitWith(EXIT_BLOCK));

async function main(): Promise<void> {
  const core: typeof ShimCore = await import("./hook-shim-core.js");
  // 冗長な保険 (上記)。stdout は core を読めた後にしか書かないので、ここで付ける。
  process.stdout.on("error", () => block(core.formatHookShimStderr("output_failed")));
  const result = await core.runHookShim(process.argv.slice(2), {
    stdin: process.stdin,
    env: process.env,
  });
  if (result.stdout !== undefined) {
    process.stdout.write(result.stdout, (err) => {
      if (err) block(core.formatHookShimStderr("output_failed"));
      else exitWith(result.exitCode);
    });
    return;
  }
  if (result.stderr !== undefined) {
    process.stderr.write(result.stderr, () => exitWith(result.exitCode));
    return;
  }
  exitWith(result.exitCode);
}

// 床: core を読めない (解決・評価の失敗)・runHookShim の reject (throw しない契約だが万一)・
// main 内の同期例外は、すべて exit 2 へ倒す。床は `--on-unreachable` を見ない (allow でも block・
// argv を読む core が無い状態で kill-switch を解釈しない・SEC-HSH-2)。
main().catch(() => block(FLOOR_STDERR));
// 床 (SEC-HSH-1): core の評価が決着しないまま (top-level await が永久に pending 等) event loop が
// 空になると、main() は resolve も reject もしないので上の catch は走らず、Node は exit 0 で終わる。
// 正常な経路はすべて exitWith (= process.exit) で終わり beforeExit は来ないので、来たら block する。
process.on("beforeExit", () => block(FLOOR_STDERR));
