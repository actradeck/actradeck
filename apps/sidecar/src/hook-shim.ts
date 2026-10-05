/**
 * PreToolUse command shim の **entry** (`node <dist>/hook-shim.js …`・ADR 0016)。
 *
 * 判定なしで常に {@link runHookShim} を走らせて process に結線する。本体は `hook-shim-core.ts`
 * (library・直接起動しても何もしない)。旧版は 1 ファイルで「直接起動されたか」を argv から判定して
 * おり、拡張子なしの起動形などで判定が偽になると何もせず exit 0 = gate が無音で外れた (SEC-HS-2)。
 *
 * 終了コード: 200 JSON の逐語転送 = 0 / `--on-unreachable allow` の素通り = 0 / それ以外 = 2。
 * stdout へ書けなかったときは mode によらず 2 (`output_failed`・書けなかった deny を捨てて 0 に
 * しない・SEC-HS-4)。stdout / stderr の 'error' に listener が無いと process が例外で落ちて exit 1
 * (= 上流では non-blocking) になるので、両方に listener を付ける。
 */
import { type HookShimCause, formatHookShimStderr, runHookShim } from "./hook-shim-core.js";

const EXIT_BLOCK = 2;

let exiting = false;
function exitWith(code: number): void {
  if (exiting) return;
  exiting = true;
  process.exit(code);
}

let blocking = false;
function exitBlock(cause: HookShimCause): void {
  // stdout の 'error' と write の callback の両方から来うる。理由の行は 1 回だけ書く。
  if (blocking || exiting) return;
  blocking = true;
  process.stderr.write(formatHookShimStderr(cause), () => exitWith(EXIT_BLOCK));
}

process.stdout.on("error", () => exitBlock("output_failed"));
// stderr にも書けないなら理由は伝えられないが、block の exit code だけは返す。
process.stderr.on("error", () => exitWith(EXIT_BLOCK));

runHookShim(process.argv.slice(2), { stdin: process.stdin, env: process.env }).then(
  (result) => {
    if (result.stdout !== undefined) {
      process.stdout.write(result.stdout, (err) => {
        if (err) exitBlock("output_failed");
        else exitWith(result.exitCode);
      });
      return;
    }
    if (result.stderr !== undefined) {
      process.stderr.write(result.stderr, () => exitWith(result.exitCode));
      return;
    }
    exitWith(result.exitCode);
  },
  // runHookShim は throw しない契約だが、万一の throw も block へ倒す (床)。
  () => exitBlock("unreachable"),
);
