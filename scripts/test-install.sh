#!/usr/bin/env bash
#
# test-install.sh — scripts/install.sh の契約回帰 smoke (Phase 3・curl|sh installer)。
#
# installer は download+execute の高リスク面ゆえ、状態変更なし (clone/network/quickstart
# を一切実行しない) で不変条件を固定する。副作用ゼロの検証は --dry-run と静的検査で行い、
# 実 clone→quickstart hand-off の実走検証は別途 file:// mirror + temp dir で行う (この
# smoke には含めない)。
#
# 使い方: ./scripts/test-install.sh   (exit 0=全 PASS / exit 1=いずれか FAIL)
#
set -uo pipefail

SELF="$(realpath "${BASH_SOURCE[0]}")"
IN="$(cd "$(dirname "$SELF")" && pwd)/install.sh"
SH="$(command -v sh)"
TMP="${CLAUDE_JOB_DIR:-/tmp}/tmp/test-install.$$"
mkdir -p "$TMP"
trap 'rm -rf "$TMP"' EXIT
fail=0

ok() { printf 'PASS  %s\n' "$1"; }
ng() { printf 'FAIL  %s\n' "$1"; fail=1; }

# assert_exit <expected> <desc> -- <cmd...>
assert_exit() {
  local want="$1" desc="$2"; shift 3
  "$@" >/dev/null 2>&1; local got=$?
  [ "$got" = "$want" ] && ok "$desc (exit=$got)" || ng "$desc (want exit=$want got=$got)"
}

# assert_contains <needle> <desc> -- <cmd...>  (stdout+stderr を対象)
# 出力を変数へ捕捉してから grep する (pipe-to-grep-q の SIGPIPE×pipefail 偽失敗を回避・QA教訓)。
assert_contains() {
  local needle="$1" desc="$2"; shift 3
  local out; out="$("$@" 2>&1)"
  if printf '%s' "$out" | grep -qF -- "$needle"; then ok "$desc"; else ng "$desc (missing: $needle)"; fi
}

# assert_absent <needle> <desc> -- <cmd...>  (stdout+stderr の双方に出ないことを保証)
assert_absent() {
  local needle="$1" desc="$2"; shift 3
  local out; out="$("$@" 2>&1)"
  if printf '%s' "$out" | grep -qF -- "$needle"; then ng "$desc (leaked: $needle)"; else ok "$desc"; fi
}

# 1. 構文: POSIX sh と bash の両方でパースできる (curl|sh のデプロイ先が sh/dash/ash/bash)。
assert_exit 0 "sh -n install.sh (POSIX パース)" -- sh -n "$IN"
assert_exit 0 "bash -n install.sh" -- bash -n "$IN"

# 2. 部分ダウンロード耐性の構造不変条件: 全ロジックが main() に包まれ、末尾で 1 回だけ呼ばれる。
#    (途中切断で main 定義前に切れたら no-op になる rustup 流の安全形。)
if grep -qE '^main\(\)[[:space:]]*\{' "$IN"; then ok "main() が定義されている"; else ng "main() 定義が無い"; fi
main_calls="$(grep -cE '^main "\$@"' "$IN")"
[ "$main_calls" = 1 ] && ok "main \"\$@\" が末尾で 1 回だけ呼ばれる" || ng "main \"\$@\" の呼出し回数が 1 でない (got=$main_calls)"
# main "$@" が実効的な最終行 (以降は空行/コメントのみ)。
tail_noise="$(awk 'f{if($0!~/^[[:space:]]*(#.*)?$/) c++} /^main "\$@"/{f=1} END{print c+0}' "$IN")"
[ "$tail_noise" = 0 ] && ok "main \"\$@\" 以降に実行コードが無い" || ng "main \"\$@\" の後に実行コードがある (lines=$tail_noise)"

# 3. --help: exit 0 + Usage と env override 名を出す (契約)。
assert_exit 0 "--help は exit 0" -- sh "$IN" --help
assert_contains "Usage:" "--help が Usage を出す" -- sh "$IN" --help
assert_contains "ACTRADECK_REPO" "--help が ACTRADECK_REPO を出す" -- sh "$IN" --help
assert_contains "ACTRADECK_INSTALL_DIR" "--help が ACTRADECK_INSTALL_DIR を出す" -- sh "$IN" --help

