#!/usr/bin/env bash
#
# test-ad-attach.sh — ad-attach の CLI 契約回帰 smoke (QA-3・ADR 019ee134)。
#
# bash テスト基盤が無いため、verb ディスパッチ / unit 生成 / 秘匿非混入の不変条件を
# 状態変更なし (install/systemctl を呼ばない) で固定する単発スクリプト。CI 任意配線可。
# 過去に do_codex の case 欠落で `codex stop` が dead-case 化した (QA-1) 類の退行を捕捉する。
#
# 使い方: ./scripts/test-ad-attach.sh   (exit 0=全 PASS / exit 1=いずれか FAIL)
#
set -uo pipefail

SELF="$(realpath "${BASH_SOURCE[0]}")"
AD="$(cd "$(dirname "$SELF")" && pwd)/ad-attach"
fail=0

ok()   { printf 'PASS  %s\n' "$1"; }
ng()   { printf 'FAIL  %s\n' "$1"; fail=1; }

# assert_exit <expected> <desc> -- <cmd...>
assert_exit() {
  local want="$1" desc="$2"; shift 3
  "$@" >/dev/null 2>&1; local got=$?
  [ "$got" = "$want" ] && ok "$desc (exit=$got)" || ng "$desc (want exit=$want got=$got)"
}

# assert_contains <needle> <desc> -- <cmd...>  (stdout+stderr を対象: 案内は err()=stderr へ出る)
# 出力を変数に捕捉してから grep する (pipe-to-grep-q の SIGPIPE×pipefail 偽失敗を回避)。
# grep -F -- で needle がオプションと誤認されるのを防ぐ。
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

# 1. 構文。
assert_exit 0 "bash -n ad-attach" -- bash -n "$AD"

# 2. verb ディスパッチの exit code 契約。
assert_exit 0 "codex stop は systemd 専管案内で exit 0 (QA-1 回帰防止)" -- bash "$AD" codex stop
assert_exit 1 "未知の top-level verb は exit 1" -- bash "$AD" bogus
assert_exit 1 "未知の codex verb は exit 1" -- bash "$AD" codex bogus
assert_exit 0 "doctor は exit 0 (node あり時)" -- bash "$AD" doctor

# 3. codex stop は案内文を出す (dead-case でないこと)。
assert_contains "systemd 配下なら" "codex stop が案内文を出す" -- bash "$AD" codex stop

# 4. unit 生成: ExecStart が各サービスのものになっている。
assert_contains "attach --scope user --yes" "attach unit の ExecStart" -- bash "$AD" print-unit
assert_contains "codex attach" "codex unit の ExecStart" -- bash "$AD" codex print-unit
assert_contains "TimeoutStopSec=30" "hardening: TimeoutStopSec (attach)" -- bash "$AD" print-unit
assert_contains "NoNewPrivileges=yes" "hardening: NoNewPrivileges (codex)" -- bash "$AD" codex print-unit

# 5. 秘匿非混入の構造不変条件: unit は EnvironmentFile 参照のみで、token 名/値を本体に書かない。
assert_contains "EnvironmentFile=-" "attach unit は EnvironmentFile 参照" -- bash "$AD" print-unit
assert_absent "INGEST_TOKEN" "attach unit に INGEST_TOKEN を書かない" -- bash "$AD" print-unit
assert_absent "INGEST_TOKEN" "codex unit に INGEST_TOKEN を書かない" -- bash "$AD" codex print-unit

echo
if [ "$fail" = 0 ]; then echo "ad-attach smoke: ALL PASS"; else echo "ad-attach smoke: FAILURES"; fi
exit "$fail"
