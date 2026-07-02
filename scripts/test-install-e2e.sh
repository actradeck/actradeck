#!/usr/bin/env bash
#
# test-install-e2e.sh — scripts/install.sh の load-bearing 経路を実走で固定する e2e (Phase 3)。
#
# test-install.sh (副作用ゼロ smoke = --dry-run + 静的検査) は clone / pull / foreign-dir 拒否 /
# REF checkout / hand-off exec を **一度も実行しない**ため、これらを壊す変更が緑を素通りしうる
# (QA-1)。本 e2e は **file:// sentinel repo + temp dir** で installer を end-to-end 実走し、実挙動
# を回帰固定する。ネットワーク不要・サブ秒・実バイナリ/API key 不要ゆえ CI で常時実行できる。
#
# 固定する不変条件:
#   - 実 clone → quickstart への exec hand-off 到達 (cwd=install dir)
#   - 既存 checkout の冪等更新 (再 clone しない・pull 経路)
#   - foreign 非空 dir / ActraDeck でない git repo を clobber せず die (SEC/データ保護)
#   - REF (tag) checkout・**REF 再実行が冪等** (detached HEAD で pull --ff-only が落ちない=TDA-1)
#   - credential 入り REPO URL が出力へ redact される (SEC-1)
#   - option 様 (`-`始まり) の REPO/REF を安全に拒否 (SEC-2)
#
# 使い方: ./scripts/test-install-e2e.sh   (exit 0=全 PASS / exit 1=いずれか FAIL)
#
set -uo pipefail

SELF="$(realpath "${BASH_SOURCE[0]}")"
IN="$(cd "$(dirname "$SELF")" && pwd)/install.sh"
BASE="$(mktemp -d "${CLAUDE_JOB_DIR:-${TMPDIR:-/tmp}}/test-install-e2e.XXXXXX")"
trap 'rm -rf "$BASE"' EXIT
fail=0
ok() { printf 'PASS  %s\n' "$1"; }
ng() { printf 'FAIL  %s\n' "$1"; fail=1; }

# --- sentinel ActraDeck repo: 最小構造 (scripts/quickstart = マーカーを出す無害な stub) ---
SRC="$BASE/sentinel-src"
mkdir -p "$SRC/scripts"
cat > "$SRC/scripts/quickstart" <<'QS'
#!/usr/bin/env bash
echo "E2E_QUICKSTART_REACHED pwd=$(pwd)"
exit 0
QS
chmod +x "$SRC/scripts/quickstart"
git -C "$SRC" init -q
git -C "$SRC" config user.email e2e@test.local
git -C "$SRC" config user.name e2e
git -C "$SRC" add -A && git -C "$SRC" commit -qm init
git -C "$SRC" tag v0.0.1

# 1. 実 clone + hand-off exec 到達 (既定 shallow clone)。
D1="$BASE/install1"
out1="$(env ACTRADECK_REPO="file://$SRC" ACTRADECK_INSTALL_DIR="$D1" sh "$IN" 2>&1)"; rc1=$?
[ "$rc1" = 0 ] && ok "clone→hand-off exit 0" || ng "clone→hand-off exit 0 でない (rc=$rc1): $out1"
printf '%s' "$out1" | grep -qF "Cloning"                 && ok "Cloning を実行" || ng "Cloning 非出力"
printf '%s' "$out1" | grep -qF "E2E_QUICKSTART_REACHED"  && ok "quickstart へ exec hand-off 到達" || ng "hand-off 未到達"
[ -d "$D1/.git" ]                                        && ok "install dir が実 git checkout" || ng ".git 無し (clone 失敗)"
printf '%s' "$out1" | grep -qF "pwd=$D1"                 && ok "quickstart は install dir を cwd に実行" || ng "cwd が install dir でない"