# 4. --dry-run (前提あり): exit 0 + plan 表示 + 既定 repo/dir を echo + 副作用ゼロ。
DRYDIR="$TMP/would-install-here"
assert_exit 0 "--dry-run は exit 0 (前提 git/node/pnpm あり)" -- env ACTRADECK_INSTALL_DIR="$DRYDIR" sh "$IN" --dry-run
assert_contains "Dry run" "--dry-run が Dry run を明示" -- env ACTRADECK_INSTALL_DIR="$DRYDIR" sh "$IN" --dry-run
assert_contains "github.com/actradeck/actradeck" "--dry-run が既定 repo URL を出す" -- env -u ACTRADECK_REPO sh "$IN" --dry-run
assert_contains "$DRYDIR" "--dry-run が install dir を出す" -- env ACTRADECK_INSTALL_DIR="$DRYDIR" sh "$IN" --dry-run
# 副作用ゼロ: dry-run は clone/hand-off しない。install dir を作らない。
# QA 教訓: absent チェックごとに未使用の fresh dir を割当てる。DRYDIR を使い回すと、先行
#   assertion で dir が残存/生成された場合に foreign-die 経路へ落ち、Cloning/Handing off に
#   到達しないため当該ゲートが vacuous(不変条件を検証せず素通り)になりうる。
DRYDIR_A="$TMP/dry-a"; DRYDIR_B="$TMP/dry-b"; DRYDIR_C="$TMP/dry-c"
env ACTRADECK_INSTALL_DIR="$DRYDIR_A" sh "$IN" --dry-run >/dev/null 2>&1
[ ! -e "$DRYDIR_A" ] && ok "--dry-run は install dir を作らない (副作用ゼロ)" || ng "--dry-run が install dir を作ってしまった"
assert_absent "Cloning" "--dry-run は clone しない (Cloning 非出力)" -- env ACTRADECK_INSTALL_DIR="$DRYDIR_B" sh "$IN" --dry-run
assert_absent "Handing off" "--dry-run は quickstart へ hand-off しない" -- env ACTRADECK_INSTALL_DIR="$DRYDIR_C" sh "$IN" --dry-run

# 5. env override が反映される (REPO/REF)。
assert_contains "example.com/fork.git" "ACTRADECK_REPO override が反映" -- \
  env ACTRADECK_REPO="https://example.com/fork.git" ACTRADECK_INSTALL_DIR="$DRYDIR" sh "$IN" --dry-run
assert_contains "ref: v9.9.9" "ACTRADECK_REF override が反映" -- \
  env ACTRADECK_REF="v9.9.9" ACTRADECK_INSTALL_DIR="$DRYDIR" sh "$IN" --dry-run

# 6. 前提欠落: git 不在なら exit != 0 + git を案内。空 PATH で全外部コマンドを隠す
#    (builtin printf/command/[ は生存 → die が git で発火する)。
EMPTYBIN="$TMP/emptybin"; mkdir -p "$EMPTYBIN"
noprereq_out="$(PATH="$EMPTYBIN" "$SH" "$IN" --dry-run 2>&1)"; noprereq_rc=$?
[ "$noprereq_rc" != 0 ] && ok "前提欠落で exit != 0 (rc=$noprereq_rc)" || ng "前提欠落でも exit 0 になった"
if printf '%s' "$noprereq_out" | grep -qF 'git is required'; then ok "前提欠落の案内が git を指す"; else ng "git 欠落の案内が出ない"; fi

# 7. 秘匿非 embed: installer は token/credential を一切扱わない構造不変条件。
#    秘匿名 (_TOKEN/_SECRET/_KEY/PASSWORD) が script 本文 (コメント含む) に一切現れない。
# SEC 教訓: grep の rc を明示捕捉して fail-closed 化する。`if grep -q; then ng; else ok`
#   形は rc>=2 (対象 unreadable 等の grep エラー) を else=「秘匿なし PASS」へ写像し fail-open
#   になる。0=検出(ng) / 1=無し(ok) / >=2=grep エラー(ng・安全側) で分岐する。
grep -qiE '_TOKEN|_SECRET|_KEY|PASSWORD' "$IN"; grc=$?
if   [ "$grc" = 0 ]; then ng "install.sh に秘匿名が混入 (installer は secret 非取扱いのはず)"
elif [ "$grc" = 1 ]; then ok "install.sh に秘匿名なし (secret 非 embed)"
else ng "秘匿名ゲートの grep がエラー (rc=$grc・fail-closed)"; fi
# 実 .env の token 値が (もし在れば) installer 本文に出ない (念のため)。同じく fail-closed。
ENV_FILE="$(cd "$(dirname "$SELF")/.." && pwd)/.env"
if [ -f "$ENV_FILE" ]; then
  for k in INGEST_TOKEN REALTIME_TOKEN POSTGRES_PASSWORD; do
    val="$(grep -E "^$k=" "$ENV_FILE" | head -1 | cut -d= -f2-)"
    if [ -n "$val" ]; then
      grep -qF -- "$val" "$IN"; vrc=$?
      if   [ "$vrc" = 0 ]; then ng "$k 値が install.sh に出る"
      elif [ "$vrc" = 1 ]; then ok "$k 値が install.sh に非混入"
      else ng "$k 値ゲートの grep がエラー (rc=$vrc・fail-closed)"; fi
    fi
  done
fi

echo
if [ "$fail" = 0 ]; then echo "install smoke: ALL PASS"; else echo "install smoke: FAILURES"; fi
exit "$fail"
