# Attach Mode — 既存の Claude Code を「どのディレクトリからでも」観測する

> English (canonical): [attach-mode.md](./attach-mode.md) — synced to this content as of commit 29fddce. 変更は EN 正典を先に更新し、本ファイルを追従させること。

ActraDeck の **Attach Mode** は、ActraDeck が起動を所有しない（=あなたが普段どおり起動する）
Claude Code (CC) を、後付けで観測するモードです。Sidecar が CC を PTY 子プロセスとして起動する
**Managed Mode**（`agentmon claude`）とは異なり、Attach は CC が必ず読む settings に hook を
**非破壊配線**するだけで、CC の起動方法は一切変えません。

- 仕組みの確定: ADR `019ea476`（設計）/ `019ea48a`（実装）/ `019ea499`（裁定）
- 常用パッケージング: ADR `019eac8a`（`ad-attach` + systemd）/ `019ee134`（codex 常駐）/ `019ee25e`（全スタック `actradeck`）

---

## 全スタックを 1 コマンドで常駐（推奨）— `actradeck up`

ActraDeck は 4 ティア（backend `:55410` / webui `:55400` / attach daemon / codex daemon）で構成されます。
`scripts/actradeck` は **全ティアを常駐**させるワンコマンド orchestrator です（ADR `019ee25e`）。
常駐機構は **3-way で自動選択**します（ADR `019ef084`）:

- **Linux**: `systemd --user` unit（`actradeck-*.service`）
- **macOS**: **launchd LaunchAgents**（`io.actradeck.*`・`~/Library/LaunchAgents`）— ログイン中常駐 +
  再ログイン自動起動。ログアウト後も残す常駐は root `LaunchDaemon` が要るため対象外。
  launchd 経路は experimental（構造検証済・Mac 実機での runtime 検証は募集中）。
- **どちらも無し**: foreground 実行（端末を開いたまま・Ctrl-C で全停止）。

`ad-attach` が観測 daemon を担うのに対し、`actradeck` は cockpit サーバ層も含めた
**スタック全体**を管理します。`down` / `restart` / `status` / `logs` はどの機構でも同じ動きです。

```bash
cd /path/to/ActraDeck
chmod 600 .env                 # 秘匿（INGEST_TOKEN/REALTIME_TOKEN 等）を含むので必須
./scripts/actradeck up         # 全ワークスペース build → backend+webui 常駐 → ad-attach install-all
loginctl enable-linger "$USER" # Linux のみ: ログアウト後も常駐（macOS はログインセッション常駐）
```

| コマンド | 動作 |
|---|---|
| `actradeck up` | 全ワークスペースパッケージ（共有 packages dist / sidecar dist / webui .next）をビルド → backend+webui を常駐化（systemd unit / launchd plist） → 観測 daemon を `ad-attach install-all` で常駐。 |
| `actradeck down` | 全4ティアを停止・無効化・削除。 |
| `actradeck restart` | 全4ティアを再起動（`systemctl restart` / `launchctl kickstart`）。 |
| `actradeck status` | 全4ティアの supervisor 状態（systemd unit / launchd agent）。 |
| `actradeck logs <backend\|webui\|attach\|codex>` | `journalctl -f`（systemd）/ ログファイル `tail -f`（launchd）。 |
| `actradeck doctor` | `.env` 権限 / node / linger / 4ティア unit・plist / ポート到達性を点検（秘匿は非表示）。 |
| `actradeck print-unit <backend\|webui>` | 生成 systemd unit を表示（確認用・単一ソース）。 |
| `actradeck print-plist <backend\|webui>` | 生成 launchd LaunchAgent plist を表示（print-unit の macOS twin）。 |

> **秘匿の扱い**: backend/webui unit は `.env` を node の `--env-file-if-exists` で読みます。unit 本体にも
> argv にも token の**値は載りません**（argv には `.env` の path だけ）。`ad-attach` の daemon unit と同方針。
> node を更新したら `actradeck up` を再実行して unit を更新してください（旧 node パス消滅による `203/EXEC` 回避）。

> daemon だけを常駐させたい（backend/webui は別管理）なら、下記 `ad-attach` を直接使ってください。

---

