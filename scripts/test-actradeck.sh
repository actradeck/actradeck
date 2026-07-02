#!/usr/bin/env bash
#
# test-actradeck.sh — actradeck (全スタック orchestrator) の CLI 契約回帰 smoke (ADR 019ee25e)。
#
# bash テスト基盤が無いため、verb ディスパッチ / unit 生成 / 秘匿非混入の不変条件を、
# 状態変更なし (install/systemctl/build を呼ばない) で固定する単発スクリプト。CI 任意配線可。
#
# 使い方: ./scripts/test-actradeck.sh   (exit 0=全 PASS / exit 1=いずれか FAIL)
#
set -uo pipefail

SELF="$(realpath "${BASH_SOURCE[0]}")"
AC="$(cd "$(dirname "$SELF")" && pwd)/actradeck"
ENV_FILE="$(cd "$(dirname "$SELF")/.." && pwd)/.env"
fail=0
ok() { printf 'PASS  %s\n' "$1"; }
ng() { printf 'FAIL  %s\n' "$1"; fail=1; }

assert_exit() {
  local want="$1" desc="$2"; shift 3
  "$@" >/dev/null 2>&1; local got=$?
  [ "$got" = "$want" ] && ok "$desc (exit=$got)" || ng "$desc (want $want got $got)"
}
# 出力を変数に捕捉してから grep する (pipe-to-grep-q の SIGPIPE×pipefail 偽失敗を回避)。
# grep -F -- で needle がオプション (--env-file 等) と誤認されるのを防ぐ。
assert_contains() {
  local needle="$1" desc="$2"; shift 3
  local out; out="$("$@" 2>&1)"
  if printf '%s' "$out" | grep -qF -- "$needle"; then ok "$desc"; else ng "$desc (missing: $needle)"; fi
}
assert_absent() {
  local needle="$1" desc="$2"; shift 3
  local out; out="$("$@" 2>&1)"
  if printf '%s' "$out" | grep -qF -- "$needle"; then ng "$desc (leaked: $needle)"; else ok "$desc"; fi
}

# 1. 構文。
assert_exit 0 "bash -n actradeck" -- bash -n "$AC"

# 2. verb ディスパッチ exit code 契約。
assert_exit 1 "未知の top-level verb は exit 1" -- bash "$AC" bogus
assert_exit 1 "print-unit に未知サービスは exit 1" -- bash "$AC" print-unit bogus
assert_exit 1 "logs に未知サービスは exit 1" -- bash "$AC" logs bogus
assert_exit 0 "doctor は exit 0" -- bash "$AC" doctor

# 3. unit 生成: ExecStart / WorkingDirectory / hardening / webui の NODE_ENV。
assert_contains "WorkingDirectory=" "backend unit に WorkingDirectory" -- bash "$AC" print-unit backend
assert_contains "src/index.ts" "backend unit の ExecStart entry" -- bash "$AC" print-unit backend
assert_contains "server.ts" "webui unit の ExecStart entry" -- bash "$AC" print-unit webui
assert_contains "Environment=NODE_ENV=production" "webui unit は NODE_ENV=production" -- bash "$AC" print-unit webui
assert_contains "After=network-online.target actradeck-backend.service" "webui は backend の後に起動" -- bash "$AC" print-unit webui
assert_contains "TimeoutStopSec=15" "hardening: TimeoutStopSec (backend)" -- bash "$AC" print-unit backend
assert_contains "NoNewPrivileges=yes" "hardening: NoNewPrivileges (webui)" -- bash "$AC" print-unit webui

# 4. 秘匿非混入: unit は .env を --env-file で参照するのみ、token 値を本体に書かない。
assert_contains "--env-file-if-exists=" "backend unit は --env-file 参照" -- bash "$AC" print-unit backend
if [ -f "$ENV_FILE" ]; then
  for k in INGEST_TOKEN REALTIME_TOKEN; do
    val="$(grep -E "^$k=" "$ENV_FILE" | head -1 | cut -d= -f2-)"
    if [ -n "$val" ]; then
      assert_absent "$val" "$k 値が backend unit に出ない" -- bash "$AC" print-unit backend
      assert_absent "$val" "$k 値が webui unit に出ない" -- bash "$AC" print-unit webui
    fi
  done
