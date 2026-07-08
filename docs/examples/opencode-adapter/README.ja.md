# opencode plugin adapter (ActraDeck external adapter #1)

> English (canonical): [README.md](./README.md) — synced to this content as of commit 29fddce. 変更は EN 正典を先に更新し、本ファイルを追従させること。

[opencode](https://opencode.ai) の作業を ActraDeck の cockpit に **observe-only** で載せる、
依存ゼロ (Node / Bun 組込みのみ) の単一ファイル plugin です。opencode の plugin フック
(event bus + `tool.execute.before` / `tool.execute.after`) を
[公開取込コントラクト](../../ingestion-contract.ja.md) の `NormalizedEvent` へ写像し、
backend の `POST /ingest` へ直接送ります。

- `provider = "opencode"` (WHO・slug 開放)
- `source = "external"` (HOW・第三者直取込)
- **observe-only**: 承認 relay (allow/deny) は行いません。停止も断定しません。

これは公開契約が「第三者が自分の側で正規化して POST する」拡張面であることの実働実証です
(Triangle ADR `019f3c3b`)。

---

## 1. 設置

`adapter.js` を opencode の plugin ディレクトリへ置きます。

- **プロジェクト単位**: `<project>/.opencode/plugins/adapter.js`
- **グローバル**: `~/.config/opencode/plugins/adapter.js`

> **設置は 1 箇所のみ** (プロジェクト単位 **か** グローバルの一方・両方に置かない)。opencode は
> 両ディレクトリから plugin を読み込むため、両方に置くと factory が **二重起動**し、各イベントが
> 毎回 **異なる `event_id`** で二重送出されます。backend の冪等は `event_id` 単位ゆえこの重複は
> 吸収できません (§8)。

環境変数を設定します。

```bash
export INGEST_TOKEN=...                          # backend の Bearer と一致させる (必須)
export ACTRADECK_INGEST_URL=http://127.0.0.1:55410   # 省略時この既定値
```

- `INGEST_TOKEN` **未設定なら plugin は静かに無効化**されます (no-op フックを返し opencode を
  一切壊しません)。これは fail-open 設計の一部です。
- backend が起動していなくても opencode は正常に動きます (配送は fail-open・下記 §4)。

これで `opencode run "..."` / TUI いずれのモードでも、セッションが cockpit に
`provider=opencode` / `source=external` として現れます。

---

## 2. ローカルで丸ごと試す (ollama・外部アカウント不要)

完全ローカルで実 tool 実行まで動く構成です (probe で実測確立)。

1. [ollama](https://ollama.com) を起動し、tool 対応モデルを **num_ctx 16384 派生**で作ります。
   opencode は tool schema 入りの長い prompt を送るため、既定 ctx では切り詰められ tool call が
   不発になります (opencode 公式の既知の罠)。

   ```bash
   ollama pull llama3.1:8b
   # ollama 0.13.1 の `ollama create` は Modelfile を **ファイルパス**で要求します
   # (`-f -` の stdin 形式は "no Modelfile or safetensors files found" で失敗する・実測)。
   printf 'FROM llama3.1:8b\nPARAMETER num_ctx 16384\n' > /tmp/Modelfile
   ollama create llama3.1:8b-16k -f /tmp/Modelfile
   ```

   > 実測メモ: `llama3.2-vision` は tools 非対応 (400)。`qwen2.5-coder:3b/7b` は tool call を
   > JSON テキストで書くだけで実行しないことがある。`llama3.1:8b-16k` で実 tool 実行を確認済み。

2. `opencode.json` で ollama provider とモデルを指定します (probe で使った最小構成)。

   ```json
   {
     "$schema": "https://opencode.ai/config.json",
     "provider": {
       "ollama": {
         "npm": "@ai-sdk/openai-compatible",
         "name": "Ollama (local)",
         "options": { "baseURL": "http://127.0.0.1:11434/v1" },
         "models": { "llama3.1:8b-16k": { "tool_call": true } }
       }
     },
     "model": "ollama/llama3.1:8b-16k",
     "permission": { "bash": "allow", "edit": "allow" }
   }
   ```

3. adapter を `.opencode/plugins/` に置き、env を設定して実行します。

   ```bash
   opencode run "run: echo hello, then read package.json"
   ```

   cockpit に session が現れ、`command.started` / `command.completed` (exit code 付き)・
   `agent.message.delta` の streaming・`turn.completed(idle)` が観測できます。

---

## 3. 写像表 (REAL grounded・ADR D2)

opencode の観測面 (plugin フック) → ActraDeck `NormalizedEvent`。写像ロジックの単一出所は
`adapter.js` の pure 関数 (`mapEvent` / `mapToolBefore` / `mapToolAfter`) です。

| opencode 入力                                | → NormalizedEvent (`event_type` / `state`)                | 備考 |
| -------------------------------------------- | --------------------------------------------------------- | ---- |
| `session.created`                            | `session.started` / `starting`                            | `cwd = info.directory` |
| `message.updated` role=user (初回)           | `turn.started` / `running.model_wait`                     | `turn_id = messageID`・再発火は無視 |
| `message.part.delta` (field=text)            | `agent.message.delta` / `running.model_streaming`         | 各 delta は独立イベント。配送は**投入順に batch 配列化**（下記・per-messageID 統合はしない） |
| `tool.execute.before` (bash)                 | `command.started` / `running.command_executing`           | `request_id = tu:<callID>` |
| `tool.execute.after` (bash)                  | `command.completed` / `running.model_wait`                | `exit_code = metadata.exit`・**非 0 も completed**・**stdout は非搭載**（源流最小化・§4） |
| `tool.execute.before` (bash 以外)            | `tool.started` / `running.tool_preparing`                 | read/edit/write/grep/glob/webfetch 等。**tool 引数 (`args`) を最小化せず転送**（§4・QA-5） |
| `tool.execute.after` (bash 以外)             | `tool.completed` / `running.model_wait`                   | **tool 出力は非搭載**（源流最小化・§4） |
| `session.diff`                               | `diff.updated`                                            | **counts のみ**・生 diff は送らない |
| `session.error`                              | `error`                                                  | payload は `{kind, message, retryable}` のみ (`kind = "error"`・下記 §5) |
| `session.idle`                               | `turn.completed` / `idle`                                 | **session.ended を捏造しない** (ADR D8) |

**意図的 drop** (写像しない): `session.status` / `session.updated` / `message.updated` role=assistant
(metrics harvest) / `message.part.updated` の tool 部分 (hook が authoritative・callID 重複) /
text・step-start・step-finish part / `catalog.updated` / `integration.updated` / `plugin.added` /
`reference.updated`。

### 配送意味論

- **fail-open**: フックは enqueue のみ (配送を await しない)。全 POST は try/catch + fetch timeout。
- **有界リングバッファ** (cap 1000・最古 drop)。**再送上限 + backoff** 後は drop。
- **at-least-once + 冪等**: 再送は同一 `event_id` (UUIDv7) を使い、backend が二重挿入を吸収します。
- **session 毎 monotonic timestamp floor**: 再送・並び替え・時刻源の巻き戻りがあっても、同一
  session の発行 timestamp を非減少に保ちます。

---

## 4. セキュリティ姿勢の正直な開示 (ADR D4)

- **この adapter は client 側 redaction を持ちません** (依存ゼロのため)。secret に対する唯一の
  防御は ActraDeck **backend の ingress redaction 床** ([契約 §5](../../ingestion-contract.ja.md#5-ingress-redaction-床-保存前-redaction)・
  保存前に無条件適用) です。
- **「マシンを出る前に漏れない」とは謳いません。** secret を含む `tool` 引数や command 文字列は、
  backend に着く前は素のまま送られます (loopback の内側)。at-rest で redaction されるのは backend 側です。
- 源流での最小化 (§5 の error 封筒破棄・§3 の diff counts のみ) は **「最小化」であって
  「redaction」ではありません**。この 2 つは区別してください。
- **源流最小化を適用する所と、しない所**（正直な範囲開示）:
  - **適用する**: `session.error` の封筒破棄（§5）/ `session.diff` は counts のみ / `command.completed`
    は exit code のみで **stdout 本文を載せない** / `tool.completed` (bash 以外) は **tool 出力を載せない**。
  - **適用しない (backend 床に依存)**: **bash 以外の tool (`read`/`edit`/`write`/`grep`/…) は
    `tool.execute.before` の引数 (`args`) を最小化せず verbatim 転送します** (QA-5)。`write`/`edit` の
    `content`・`read` の `filePath` 等がそのまま送られ、secret は backend 床でのみ redaction されます。
    **`read`/`write`/`edit`/`webfetch` は grounding 済** (実 opencode run から捕獲・QA-5・§6) で、実引数
    形状は実測です (前提でなく)。機微を含む編集を扱うなら §4 冒頭の免責を再確認してください。
- **観測の限界 (QA-7)**: opencode は **session 終端シグナルを持たない**ため adapter は `session.ended`
  を **一切発行しません** (§3 の `session.idle` → `turn.completed(idle)`)。cockpit の「終わったか」判断は
  `turn.completed(idle)` の settling 信号 + liveness 合成 (process/event/stdout heartbeat) が担い、
  停止は断定されません。
- 信頼境界は **single-operator / loopback / `INGEST_TOKEN` の内側**です。この境界を越えて
  (別マシン・共有ネットワーク) 使う運用へ変えるなら、client 側 redaction を別途足してください。

## 5. `session.error` の源流最小化

opencode の `session.error` は `responseHeaders` / `responseBody` / `metadata.url` (モデル
エンドポイント URL) を含みます。adapter はこれらを **一切読まず**、安全な最小フィールド
`{error.name, error.data.message, error.data.isRetryable}` だけを構造的に抽出します。**払い出す
payload は closed allowlist `{kind, message, retryable}` に閉じ** (`name` は表示専用 `summary` へ畳み、
`statusCode` は載せません)、余剰キーが混入すると `INV-OPENCODE-ADAPTER-ERROR-MINIMIZED` が RED に
なります (positive key-allowlist + 封筒値の deep-walk 負照合の二段検証)。

---

## 6. 契約テスト

`packages/event-model/test/inv-opencode-adapter.test.ts` が本 `adapter.js` を dynamic import し、
REAL 捕獲 fixture (`fixtures/opencode-events.sample.jsonl`) を写像して不変条件を検証します:
`INV-OPENCODE-ADAPTER-{CONTRACT, PAYLOAD, MONOTONIC, NO-TERMINAL-FABRICATION, DEDUP, ERROR-MINIMIZED}`
＋ 配送層 (有界リング最古 drop / retry 上限 drop / token 未設定で無効 / 投入順保存) ＋ SEC-1 回帰
(fixture に公開ミラー汚染トークンが無いことの pin)。写像・配送・event-model schema が壊れると RED になります。

> **fixture について**: `fixtures/opencode-events.sample.jsonl` は probe の**実捕獲**イベントを trim
> したものですが、ローカルパス等の**値のみ neutral 化** (`/home/user/.claude/jobs/...` →
> `/tmp/opencode-...`) しています。**イベント構造・キー・型は REAL 捕獲のまま**で、値だけを差し替えて
> います (R1 裁定 019f3c5e・SEC-1)。

## 7. 互換性

- **Tested with opencode 1.17.14** (plugin フック `event` / `tool.execute.before` / `tool.execute.after`
  の実形状で検証)。
- opencode が **plugin event の形状を変更**すると、本 adapter は **fail-open ゆえ静かに発行を停止しうる**
  (未知形状は drop されエラーも投げない)。cockpit に opencode セッションが現れなくなったら、まず
  opencode のバージョンと event 形状の変更を疑ってください (TDA-4a)。

## 8. plugin ローダの semantics (default 単独 export の理由)

opencode 1.17.14 の plugin ローダの実挙動は、公式 docs の記述と乖離しています
(実測・E2E-1 / E2E-1b)。**実挙動が正**です:

- **ローダは `.js` / `.ts` のみを走査し、`.mjs` は silent に不可視です** (成功ログも失敗ログも
  一切出ません・1.17.14 実測・E2E-1b)。公式 docs の「`.mjs` 可」は **誤り**です。**plugin ファイルは
  必ず `.js`** で設置してください (本 adapter も `adapter.js`)。拡張子を `.mjs` にすると、内容が
  正しくても**永遠にロードされません**。
- **ローダは (走査対象ファイルの) 全 export を factory として呼び出します** (named も default も両方)。
  同じ factory を named と default で二重 export すると、hook が **二重登録**されます。
- **ローダはプロジェクト単位とグローバルの両ディレクトリを走査します。** 両方
  (`<project>/.opencode/plugins/` と `~/.config/opencode/plugins/`) に置くと factory が **二重起動**し、
  各イベントが **コピーごとに異なる `event_id`** で二重送出されます。backend は `event_id` 単位で
  重複排除する (payload 内容では見ない) ため 1 つにまとめられません — **設置は 1 箇所のみ** (§1)。
- **非関数 export が 1 つでもあると、モジュール全体を silent reject します** (何も呼ばれない)。
  例えば `export const RING_CAP = 1000;` (数値) を 1 つ足すだけで、plugin ファイルごと捨てられ、
  hook が一切登録されません (エラーも出ません)。

このため **plugin ファイルは `default` 関数を 1 つだけ export** してください。本 adapter は pure
helpers / 定数を **default 関数のプロパティ**として公開し (`ActraDeckOpencodeAdapter.mapEvent = …`)、
named export を一切持ちません。`INV-OPENCODE-ADAPTER-LOADER-SAFE` が「namespace は `default` 単独
かつ関数」を回帰固定します (named / 非関数 export の再混入で RED)。

> 自分で plugin を書く場合も同じ規律に従ってください。定数・ヘルパは module スコープの
> **非 export** ローカルにするか、default 関数のプロパティにします。