## いちばん簡単な使い方（daemon のみ）— どのディレクトリでも常時観測

「どのディレクトリからでも」は技術的に、CC が必ず読む **user scope の
`~/.claude/settings.json`** に hook を配線することを意味します（project-local 配線は
1 リポジトリしかカバーしません）。これをサービスとして常駐させます — Linux は
systemd `--user` unit、macOS は launchd LaunchAgent（`ad-attach` が自動検出。
`actradeck` と同じ 3-way: どちらも無ければ foreground）。

### 前提
1. `.env` を用意（`.env.example` 参照）。最低限、backend と**同一値**の `INGEST_TOKEN`。
   秘匿を含むので `chmod 600 .env` 推奨。
2. backend / webui が起動済み（既定 `:55410` / `:55400`）。スタックごと常駐させるなら上記 `actradeck up` が backend/webui の起動も担います。

### 一度だけ
```bash
cd /path/to/ActraDeck
chmod 600 .env                   # 秘匿（INGEST_TOKEN 等）を含むので必須
./scripts/ad-attach install      # sidecar build → systemd unit / launchd plist 配置 → 自動起動（attach）
# Codex TUI も常駐観測する場合（任意）:
./scripts/ad-attach codex install   # actradeck-codex-attach.service を配置・自動起動
# あるいは両方まとめて:
./scripts/ad-attach install-all     # attach + codex を一括常駐化
# (ログアウト中も常駐させたい場合) loginctl enable-linger "$USER"
```

`install` がやること:
- `apps/sidecar` をビルド（`dist/cli.js` 生成）。
- **Linux**: `~/.config/systemd/user/actradeck-attach.service` を**実パスで生成**（`node` 絶対パス・
  リポジトリ絶対パスを解決）。秘匿は `EnvironmentFile=-<repo>/.env` で読むため **unit 本体には書かない**。
  生成される unit の中身は `./scripts/ad-attach print-unit` で確認できます（手書きの定義は持たず
  これが単一ソースです）。unit には `TimeoutStopSec=30`（`SIGTERM` 後の graceful flush 猶予）と
  `NoNewPrivileges=yes`（観測 daemon は権限昇格不要）を付与します。
- **macOS**: `~/Library/LaunchAgents/` に reverse-DNS label（`io.actradeck.*`）の LaunchAgent plist を
  同じ方針（実パス解決・秘匿値は plist 本体に書かない）で生成します。
  `./scripts/ad-attach print-plist` が print-unit の twin です。
- 起動＋ログイン時自動起動を有効化（`systemctl --user enable --now` / `launchctl bootstrap`）。

> **`.env` の権限**: 秘匿（`INGEST_TOKEN` 等）を含むため `chmod 600 .env` を推奨します。
> `./scripts/ad-attach doctor` が緩い権限・`INGEST_TOKEN` 未設定・unit 未配置を点検します（値は表示しません）。

> **Codex 常駐（任意）**: `ad-attach codex install` は素の Codex TUI を rollout JSONL の passive tail で
> 観測する `actradeck-codex-attach.service` を配置します（codex を spawn/kill しない純観測）。
> `CODEX_HOME` や poll 間隔は `.env` か drop-in（`override.conf`）で渡します（unit 本体は既定の `codex attach`）。
> `ad-attach codex print-unit` で生成内容を確認、`ad-attach codex service logs` でログ追尾できます。

