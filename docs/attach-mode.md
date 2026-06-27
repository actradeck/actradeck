# Attach Mode — 既存の Claude Code を「どのディレクトリからでも」観測する

ActraDeck の **Attach Mode** は、ActraDeck が起動を所有しない（=あなたが普段どおり起動する）
Claude Code (CC) を、後付けで観測するモードです。Sidecar が CC を PTY 子プロセスとして起動する
**Managed Mode**（`agentmon claude`）とは異なり、Attach は CC が必ず読む settings に hook を
**非破壊配線**するだけで、CC の起動方法は一切変えません。

- 仕組みの確定: ADR `019ea476`（設計）/ `019ea48a`（実装）/ `019ea499`（裁定）
- 常用パッケージング: ADR `019eac8a`（`ad-attach` + systemd）/ `019ee134`（codex 常駐）/ `019ee25e`（全スタック `actradeck`）

---

## 全スタックを 1 コマンドで常駐（推奨）— `actradeck up`

ActraDeck は 4 ティア（backend `:55410` / webui `:55400` / attach daemon / codex daemon）で構成されます。
`scripts/actradeck` は **全ティアを systemd `--user` で常駐**させるワンコマンド orchestrator です
（ADR `019ee25e`）。`ad-attach` が観測 daemon を担うのに対し、`actradeck` は cockpit サーバ層も含めた
**スタック全体**を管理します。

```bash
cd /path/to/ActraDeck
chmod 600 .env                 # 秘匿（INGEST_TOKEN/REALTIME_TOKEN 等）を含むので必須
./scripts/actradeck up         # 全ワークスペース build → backend+webui を systemd 常駐 → ad-attach install-all
loginctl enable-linger "$USER" # ログアウト後も常駐（再起動跨ぎ）
```

| コマンド | 動作 |
|---|---|
| `actradeck up` | 全ワークスペースパッケージ（共有 packages dist / sidecar dist / webui .next）をビルド → backend+webui を systemd 化 → 観測 daemon を `ad-attach install-all` で常駐。 |
| `actradeck down` | 全4ティアを停止・無効化・削除。 |
| `actradeck restart` | 全4ティアを再起動。 |
| `actradeck status` | 全4ティアの systemd 状態。 |
| `actradeck logs <backend\|webui\|attach\|codex>` | journalctl -f。 |
| `actradeck doctor` | `.env` 権限 / node / linger / 4ティア unit / ポート到達性を点検（秘匿は非表示）。 |
| `actradeck print-unit <backend\|webui>` | 生成 unit を表示（確認用・単一ソース）。 |

> **秘匿の扱い**: backend/webui unit は `.env` を node の `--env-file-if-exists` で読みます。unit 本体にも
> argv にも token の**値は載りません**（argv には `.env` の path だけ）。`ad-attach` の daemon unit と同方針。
> node を更新したら `actradeck up` を再実行して unit を更新してください（旧 node パス消滅による `203/EXEC` 回避）。

> daemon だけを常駐させたい（backend/webui は別管理）なら、下記 `ad-attach` を直接使ってください。

---

## いちばん簡単な使い方（daemon のみ）— どのディレクトリでも常時観測

「どのディレクトリからでも」は技術的に、CC が必ず読む **user scope の
`~/.claude/settings.json`** に hook を配線することを意味します（project-local 配線は
1 リポジトリしかカバーしません）。これを systemd `--user` サービスとして常駐させます。

### 前提
1. `.env` を用意（`.env.example` 参照）。最低限、backend と**同一値**の `INGEST_TOKEN`。
   秘匿を含むので `chmod 600 .env` 推奨。
2. backend / webui が起動済み（既定 `:55410` / `:55400`）。スタックごと常駐させるなら上記 `actradeck up` が backend/webui の起動も担います。

