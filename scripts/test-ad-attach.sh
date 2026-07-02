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
ENV_FILE="$(cd "$(dirname "$SELF")/.." && pwd)/.env"
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

# 6. Phase 2 launchd: print-plist の no-secret-in-argv + XML well-formed (print-unit ゲートの twin)。
#    launchd には EnvironmentFile 相当が無いため、秘匿は node の --env-file-if-exists=<path> で渡す
#    (argv には path のみ・値を書かない)。attach/codex 両方が well-formed かつ token 非混入であること。
assert_contains "--env-file-if-exists=" "attach plist は --env-file 参照 (path のみで秘匿)" -- bash "$AD" print-plist
assert_contains "--env-file-if-exists=" "codex plist は --env-file 参照 (path のみで秘匿)" -- bash "$AD" codex print-plist
assert_contains "<string>attach</string>" "attach plist の exec word (attach)" -- bash "$AD" print-plist
assert_contains "<string>--scope</string>" "attach plist の exec word (--scope)" -- bash "$AD" print-plist
assert_contains "<string>codex</string>" "codex plist の exec word (codex)" -- bash "$AD" codex print-plist
assert_contains "KeepAlive" "attach plist に KeepAlive (Restart mirror)" -- bash "$AD" print-plist
# TDA-1: ExitTimeOut は systemd TimeoutStopSec=30 の mirror (graceful flush/detach 猶予)。
assert_contains "ExitTimeOut" "attach plist に ExitTimeOut (TimeoutStopSec=30 mirror)" -- bash "$AD" print-plist
assert_contains "ExitTimeOut" "codex plist に ExitTimeOut (TimeoutStopSec=30 mirror)" -- bash "$AD" codex print-plist
assert_absent "INGEST_TOKEN" "attach plist に INGEST_TOKEN を書かない" -- bash "$AD" print-plist
assert_absent "INGEST_TOKEN" "codex plist に INGEST_TOKEN を書かない" -- bash "$AD" codex print-plist
# 秘匿名 (_TOKEN/_SECRET/_KEY/PASSWORD) が plist 本体に出ない。
# QA-1: 外部プロセス直パイプ (bash print-plist | grep -q) は pipefail×SIGPIPE で秘匿存在時に
#   偽 PASS するため、出力を変数へ捕捉してから printf で grep する (安全形)。
attach_plist="$(bash "$AD" print-plist 2>/dev/null)"
codex_plist="$(bash "$AD" codex print-plist 2>/dev/null)"
if printf '%s\n' "$attach_plist" | grep -qiE '_TOKEN|_SECRET|_KEY|PASSWORD'; then
  ng "attach plist に秘匿名が混入 (no-secret-in-argv 違反)"
else ok "attach plist に秘匿名なし"; fi
if printf '%s\n' "$codex_plist" | grep -qiE '_TOKEN|_SECRET|_KEY|PASSWORD'; then
  ng "codex plist に秘匿名が混入 (no-secret-in-argv 違反)"
else ok "codex plist に秘匿名なし"; fi
# XML well-formed: python3 plistlib で parse 成功。
if bash "$AD" print-plist 2>/dev/null | python3 -c 'import plistlib,sys; plistlib.loads(sys.stdin.buffer.read())' 2>/dev/null; then
  ok "attach plist は well-formed (plistlib parse)"
else ng "attach plist が plistlib で parse できない (XML 不正)"; fi
if bash "$AD" codex print-plist 2>/dev/null | python3 -c 'import plistlib,sys; plistlib.loads(sys.stdin.buffer.read())' 2>/dev/null; then
  ok "codex plist は well-formed (plistlib parse)"
else ng "codex plist が plistlib で parse できない (XML 不正)"; fi
# 実 .env の token 値が plist に一切出ない。
if [ -f "$ENV_FILE" ]; then
  for k in INGEST_TOKEN REALTIME_TOKEN POSTGRES_PASSWORD; do
    val="$(grep -E "^$k=" "$ENV_FILE" | head -1 | cut -d= -f2-)"
    if [ -n "$val" ]; then
      assert_absent "$val" "$k 値が attach plist に出ない" -- bash "$AD" print-plist
      assert_absent "$val" "$k 値が codex plist に出ない" -- bash "$AD" codex print-plist
    fi
  done
fi

echo
if [ "$fail" = 0 ]; then echo "ad-attach smoke: ALL PASS"; else echo "ad-attach smoke: FAILURES"; fi
exit "$fail"