> **node を更新したら再 install**: unit / plist には `node` の絶対パスが焼き込まれます（systemd `--user`
> も launchd も対話シェルの PATH/nvm を継承しないため）。`nvm install` 等で node のパスが変わったら
> `./scripts/ad-attach install` を再実行して unit / plist を更新してください（旧パス消滅で無言停止しないため）。

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
> `ad-attach stop`（= `daemon stop`）は foreground/単発起動向けで、そのプロセスがその scope に記録された
> daemon だと確かめられたときにサービスのプロセスへ `SIGTERM` を送るため、`systemctl` の状態表示と
> 食い違うことがあります（detach 自体はどちらでも正しく行われます）。

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
- **`env` token-mode の設定**: daemon の環境と Claude Code を起動する shell の両方に、**同じ値**の
  `ACTRADECK_HOOK_TOKEN` を export してください（例: `openssl rand -hex 32` の出力）。`env` mode で
  この変数が未設定または空のとき、daemon は起動を拒否します。値は 32 文字以上 1024 文字以下で、
  ASCII の英字・数字と `. _ ~ + / = -` だけを使う必要があります。これを満たさない値では、`env` mode でも、
  変数を export した `literal` mode でも daemon は起動を拒否します（Claude Code が変数参照として扱う `$` も拒否対象です）。settings に書かれるのは `X-ActraDeck-Hook-Token: $ACTRADECK_HOOK_TOKEN`
  と `allowedEnvVars: ["ACTRADECK_HOOK_TOKEN"]` だけで、値は書かれません。daemon は Claude Code を
  起動する shell の環境を確認できません。その shell が同じ値を export していないと、そのセッションの
  hook はすべて拒否され、承認ゲートは働きません。user / project / local / managed のいずれかの
  settings で `httpHookAllowedEnvVars` が定義されている場合は、その一覧に `ACTRADECK_HOOK_TOKEN` が
  含まれている必要があります（含まれないと空のヘッダが送られ、全 hook が拒否されます）。
- **`literal` mode も export 済みの `ACTRADECK_HOOK_TOKEN` を使います**: daemon 起動時にこの変数が
  設定されていると、`literal` mode は起動ごとに新しい値を生成せずその値を採用し、settings に平文で
  書きます。変数を変えない限り、再起動しても token は変わりません。起動ごとに新しい token にしたい
  場合は、daemon の起動前に変数を unset してください。
- **既存の `env` mode 構成を現行の entry へ移す**: daemon は起動時に entry を書き直すので、稼働中の
  daemon を止め、同じ option で起動し直してください。

  ```bash
  node apps/sidecar/dist/cli.js daemon stop --scope <scope>   # 起動したディレクトリで実行する
  node apps/sidecar/dist/cli.js attach --token-mode env --scope <scope> --yes   # project-local では --yes 不要
  ```

  `project` と `project-local` の daemon は起動したディレクトリに属するので、両方のコマンドをそこで
  実行します。旧 daemon が稼働したまま `attach` を実行しても「既に稼働中」と表示されるだけで、旧 entry は
  残ります。`./scripts/ad-attach`（`stop` と `service` を含む）が操作するのは `user` scope の daemon だけです。
- **daemon が正常に終了しなかった場合**: daemon は `SIGINT` / `SIGTERM` / `SIGHUP`（実行中の端末を
  閉じたときなど）で、記録が自分のものなら自分の entry と記録を外します。記録が無い場合と、記録を読めない・
  検証できない場合は、自分の port を向いた entry だけを外し、記録はそのまま残します（検証できない場合は
  `daemon stop --scope <scope>` コマンドを表示します）。記録が別のプロセスのものなら何も変えず、scope の lock
  （後述）を取れない場合は entry を残して同じコマンドを表示します。`SIGKILL` のように処理できない形で
  終了すると、entry は settings に残り、誰も listen していない port を向いたままになります。同じ scope で
  次に起動が成功すると置き換わります。起動が拒否された場合（token の検査に通らない等）と daemon の起動に
  失敗した場合は、その scope に記録された daemon が既に終了していれば（プロセスが終了したか、その pid が
  別のプロセスに使われている）entry を外します。起動に失敗した場合は、その後で元のエラーで終了します。
  記録を読めない・検証できない場合や、記録されたプロセスがまだその daemon かを確かめられない場合は、
  拒否された起動はファイルを変更しません（記録を読めない・検証できない場合は `daemon stop --scope <scope>`
  コマンドも表示します）。外すのはその daemon に記録された port を向いた entry だけなので、同じ settings
  file で稼働中の daemon の entry は残ります。別の `HOME` で起動した daemon、bind mount 経由でその file を
  扱う daemon、entry を書いた後まだ記録を書いていない古い build の daemon も含みます。例外は、終了した
  daemon と同じ port を得た daemon で、その entry は外れます。記録された port の entry を外した後もほかの
  port を向いた ActraDeck の entry が settings に残っていれば、拒否された起動は記録を消さずに同じコマンドを
  表示します。そのコマンドを実行すると記録された daemon を止め、settings にある ActraDeck の entry を
  （ほかの port のものも含めて）すべて外します。
  記録の確認と変更は scope ごとの lock（`~/.actradeck/daemon/<key>.lock`）を保持したまま行います。同じ
  `HOME` を使い、同じ path（symbolic link は解決）から settings file を扱うこの build の daemon は、entry と
  記録を書く間も同じ lock を保持するので、その間に走った拒否された起動は待ってからその daemon に触らずに
  終わります。別の `attach` / `daemon` コマンドが lock を保持し続けていると、`attach` / `daemon start` は
  何も変えずに終了コード 1 で終わり、拒否された起動は短く待った後に諦めてファイルを変更せずにメッセージを
  表示し、`daemon stop` は何も変えずに終了コード 1 で終わります。`user` と `project`
  scope では `--yes` を付けたときだけ外し、付けていなければファイルを変更せず、外すための
  `daemon stop --scope <scope>` コマンドを表示します。`daemon stop --scope <scope>` は daemon の
  プロセスが既に終了していても、その scope の記録が残っていれば使えます。`SIGTERM` を送るのは、記録された
  daemon だと確かめられたプロセスだけです。確かめられない場合（例: 古い build が書いた記録で、その後に
  システムの時計が進んだ場合）も entry と記録は外しますが、プロセスは止めずにメッセージを表示するので、
  そのプロセスは手動で止めてください。記録を読めない・検証できない場合、`daemon stop` はどのプロセスにも
  signal を送らずに、settings にある ActraDeck の entry をすべて外し、記録を消します。`daemon stop` は、
  記録か hook token file を消せなかった場合と、読んだ後に記録が書き換わっていた場合に終了コード 1 で
  終わります。