### 一度だけ
```bash
cd /path/to/ActraDeck
chmod 600 .env                   # 秘匿（INGEST_TOKEN 等）を含むので必須
./scripts/ad-attach install      # sidecar build → systemd --user unit 配置 → enable --now（attach）
# Codex TUI も常駐観測する場合（任意）:
./scripts/ad-attach codex install   # actradeck-codex-attach.service を配置・自動起動
# あるいは両方まとめて:
./scripts/ad-attach install-all     # attach + codex を一括常駐化
# (ログアウト中も常駐させたい場合) loginctl enable-linger "$USER"
```

`install` がやること:
- `apps/sidecar` をビルド（`dist/cli.js` 生成）。
- `~/.config/systemd/user/actradeck-attach.service` を**実パスで生成**（`node` 絶対パス・
  リポジトリ絶対パスを解決）。秘匿は `EnvironmentFile=-<repo>/.env` で読むため **unit 本体には書かない**。
  生成される unit の中身は `./scripts/ad-attach print-unit` で確認できます（手書きの定義は持たず
  これが単一ソースです）。
- unit には `TimeoutStopSec=30`（`SIGTERM` 後の graceful flush 猶予）と `NoNewPrivileges=yes`
  （観測 daemon は権限昇格不要）を付与します。
- `systemctl --user enable --now` で起動＋ログイン時自動起動を有効化。

> **`.env` の権限**: 秘匿（`INGEST_TOKEN` 等）を含むため `chmod 600 .env` を推奨します。
> `./scripts/ad-attach doctor` が緩い権限・`INGEST_TOKEN` 未設定・unit 未配置を点検します（値は表示しません）。

> **Codex 常駐（任意）**: `ad-attach codex install` は素の Codex TUI を rollout JSONL の passive tail で
> 観測する `actradeck-codex-attach.service` を配置します（codex を spawn/kill しない純観測）。
> `CODEX_HOME` や poll 間隔は `.env` か drop-in（`override.conf`）で渡します（unit 本体は既定の `codex attach`）。
> `ad-attach codex print-unit` で生成内容を確認、`ad-attach codex service logs` でログ追尾できます。

> **node を更新したら再 install**: unit には `node` の絶対パスが焼き込まれます（systemd `--user`
> は対話シェルの PATH/nvm を継承しないため）。`nvm install` 等で node のパスが変わったら
> `./scripts/ad-attach install` を再実行して unit を更新してください（旧パス消滅で無言停止しないため）。

### 以後
```bash
cd ~/any/project
claude            # いつもどおり起動するだけ → ActraDeck の一覧に capture_mode=attach で出る
```

### 状態・停止
```bash
./scripts/ad-attach service status   # systemctl --user status（attach）
./scripts/ad-attach service stop     # サービス運用中の停止はこちら（systemctl --user stop）
./scripts/ad-attach service logs     # journalctl -f
./scripts/ad-attach uninstall        # 停止・無効化・unit 削除（settings から hooks を detach 込み）

# Codex 側 / 一括（任意）
./scripts/ad-attach codex service status   # codex サービスの状態
./scripts/ad-attach codex service logs     # codex サービスのログ追尾
./scripts/ad-attach codex uninstall        # codex サービスのみ停止・無効化・削除
./scripts/ad-attach status-all             # attach + codex の状態をまとめて表示
./scripts/ad-attach uninstall-all          # 両サービスを停止・無効化・削除
./scripts/ad-attach doctor                 # .env 権限 / node パス / unit 配置を点検（秘匿は非表示）
```

> **INGEST_TOKEN を rotate したら**: 両サービスは同一 `<repo>/.env` を `EnvironmentFile` 経由で読みます。
> token を更新したら実行中プロセスの env に反映するため `./scripts/ad-attach service restart` と
> `./scripts/ad-attach codex service restart`（または `uninstall-all`→`install-all`）を実行してください。

> サービスとして常駐させているときの一時停止は `ad-attach service stop` を使ってください。
> `ad-attach stop`（= `daemon stop`）は foreground/単発起動向けで、サービスの PID を直接落とすため
> `systemctl` の状態表示と食い違うことがあります（detach 自体はどちらでも正しく行われます）。