fi

# 5. QA-2: backend は dev (NODE_ENV を unit に書かない・webui のみ production)。
assert_absent "Environment=NODE_ENV" "backend unit に NODE_ENV を書かない (webui のみ prod)" -- bash "$AC" print-unit backend

# 6. SEC-1: Environment= 行に秘匿名 (_TOKEN/_SECRET/_KEY/PASSWORD) を inline しない (値は .env 経由のみ)。
for svc in backend webui; do
  envlines="$(bash "$AC" print-unit "$svc" 2>/dev/null | grep '^Environment=' || true)"
  if printf '%s' "$envlines" | grep -qiE '_TOKEN|_SECRET|_KEY|PASSWORD'; then
    ng "$svc unit の Environment= に秘匿名が混入"
  else ok "$svc unit の Environment= に秘匿名なし"; fi
done

# 7. TDA-5: doctor の status 行が prefix なしで分裂しない (TDA-1 二重出力バグの回帰防止)。
#    壊れた出力は `inactive / disabled` のような prefix 無しの裸行が現れる。
docout="$(bash "$AC" doctor 2>&1)"
if printf '%s\n' "$docout" | grep -qE '^[a-z]+ / [a-z]+$'; then
  ng "doctor status 行が prefix なしで分裂している (TDA-1 回帰)"
else
  ok "doctor status 行は分裂しない (TDA-1)"
fi

# 8. TDA-3 (security 隣接): foreground 起動の no-secret-in-argv 不変を固定する。
#    do_up_foreground のティア起動行 (exec "$node_bin" …) は --env-file-if-exists 経由でのみ
#    秘匿を渡し、token/password を argv に展開しない (systemd print-unit と同じ規律を foreground
#    にも・ADR 019ef084 / sweep 019ef0a6)。print-foreground は持たない (起動タプルの twin を
#    増やさない=TDA-2) ため、ここでは source を静的検査する。
fg_spawn="$(grep -F 'exec "$node_bin"' "$AC" || true)"
if [ -n "$fg_spawn" ]; then ok "foreground 起動行が存在 (検査対象あり)"; else ng "foreground 起動行が無い (TDA-3 検査不能)"; fi
if printf '%s\n' "$fg_spawn" | grep -qE 'INGEST_TOKEN|REALTIME_TOKEN|POSTGRES_PASSWORD|DATABASE_URL'; then
  ng "foreground 起動 argv に秘匿変数が混入 (no-secret-in-argv 違反)"
else ok "foreground 起動 argv に秘匿変数なし (no-secret-in-argv)"; fi
be_line="$(printf '%s\n' "$fg_spawn" | grep -F 'src/index.ts' || true)"
we_line="$(printf '%s\n' "$fg_spawn" | grep -F 'server.ts' || true)"
if printf '%s' "$be_line" | grep -qF -- '--env-file-if-exists=' && printf '%s' "$we_line" | grep -qF -- '--env-file-if-exists='; then
  ok "foreground backend/webui は --env-file-if-exists 経由 (path のみで秘匿)"
else ng "foreground backend/webui の --env-file 経由を確認できない"; fi
# 実 .env の token 値が actradeck の source 自体に焼き込まれていない (二重の保険)。
if [ -f "$ENV_FILE" ]; then
  for k in INGEST_TOKEN REALTIME_TOKEN POSTGRES_PASSWORD; do
    val="$(grep -E "^$k=" "$ENV_FILE" | head -1 | cut -d= -f2-)"
    [ -n "$val" ] && assert_absent "$val" "$k 値が actradeck source に出ない" -- cat "$AC"
  done