# 2. 冪等: 同 dir へ再実行 → 更新経路 (再 clone しない) + 再 hand-off。
out2="$(env ACTRADECK_REPO="file://$SRC" ACTRADECK_INSTALL_DIR="$D1" sh "$IN" 2>&1)"; rc2=$?
[ "$rc2" = 0 ]                                            && ok "再実行 exit 0 (冪等)" || ng "再実行 exit 0 でない (rc=$rc2): $out2"
printf '%s' "$out2" | grep -qF "Existing checkout found" && ok "既存 checkout を検出し更新経路へ" || ng "更新経路に入らない"
printf '%s' "$out2" | grep -qF "Cloning"                 && ng "再実行で再 clone (冪等でない)" || ok "再実行は再 clone しない"
printf '%s' "$out2" | grep -qF "E2E_QUICKSTART_REACHED"  && ok "再実行も hand-off 到達" || ng "再実行 hand-off 未到達"

# 3. foreign 非空 dir 拒否: 非空・非 .git dir へは clobber せず die。
D3="$BASE/foreign"; mkdir -p "$D3"; echo "important user file" > "$D3/keep.txt"
out3="$(env ACTRADECK_REPO="file://$SRC" ACTRADECK_INSTALL_DIR="$D3" sh "$IN" 2>&1)"; rc3=$?
[ "$rc3" != 0 ]                                          && ok "foreign 非空 dir で exit != 0" || ng "foreign dir でも成功"
printf '%s' "$out3" | grep -qF "not an ActraDeck checkout" && ok "foreign dir 拒否メッセージ" || ng "拒否メッセージ無し"
{ [ "$(cat "$D3/keep.txt" 2>/dev/null)" = "important user file" ] && [ ! -e "$D3/.git" ]; } \
  && ok "foreign dir を一切改変しない (clobber なし)" || ng "foreign dir を改変した"

# 3b. ActraDeck でない git repo 拒否 (SEC-4): .git があっても quickstart 無しなら pull せず die。
D3b="$BASE/other-repo"; mkdir -p "$D3b"
git -C "$D3b" init -q; git -C "$D3b" config user.email x@y; git -C "$D3b" config user.name x
echo unrelated > "$D3b/README"; git -C "$D3b" add -A && git -C "$D3b" commit -qm init
out3b="$(env ACTRADECK_REPO="file://$SRC" ACTRADECK_INSTALL_DIR="$D3b" sh "$IN" 2>&1)"; rc3b=$?
[ "$rc3b" != 0 ]                                          && ok "非 ActraDeck git repo で exit != 0 (SEC-4)" || ng "非 ActraDeck repo に pull してしまった"
printf '%s' "$out3b" | grep -qF "not an ActraDeck checkout" && ok "非 ActraDeck repo 拒否メッセージ (SEC-4)" || ng "SEC-4 拒否メッセージ無し"

# 4. REF (tag) checkout: full clone + checkout + hand-off。
D4="$BASE/install-ref"
out4="$(env ACTRADECK_REPO="file://$SRC" ACTRADECK_REF="v0.0.1" ACTRADECK_INSTALL_DIR="$D4" sh "$IN" 2>&1)"; rc4=$?
[ "$rc4" = 0 ]                                            && ok "REF 指定 clone→hand-off exit 0" || ng "REF 実行 exit 0 でない (rc=$rc4): $out4"
[ "$(git -C "$D4" describe --tags 2>/dev/null || echo none)" = "v0.0.1" ] && ok "REF: 指定 tag を checkout" || ng "REF: tag 不一致"
printf '%s' "$out4" | grep -qF "E2E_QUICKSTART_REACHED"  && ok "REF: hand-off 到達" || ng "REF: hand-off 未到達"

# 4b. REF 再実行の冪等 (TDA-1 回帰): detached HEAD で bare pull --ff-only が落ちない。
out4b="$(env ACTRADECK_REPO="file://$SRC" ACTRADECK_REF="v0.0.1" ACTRADECK_INSTALL_DIR="$D4" sh "$IN" 2>&1)"; rc4b=$?
[ "$rc4b" = 0 ]                                          && ok "REF 再実行 exit 0 (TDA-1: detached HEAD で落ちない)" || ng "REF 再実行が失敗 (rc=$rc4b・TDA-1 回帰): $out4b"
printf '%s' "$out4b" | grep -qF "E2E_QUICKSTART_REACHED" && ok "REF 再実行も hand-off 到達" || ng "REF 再実行 hand-off 未到達"