- **daemon の記録の場所**: 記録は settings file ごとに 1 つ、`~/.actradeck/daemon/` の下にあります。
  記録は、symbolic link を解決した settings file のディレクトリと、書かれたままのファイル名で決まります。
  そのため symlink 経由のディレクトリと実体のディレクトリから起動・停止した場合は同じ daemon を指し、
  settings file 自体が別のファイルへの symbolic link の場合はそれ自身の記録を持ちます。daemon の起動中に
  settings file のディレクトリの path 上にある symbolic link を付け替えないでください。記録と daemon が
  書くファイルがずれ、終了後もそのファイルに daemon の entry が残ることがあります。ホームディレクトリでは
  `project` と `user` の scope が同じファイルを使うので、どちらの scope で起動した daemon も他方の scope で
  確認・停止でき、`--scope user` はどのディレクトリからでも使えます。
- **古い build に戻す場合**: この記録形式より前の build は、現在の build が書いた記録を読めず、その
  `daemon stop` と拒否された起動はエラーで終了します。戻す前に、現在の build で
  `daemon stop --scope <scope>` を実行してください。daemon が既に終了していて古い build がそのエラーを
  出す場合は、`~/.actradeck/daemon/` の下にあるその scope の記録ファイルを消してから古い build を
  起動してください。起動が entry を置き換えます。

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
- **承認ゲートが働くのは daemon が hook に応答できる間だけです**: Claude Code は、接続できない・
  2xx 以外が返る・timeout した HTTP hook を non-blocking なエラーとして扱い、ツール呼び出しを
  そのまま続けます。したがって次の場合、承認ゲートはツール呼び出しを止めません。
  - daemon が動いていない（停止中・再起動中・crash）。
  - hook の認証が通らない（例: `env` token-mode で、Claude Code を起動した shell が同じ
    `ACTRADECK_HOOK_TOKEN` を持っていない）。
  - hook の request body が 4 MB を超える（daemon が接続を切ります）。
  - Claude Code 側で hook が timeout する。ActraDeck は自分の承認待ちより長い hook timeout を書くので、
    これが起きるのはその timeout を短くした場合だけです。
  - settings の `allowedHttpHookUrls` が daemon の endpoint を含まない、または
    `httpHookAllowedEnvVars` が `ACTRADECK_HOOK_TOKEN` を除外している（`env` token-mode）。

  daemon が承認要求として受け付けた後の hook では、処理中のエラーは deny で返します。これとは別に、
  Claude Code では `tool.check` を扱う mod が hook の判断を上書きでき、上書きできないのは managed
  settings の hook だけです。ActraDeck の attach entry は user / project の settings にあります。

  これらを狭めるには: daemon を service として動かす（`./scripts/ad-attach install`。unit は失敗後に
  再起動します）、エージェントを無人で走らせる前に `daemon status` を確認する、無人実行では `dontAsk`
  mode を使う（hook が承認しない呼び出しのうち、本来プロンプトが出るものは実行されず deny されます）。
  daemon に届かないとき `PreToolUse` を止める変更を予定しています（[ADR 0016](adr/0016-pretooluse-command-shim-fail-closed.md)）。