fi

# 9. sweep 回帰ガード (ADR 019ef084 の L 修正が戻らないことを固定)。
# SEC-1: port_listening が非整数ポートを弾く (regex 注入防止)。
if grep -qF '[!0-9]*) return 2' "$AC"; then ok "SEC-1: port_listening の整数ガードが存在"; else ng "SEC-1: port_listening の整数ガードが無い (退行)"; fi
# QA-2: quickstart の Node gate は first-token 抽出 (区切り除去 blanket-strip に戻っていない)。
QS="$(dirname "$AC")/quickstart"
if [ -f "$QS" ]; then
  if grep -qF 'e.match(/\d+(?:\.\d+){0,2}/)' "$QS"; then ok "QA-2: Node gate は first-token 抽出"; else ng "QA-2: Node gate の first-token 抽出が無い (退行)"; fi
  if grep -qF 'replace(/[^0-9.]/g' "$QS"; then ng "QA-2: Node gate が壊れた blanket-strip に退行"; else ok "QA-2: 壊れた blanket-strip は不在"; fi
fi

# 10. build-graph 回帰ガード (手動経路の「共有 dist 未ビルド」退行を fail-loud 化)。
#    do_build は全ワークスペースを build しなければならない: backend は @actradeck/projection /
#    event-model の dist を runtime import し、webui の next build は projection / design-tokens の
#    dist を要する。--filter で sidecar/webui だけに絞ると fresh clone で ERR_MODULE_NOT_FOUND になる
#    (本ガードは do_build を全ワークスペース build に固定し、その退行を CI で赤くする)。
if grep -qF 'pnpm -r --if-present run build' "$AC"; then ok "build-graph: do_build は全ワークスペース build (pnpm -r)"; else ng "build-graph: do_build が全ワークスペース build でない (手動経路退行)"; fi
if grep -qE 'pnpm --filter @actradeck/(sidecar|webui) build' "$AC"; then ng "build-graph: do_build が --filter サブセット build に退行 (projection/design-tokens の dist 未生成)"; else ok "build-graph: do_build は --filter サブセットに退行していない"; fi
# do_build の user-facing ビルド narration を live コードで固定する (TDA-6)。新表記が在り、旧表記
# 「sidecar (dist) + webui (next build)」が残らないこと。
if grep -qF '全ワークスペースパッケージをビルドします' "$AC"; then ok "build-graph: do_build の build narration は全ワークスペース表記"; else ng "build-graph: do_build の build narration が旧表記/欠落"; fi
if grep -qF 'sidecar (dist) + webui (next build)' "$AC"; then ng "build-graph: do_build に旧ビルド narration が残存 (sidecar+webui のみ)"; else ok "build-graph: do_build に旧ビルド narration なし"; fi
# docs/landing の散文 *および* 録画 media/ (first-run.cast 等) が actradeck up のビルド範囲を
# 「sidecar/webui のみ」と誤記/録画しない (虚偽記載・録画陳腐化の回帰防止・TDA-5/TDA-6)。
# 散文の 2 表現 + first-run cast の旧 narration 文言の 3 種すべてを検出する。
REPO="$(cd "$(dirname "$AC")/.." && pwd)"
if grep -rnqF -e 'sidecar/webui build' -e 'sidecar(dist)/webui(next build)' -e 'sidecar (dist) + webui (next build)' "$REPO/docs" "$REPO/landing" 2>/dev/null; then
  ng "build-graph: docs/landing/media に旧ビルド範囲の記述が残存 (sidecar/webui のみ)"
else ok "build-graph: docs/landing/media に旧ビルド範囲の記述なし"; fi

