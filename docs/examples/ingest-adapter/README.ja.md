# ingest-adapter — 最小の ActraDeck 取込アダプタ例

> English (canonical): [README.md](./README.md) — synced to this content as of commit 29fddce. 変更は EN 正典を先に更新し、本ファイルを追従させること。

任意の外部ツール/CLI の stdout を [ActraDeck 公開取込コントラクト](../../ingestion-contract.ja.md)
の NormalizedEvent へ写像し、backend の `POST /ingest` へ直接送る、**依存ゼロ (Node 組込みのみ)**
の単一ファイル実装です (`adapter.mjs`)。

自分のツールを ActraDeck に載せるための最小テンプレートとして使えます。

## 何をするか

外部ツールの stdout 各行を、次のように ActraDeck のイベントへ写像します:

| タイミング | 送るイベント |
|---|---|
| 起動時 | `session.started` + `command.started` |
| stdout 1 行ごと | `command.output.delta` |
| EOF (プロセス終了) | `command.completed` + `session.ended` |

- `provider` は自分のツールの **slug** (WHO・`^[a-z][a-z0-9_-]{0,31}$`)。
- `source` は必ず **`external`** (HOW・第三者直取込)。
- `event_id` は UUIDv7 を自前採番 (ActraDeck は UUIDv7 のみ受理)。
- 入力行はそのまま端末にも pass-through するので、既存のパイプに割り込ませても表示は保てます。

## 前提

- Node.js 20+ (グローバル `fetch` と `node:crypto` / `node:readline` を使用)。
- 稼働中の ActraDeck backend (ローカル開発なら `apps/backend`)。その `INGEST_TOKEN` を控えておく。

## 実行方法

```bash
# 1) backend の取込トークンと URL を設定
export INGEST_TOKEN="<backend の INGEST_TOKEN と同じ値>"
export ACTRADECK_INGEST_URL="http://127.0.0.1:55410"   # backend の HTTP ポート

# 2) 自分のツールの provider slug (省略時 example_tool)
export ACTRADECK_PROVIDER="my_tool"

# 3) 任意のコマンドの出力をパイプで流し込む (第1引数は表示ラベル)
my-cli --do-stuff | node adapter.mjs "my-cli --do-stuff"
```

cockpit を開くと、`provider=my_tool` / `source=external` のセッションがライブ表示され、
コマンド出力が delta として流れ、完了で終端します。

### 環境変数

| 変数 | 既定 | 説明 |
|---|---|---|
| `INGEST_TOKEN` | (必須) | backend の Bearer トークン。未設定なら exit 2。 |
| `ACTRADECK_INGEST_URL` | `http://127.0.0.1:55410` | backend のベース URL (`/ingest` を付けて POST)。 |
| `ACTRADECK_PROVIDER` | `example_tool` | 自ツールの provider slug。非 slug なら exit 2。 |
| `ACTRADECK_SESSION` | 自動採番 | canonical session_id を固定したい場合に指定。 |

第1コマンドライン引数は `command.started` / `command.completed` の表示ラベルになります。

## 動作確認 (この例が実際に通ることの検証)

このアダプタは隔離 backend (spare ポート + 実 PostgreSQL) に対して実走検証済みです:

```bash
# 例: 実コマンドの出力を流す
git log --oneline -3 | node adapter.mjs "git log --oneline -3"
# => events に session.started / command.started / command.output.delta×3 /
#    command.completed / session.ended が provider=my_tool・source=external で着地する
```

秘匿値を含む行を流しても、**backend の ingress redaction 床**が保存前にマスクします
(コントラクト §5)。例えば `ghp_...` トークンを含む行は PG に `[REDACTED:github-token]` として
着地し、raw 値は保存されません (アダプタ側の追加実装は不要)。ただしアダプタ側でも不要な機微情報は
そもそも送らないのが安全です。

## 注意 (production 品質にするには)

この例は**最小**です。実運用アダプタでは次を検討してください:

- **バッチ送信**: 1 行 1 POST ではなく、`command.output.delta` を配列でまとめて `POST /ingest`
  (バッチ受理) に送りスループットを上げる。
- **再送/バックオフ**: `fetch` 失敗時のリトライ (冪等キー = `event_id` なので安全に再送可)。
- **豊富な写像**: ツール固有のイベント (ファイル差分・承認要求・ツール呼び出し) を、対応する
  `event_type` (`file.change.proposed` / `tool.permission.requested` 等) へ写像する。
  `event_type` は closed enum ゆえ、未知の種別は正規化してから送る (コントラクト §4.3)。