- **codex は観測専用**: 素の Codex TUI は Codex Attach（`agentmon codex attach` / `ad-attach codex install`）が
  rollout JSONL を passive tail して観測します（codex を spawn/kill しない）。承認の書き戻し（interrupt/approval relay）は
  CC 経路のみで、codex には適用しません（observe-only）。これは**未実装でなく構造的な制約**です — rollout JSONL は
  append-only の事後ログで、tailer は read-only、codex TUI へ決定を差し戻すチャネルが存在しません。
- **cockpit から codex 承認を relay したいなら Managed Mode**: リポジトリで `./scripts/actradeck codex "<タスク>"`（1 コマンドの薄いラッパ
  = 内部で `agentmon codex -- "<prompt>"` = `node apps/sidecar/dist/cli.js codex -- "<prompt>"`）
  で起動すると、ActraDeck が Codex を App Server 経由で spawn し、その approval flow を cockpit カードへ中継して
  allow / deny / allow-for-session を返せます（command / file / legacy-exec / legacy-patch は allow・deny 両方向。
  タイムアウト・child 消失時は安全側 deny に倒します）。**MVP 制限（正直開示）**: `item/permissions` の profile grant は
  現状 **deny 相当（空 grant）のみ**で、cockpit からの「許可」で追加権限を付与しません（安全側・over-permit しない）。
  `acceptWithExecpolicyAmendment` / `applyNetworkPolicyAmendment` 等の advanced 変種も MVP では送出しません。
- **Managed Mode の起動サーフェス（正直開示）**: `./scripts/actradeck codex` は headless な Codex **App Server**
  を起動します（素の Codex **TUI ではない**）。プロンプトは **1 発 passthrough**（multi-turn は未配線）で、
  そのセッションの間 **foreground を占有**します（`up` の常駐 4 ティアとは別プロセス・Ctrl-C で終了）。
  前提として cockpit stack（`./scripts/actradeck up` = backend/webui）が稼働している必要があり、sidecar dist
  未ビルドなら `build` を促して停止します。**既存の Attach セッションを後から Managed へ切り替える retrofit は不可**
  （Managed は起動時に App Server 経由で spawn する経路のため）。承認 relay + 予防はこの Managed 起動でのみ有効で、
  素の Codex TUI（Attach 観測）は検知のみです。
- 完全同期は非保証（hook 駆動。詳細は [`docs/adr/0011-attach-mode.md`](./adr/0011-attach-mode.md)）。

---

## トラブルシュート

| 症状 | 原因/対処 |
|---|---|
| 一覧に出ない | backend/webui 未起動、または `INGEST_TOKEN` が backend と不一致（`ad-attach service logs` で 401 を確認）。 |
| `dist/cli.js が無い` | `./scripts/ad-attach build`（`ad-attach` は自動ビルドも試みます）。 |
| node 更新後にサービスが起動しない（`203/EXEC` 等） | unit / plist に旧 node 絶対パスが残存。`./scripts/ad-attach install` を再実行して更新。 |
| ログアウトで止まる（Linux） | `loginctl enable-linger "$USER"`。 |
| ログアウトで止まる（macOS） | LaunchAgent はログインセッション常駐（再ログインで自動復帰）。ログアウト後も残す常駐は root `LaunchDaemon` が要るため対象外。 |
| 設定を元に戻したい | `./scripts/ad-attach uninstall`（`~/.claude/settings.json` から ActraDeck hooks を detach）。 |