# 5. credential redaction (SEC-1): userinfo 入り REPO は出力へ生で出さず ***@ に redact。
#    dry-run で plan echo に到達 (clone せず)。生 token が漏れないこと + ***@ が出ることを両方確認。
#    fixture は本物の token 形 (ghp_+36英数 等) を避ける: このファイルは OSS mirror に載り
#    (prepare-oss --include '/scripts/***')、test/ 免除下でないため ghp_ 形は publish 秘匿ゲートを
#    fail-safe に弾く (SEC-6)。redact_url は URL 構造で userinfo を剥がす shape 非依存関数ゆえ
#    非 token 形でも検証 fidelity は不変 (assertion は $FAKE_SECRET の literal grep で形を問わない)。
FAKE_SECRET="NOTAREALSECRET-deadbeef-donotmatch-0000"
out5="$(env ACTRADECK_REPO="https://x-token:${FAKE_SECRET}@example.com/f.git" ACTRADECK_INSTALL_DIR="$BASE/n" sh "$IN" --dry-run 2>&1)"
printf '%s' "$out5" | grep -qF "$FAKE_SECRET" && ng "SEC-1: 生 credential が出力へ漏れた" || ok "SEC-1: 生 credential が出力に出ない"
printf '%s' "$out5" | grep -qF "***@example.com"        && ok "SEC-1: userinfo を ***@ に redact" || ng "SEC-1: redact マーカー ***@ が出ない"

# 5b. password 内の生 '@' も under-redact しない (SEC-5): curl/git は userinfo を最後の '@' まで
#     貪欲解釈する。redact_url が `##*@` で最後の '@' まで畳むため password 断片 (DEADBEEF) が
#     出力に残らないこと + ***@host に畳まれることを確認。`#*@` (最初の '@') 退行なら断片が漏れ RED。
out5b="$(env ACTRADECK_REPO="https://user:P@ss-DEADBEEF@example.com/f.git" ACTRADECK_INSTALL_DIR="$BASE/n5b" sh "$IN" --dry-run 2>&1)"
printf '%s' "$out5b" | grep -qF "DEADBEEF"               && ng "SEC-5: 生 '@' password の断片が漏れた" || ok "SEC-5: 生 '@' password 断片を漏らさない"
printf '%s' "$out5b" | grep -qF "***@example.com"        && ok "SEC-5: 生 '@' でも ***@host に畳む" || ng "SEC-5: 生 '@' で ***@host に畳まれない"

# 6. option-injection 拒否 (SEC-2): `-`始まりの REF/REPO を安全に die。
out6a="$(env ACTRADECK_REF="-q" ACTRADECK_REPO="file://$SRC" ACTRADECK_INSTALL_DIR="$BASE/n2" sh "$IN" 2>&1)"; rc6a=$?
{ [ "$rc6a" != 0 ] && printf '%s' "$out6a" | grep -qF "must not start with"; } \
  && ok "SEC-2: '-'始まり REF を拒否" || ng "SEC-2: '-'始まり REF を拒否しない (rc=$rc6a): $out6a"
out6b="$(env ACTRADECK_REPO="--upload-pack=touch /tmp/pwned" ACTRADECK_INSTALL_DIR="$BASE/n3" sh "$IN" --dry-run 2>&1)"; rc6b=$?
{ [ "$rc6b" != 0 ] && printf '%s' "$out6b" | grep -qF "must not start with"; } \
  && ok "SEC-2: '-'始まり REPO を拒否" || ng "SEC-2: '-'始まり REPO を拒否しない (rc=$rc6b): $out6b"

echo
if [ "$fail" = 0 ]; then echo "install e2e: ALL PASS"; else echo "install e2e: FAILURES"; fi
exit "$fail"