`stop`/`uninstall` 時の `SIGTERM` で CLI の shutdown ハンドラが
`~/.claude/settings.json` から **ActraDeck の hook entry のみ** を可逆 detach します
（あなたが追加した hooks は温存）。

---

## サービスを使わず単発で試す

```bash
./scripts/ad-attach            # .env を読み、user scope で foreground 常駐（Ctrl-C で detach）
./scripts/ad-attach stop       # 別端末から停止＋detach
./scripts/ad-attach status     # 稼働状況・endpoint・配線先
./scripts/ad-attach build      # sidecar をビルドし直す
```

`ad-attach -h` で全サブコマンドを表示します。

---

## 素の CLI（`agentmon`）で細かく制御する

`ad-attach` は下記 `agentmon attach`（= `apps/sidecar/dist/cli.js`）の薄いラッパです。

```bash
node apps/sidecar/dist/cli.js attach --scope user --yes      # user scope（どこでも）
node apps/sidecar/dist/cli.js attach --dry-run               # 配線内容を確認（書き込まない）
node apps/sidecar/dist/cli.js attach                         # 既定 project-local（このリポジトリのみ）
node apps/sidecar/dist/cli.js daemon stop --scope user
node apps/sidecar/dist/cli.js daemon status --scope user
```

scope と安全ガード:

| scope | 配線先 | 備考 |
|---|---|---|
| `project-local`（既定） | `<cwd>/.claude/settings.local.json` | gitignore 対象。1 リポジトリのみ。 |
| `project` | `<cwd>/.claude/settings.json` | 共有。`--yes` 必須。literal token-mode は **拒否**（tracked file に nonce 漏洩）→ `--token-mode env` か project-local を使う。 |
| `user` | `~/.claude/settings.json` | グローバル＝「どこでも」。`--yes` 必須。`ad-attach` はこれを使う。 |

- `user`/`project` scope は共有/グローバル設定の書き換えなので、`--yes`（または確認応答）が
  無いと**安全側 deny で中止**します。`ad-attach` は user scope に `--yes` を付けて起動します。
- token-mode は **literal 既定**。user scope は git-tracked でないため nonce 平文を置いても
  漏洩対象外で、かつ「配線するだけで効く」を保証します（`env` mode は CC 起動 shell に
  `ACTRADECK_HOOK_TOKEN` の export が必要となり「どこからでも」要件を壊します）。

---

## 承認の再起動跨ぎ永続化（Persistent Approval Allowlist・ADR 019ee0c0）

同じコマンドの承認を毎回求められる手間を、**危険でない操作に限り**減らす opt-in 機能。
UI の承認カードで「再起動後も許可」を選ぶと、その操作の署名（`sha256`・生コマンドは保存しない）が
`~/.actradeck/approvals/allowlist.json`（`0600`）へ記録され、再起動を跨いでも同一コマンド・同一 repo
なら UI を経ず自動許可されます。

**既定 OFF**。有効化と調整は環境変数で行います:

| 環境変数 | 既定 | 役割 |
|---|---|---|
| `ACTRADECK_PERSIST_APPROVALS` | （未設定=OFF） | `1` / `true` で永続化を有効化。OFF のときは記録済みエントリも honor しない（kill-switch）。 |
| `ACTRADECK_PERSIST_APPROVALS_TTL_MS` | `604800000`（7 日） | 永続 grant の TTL（自動失効）。`[60000, 7776000000]`（1 分〜90 日）に clamp。 |

**永続化の対象は「構造的に単純で危険 program を含まない」medium-risk の bash コマンドのみ**。
次は「再起動後も許可」を出さず、毎回（またはセッション内）確認のままです（恒久迂回を防ぐため）:

- high-risk（`rm -rf` 等）/ secret 混入 / `.env`・credential 編集 / MCP / WebFetch
- 合成メタ文字を含むコマンド（パイプ `|`、コマンド置換 `$(…)`/`` `…` ``、プロセス置換 `<(…)`、
  連結 `&&`/`;`、リダイレクト `>`/`<`、サブシェル）→ `curl … | sh` / `. <(curl …)` 等を構造的に除外
- 先頭 program が危険集合: 権限昇格（`sudo`/`su`/`doas`/`pkexec`）/ shell 起動（`sh -c` 等）/
  言語インタプリタ inline（`node -e`/`python3 -c`/`perl -e`/`ruby -e`/`php -r` 等の任意コード実行）/
  公開（`npm`/`pnpm`/`yarn publish`）/ network-exec（`curl`/`wget`/`ssh` 等）/ ラッパ（`env`/`xargs` 等）/
  破壊的ファイルシステム・システム変更（`chown -R`/`chgrp -R`（不可逆）/ `chmod`/`rm`/`dd`/`mv`/`ln`/`kill` 等）
- `find … -exec`/`-execdir`/`-ok`（配下で任意コマンド実行）

（例: `find /tmp/build -delete` は永続可。`sudo systemctl restart x` / `node -e "…"` / `curl … | sh` /
`chown -R me /srv` は永続不可＝毎回確認。実用上、永続可になるのは `find … -delete` のような
限定的な medium コマンドのみ。日常的な低リスク操作はそもそも承認カードを出しません。）

失効・確認は **in-UI パネル**または **CLI** の二経路で行えます（PAL-v2・ADR 019ee147）:

- **in-UI**: Cockpit の Session 詳細にある「永続承認（この端末）」パネルで一覧・失効（machine-global。
  一覧は遅延 pull、失効は POST で除去。永続化 OFF 時は dormant エントリも掃除可）。
- **CLI**:

```bash
node apps/sidecar/dist/cli.js approvals list                 # 永続承認を一覧（署名・repo・残り期限）
node apps/sidecar/dist/cli.js approvals revoke <sig|prefix>  # 署名（完全一致 or 一意プレフィックス）を失効
node apps/sidecar/dist/cli.js approvals clear                # 全永続承認を削除
```

セキュリティ前提: ストアは `file-lock` と同じく **single-operator / local-fs** 前提（`~/.actradeck`・
`0600`）。書き込み権はユーザー権限と同一信頼境界（同権限の攻撃者は元来コマンド実行可能）。

---

## 制約（Attach は起動非所有・制御限定）

- **停止制御は非対応**: Attach 対象 CC は daemon の子プロセスではないため、interrupt は
  非所有 PID を kill せず **no-op**（安全側）。
- **Claude Code の承認 relay は対応**: Claude Code Attach は hooks の応答経路で cockpit から
  allow / deny を返せます。一方で ActraDeck が起動を所有しないため、停止制御とは別物です。
- **codex は観測専用**: 素の Codex TUI は Codex Attach（`agentmon codex attach` / `ad-attach codex install`）が
  rollout JSONL を passive tail して観測します（codex を spawn/kill しない）。承認の書き戻し（interrupt/approval relay）は
  CC 経路のみで、codex には適用しません（observe-only）。
- 完全同期は非保証（hook 駆動。詳細は plan.md §11B / ADR 019ea476 D0）。

---

## トラブルシュート

| 症状 | 原因/対処 |
|---|---|
| 一覧に出ない | backend/webui 未起動、または `INGEST_TOKEN` が backend と不一致（`ad-attach service logs` で 401 を確認）。 |
| `dist/cli.js が無い` | `./scripts/ad-attach build`（`ad-attach` は自動ビルドも試みます）。 |
| node 更新後にサービスが起動しない（`203/EXEC`） | unit に旧 node 絶対パスが残存。`./scripts/ad-attach install` を再実行して unit を更新。 |
| ログアウトで止まる | `loginctl enable-linger "$USER"`。 |
| 設定を元に戻したい | `./scripts/ad-attach uninstall`（`~/.claude/settings.json` から ActraDeck hooks を detach）。 |