# 11. Phase 2 launchd: print-plist の no-secret-in-argv + XML well-formed (print-unit ゲートの twin)。
#     macOS 実走は本機 (Linux) で不能ゆえ、生成 plist の構造契約と秘匿非混入を静的に固定する。
assert_exit 1 "print-plist に未知サービスは exit 1" -- bash "$AC" print-plist bogus
for svc in backend webui; do
  assert_contains "<key>Label</key>" "$svc plist に Label" -- bash "$AC" print-plist "$svc"
  assert_contains "--env-file-if-exists=" "$svc plist は --env-file 参照 (path のみで秘匿)" -- bash "$AC" print-plist "$svc"
  assert_contains "KeepAlive" "$svc plist に KeepAlive (Restart=on-failure mirror)" -- bash "$AC" print-plist "$svc"
  # TDA-1: ExitTimeOut は systemd TimeoutStopSec=15 の mirror (graceful drain 猶予)。非 mirror 退行を固定。
  assert_contains "ExitTimeOut" "$svc plist に ExitTimeOut (TimeoutStopSec=15 mirror)" -- bash "$AC" print-plist "$svc"
  assert_contains "StandardOutPath" "$svc plist に StandardOutPath" -- bash "$AC" print-plist "$svc"
  assert_contains "RunAtLoad" "$svc plist に RunAtLoad" -- bash "$AC" print-plist "$svc"
  # XML well-formed: python3 plistlib で parse 成功 (本機に python3 あり)。
  if bash "$AC" print-plist "$svc" 2>/dev/null | python3 -c 'import plistlib,sys; plistlib.loads(sys.stdin.buffer.read())' 2>/dev/null; then
    ok "$svc plist は well-formed (plistlib parse)"
  else ng "$svc plist が plistlib で parse できない (XML 不正)"; fi
  # 秘匿名 (_TOKEN/_SECRET/_KEY/PASSWORD) が plist 本体 (ProgramArguments/EnvironmentVariables) に出ない。
  # QA-1: 外部プロセス直パイプ (bash print-plist | grep -q) は pipefail×SIGPIPE で秘匿**存在時に
  #   偽 PASS** する (grep -q が一致→早期 close→上流 print-plist が SIGPIPE(141)→pipefail 非零→else)。
  #   出力を変数へ捕捉してから printf で grep する (assert_contains/absent と同じ安全形・上流は
  #   命令置換で完走し pipe に載らない)。
  plistout="$(bash "$AC" print-plist "$svc" 2>/dev/null)"
  if printf '%s\n' "$plistout" | grep -qiE '_TOKEN|_SECRET|_KEY|PASSWORD'; then
    ng "$svc plist に秘匿名が混入 (no-secret-in-argv 違反)"
  else ok "$svc plist に秘匿名なし"; fi
done
assert_contains "src/index.ts" "backend plist の entry" -- bash "$AC" print-plist backend
assert_contains "server.ts" "webui plist の entry" -- bash "$AC" print-plist webui
# backend は NODE_ENV を書かない・webui は NODE_ENV=production (systemd の QA-2 と同じ)。
assert_absent "NODE_ENV" "backend plist に NODE_ENV を書かない (webui のみ prod)" -- bash "$AC" print-plist backend
assert_contains "NODE_ENV" "webui plist に NODE_ENV" -- bash "$AC" print-plist webui
assert_contains "<string>production</string>" "webui plist は NODE_ENV=production" -- bash "$AC" print-plist webui
# 実 .env の token/password 値が plist に一切出ない (二重の保険)。
if [ -f "$ENV_FILE" ]; then
  for k in INGEST_TOKEN REALTIME_TOKEN POSTGRES_PASSWORD; do
    val="$(grep -E "^$k=" "$ENV_FILE" | head -1 | cut -d= -f2-)"
    if [ -n "$val" ]; then
      assert_absent "$val" "$k 値が backend plist に出ない" -- bash "$AC" print-plist backend
      assert_absent "$val" "$k 値が webui plist に出ない" -- bash "$AC" print-plist webui
    fi
  done
fi

echo
if [ "$fail" = 0 ]; then echo "actradeck smoke: ALL PASS"; else echo "actradeck smoke: FAILURES"; fi
exit "$fail"
