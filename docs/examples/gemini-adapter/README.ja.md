# Gemini CLI hook adapter（ActraDeck 外部アダプタ第2号）

> English: [README.md](./README.md)

[Gemini CLI](https://geminicli.com) の作業を ActraDeck cockpit へ **observe-only（純観測）** で載せる、
**依存ゼロ**（Node 組込みのみ）の単一ファイル script です。Gemini CLI の hooks を
[公開 ingestion 契約](../../ingestion-contract.ja.md) の `NormalizedEvent` へ写像し、backend の
`POST /ingest` へ直接送ります。

opencode adapter（常駐 plugin）と違い、これは Gemini の **hook `command`** — つまり **1 イベントに
つき 1 回起動される短命プロセス** です。1 回の起動で stdin から 1 つの hook JSON を読み、写像し、
best-effort で POST し、終了します。

- `provider = "gemini"`（WHO・slug 開放）
- `source = "external"`（HOW・第三者直取込）
- **observe-only**: 承認 relay（allow/deny）を行わず、**deny も一切しません** — 毎回 stdout へ
  ちょうど `{}` を書き exit 0 で終わります。

公開契約が「第三者が自分の側で正規化して POST する」拡張面であることの、opencode に続く 2 例目の
実証です（ADR `019f426e-a783`）。

---

## 1. 設置

`adapter.mjs` は Gemini の hook `command` として起動されます。6 つのライフサイクル hook に対して
Gemini の設定（user スコープは `~/.gemini/settings.json`・project スコープは
`<project>/.gemini/settings.json`）へ登録します。**正準 hook 構造**（Gemini 0.42.0）は、top-level の
`hooks.<EventName>` 配列（各要素 `{ matcher, hooks: [{ type: "command", command, enabled }] }`）＋
マスタースイッチ `hooksConfig.enabled` です:

```jsonc
{
  "hooks": {
    "SessionStart": [
      { "matcher": "", "hooks": [{ "type": "command", "command": "node /ABS/PATH/adapter.mjs", "enabled": true }] }
    ],
    "BeforeAgent": [
      { "matcher": "", "hooks": [{ "type": "command", "command": "node /ABS/PATH/adapter.mjs", "enabled": true }] }
    ],
    "BeforeTool": [
      { "matcher": "", "hooks": [{ "type": "command", "command": "node /ABS/PATH/adapter.mjs", "enabled": true }] }
    ],
    "AfterTool": [
      { "matcher": "", "hooks": [{ "type": "command", "command": "node /ABS/PATH/adapter.mjs", "enabled": true }] }
    ],
    "AfterAgent": [
      { "matcher": "", "hooks": [{ "type": "command", "command": "node /ABS/PATH/adapter.mjs", "enabled": true }] }
    ],
    "SessionEnd": [
      { "matcher": "", "hooks": [{ "type": "command", "command": "node /ABS/PATH/adapter.mjs", "enabled": true }] }
    ]
  },
  "hooksConfig": { "enabled": true }
}
```

`/ABS/PATH/adapter.mjs` は本ファイルの絶対パスに置換してください。

- **hook を trust する。** Gemini は trust 済みの hook command のみ実行します。初回に一度承認します
  （`~/.gemini/trusted_hooks.json` が trust 済みエントリを記録・初回に Gemini が確認します）。
- **Claude Code から移行する場合。** Gemini の hook 構造は CC 互換で、`gemini hooks migrate
  --from-claude` が CC の hook 設定（PreToolUse→BeforeTool / PostToolUse→AfterTool /
  UserPromptSubmit→BeforeAgent / Stop→AfterAgent / SessionStart / SessionEnd）を Gemini 形式へ
  変換します。
- **設置は 1 スコープのみ**（user `~/.gemini` **または** project `.gemini` のどちらか一方・両方は不可）。
  両スコープに登録すると 1 イベントにつき **2 回**発火し、各コピーが **別 event_id** で送出します。
  backend の冪等は event_id 基準のため、この重複は吸収できません。

環境変数を設定します（Gemini が hook 用に起動するプロセスから見える必要があります）:

```bash
export INGEST_TOKEN=...                               # backend の Bearer と一致させる（必須）
export ACTRADECK_INGEST_URL=http://127.0.0.1:55410    # 省略時の既定値
```

- **`INGEST_TOKEN` が未設定なら、adapter は何も送らず `{}` / exit 0 で終わります** — 静かに無効化され、
  Gemini を一切壊しません（fail-open）。
- backend が止まっていても Gemini は正常に動きます（配送は best-effort・§3）。

### 重要な実挙動（実測・Tested-with 0.42.0）

Gemini は **TTY を検出する対話コンテキスト**（＝実際の端末セッション・シェルでの `gemini`）で hook を
発火させます。**headless / パイプされた subprocess**（TTY 無し）では tool 系 hook（`BeforeTool` /
`AfterTool` / `AfterAgent`）が発火しないことがあります。自動パイプ内ではなく実端末で配線し、cockpit に
`provider=gemini` / `source=external` として現れることを確認してください。

---

## 2. 写像表（REAL grounded）

Gemini の hook stdin → ActraDeck `NormalizedEvent`。写像の単一出所は `adapter.mjs` の純関数
`mapHookEvent()`（CLI 経路と契約テストが同じ関数を通す）。

全 hook は base `{ session_id, transcript_path, cwd, hook_event_name, timestamp }` を共有します。

| Gemini hook（stdin）                         | → NormalizedEvent（`event_type` / `state`）    | 備考                                                                                       |
| -------------------------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `SessionStart`（`source:"startup"`）         | `session.started` / `starting`                 | `cwd` を載せる                                                                              |
| `BeforeAgent`（`prompt`）                    | `turn.started` / `running.model_wait`          | 依頼要約 `payload.prompt_summary`（`summarize`・**sanity 上限のみ ~512KiB・≤200 の小 cap でない**）を載せる · raw 全文は非搭載 · **表示 ≤200 有界化は backend projection が床の後で適用**（bounded-at-storage） |
| `BeforeTool` — `run_shell_command`           | `command.started` / `running.command_executing`| `command = tool_input.command` · `request_id = tu:<hash>`                                   |
| `BeforeTool` — 他 tool（例 `read_file`）     | `tool.started` / `running.tool_preparing`      | `tool_input` を `payload.input` へ **verbatim 転送**（§3）                                  |
| `AfterTool` — `run_shell_command`            | `command.completed` / `running.model_wait`     | `request_id` が started と相関 · **`tool_response` は載せない**（§3）                        |
| `AfterTool` — 他 tool                        | `tool.completed` / `running.model_wait`        | `{kind, tool_name}` のみ · **`tool_response` は載せない**（§3）                             |
| `AfterAgent`（`prompt_response`）            | `turn.completed` / `idle`                      | 応答要約 `payload.response_summary`（`summarize`・**sanity 上限のみ ~512KiB・≤200 の小 cap でない**）を載せる · raw 全文は非搭載 · **表示 ≤200 有界化は backend projection が床の後で適用**（bounded-at-storage） |
| `SessionEnd`（`reason:"exit"`）             | `session.ended` / `completed`                  | Gemini は **実終端**シグナルを持つ · `reason` を載せる                                       |

**意図的 drop**（写像対象外）: `Notification` / `PreCompress` および未知 hook。

### call id 無しでの tool call 相関

Gemini の `BeforeTool` / `AfterTool` は `tool_name` + `tool_input` を持ちますが **call id はありません**。
本 adapter は per-event プロセス（イベント跨ぎの in-memory state を持たない）なので、`command.started`
と `command.completed` を結ぶ `request_id` は **hook 入力だけから決まる決定的関数**
`tu:<djb2(tool_name + stable(tool_input))>` です。同一 shell call の Before と After は同じ
`tool_name` + `tool_input` を持つため、同じ `request_id` にハッシュされ相関します。限界（正直な開示）:
同一 session 内で **完全に同一**の shell call が 2 回起きると `request_id` が衝突します（call id 無しで
区別不能）— at-most-once 観測での marginal な損失として許容。`tool_input`（`run_shell_command` では
`{command, description}`）は hash 入力に **含まれる**ため command も **ハッシュされます**が、`request_id`
の **値** は command を露出しません（djb2 は一方向・8hex から command を復元できません）。command 自体は
既に `payload.command` へ verbatim 搭載済みで、`request_id` が新たな開示チャネルを作るわけではありません。

### 配送セマンティクス

- **per-event at-most-once・best-effort**: ~1500ms timeout で 1 回だけ POST を試み、失敗は **silent
  drop**。ring buffer も retry もありません（短命プロセスゆえ・opencode plugin と異なる）。
- **fail-open**: あらゆる失敗（不正 JSON・写像 throw・backend 到達不能・timeout）を握り潰し、
  それでも `{}` を書き exit 0 で終わります。
- **never-deny / observe-only**: stdout は常にちょうど `{}` —
  `decision` / `continue` / `stopReason` / `hookSpecificOutput` を一切含まず、exit 2 も返しません。
  Gemini の挙動を一切変えません。

---

## 3. セキュリティ姿勢の正直な開示

- **この adapter は client 側 redaction を持ちません**（依存ゼロのため）。secret への唯一の防御は
  ActraDeck backend の **ingress redaction 床**（契約 §5・保存前に無条件適用）です。
- **「マシンを出る前に漏れない」とは謳いません。** `read_file` の `file_path`・shell の `command`
  文字列などは backend 到達前に生で送られます（loopback 内）。at-rest redaction は backend 側です。
- **源流最小化の適用範囲**（正直な開示）:
  - **適用**: `AfterTool` の `tool_response` — `run_shell_command` の `llmContent` は
    `<untrusted_context>` ラップの **コマンド出力全文 + プロセスグループ PGID** で、`returnDisplay` は
    echo 出力ですが、**いずれも載せません**。`tool.completed` は `{kind, tool_name}` のみ。Gemini の shell
    hook は exit code を返さないため `command.completed` に `exit_code` はありません（欠落は正当）。
  - **sanity 上限のみ・小 cap で truncate しない（最小化ではない・backend 床に依存）**: 依頼
    （`BeforeAgent.prompt`）と応答（`AfterAgent.prompt_response`）は `summarize`（空白畳み）で
    `payload.prompt_summary` / `payload.response_summary` に載せますが、**sanity 上限
    （`SUMMARY_SANITY_CAP` = 512KiB）のみ**で、**≤200 の小 cap では切詰めません**（ADR 019f47c2・SEC-1
    `019f47f0`）。ここで小 cap 切詰めをしてはならない理由: ≤200 の cut が secret を分断すると残 fragment が
    床の redaction ルール最小長を下回り at-rest に raw が残る（truncate-before-redact straddle leak）。よって
    raw テキスト（sanity 上限内）は `tool_response` と同じく **backend ingress 床** で redact され、**表示用の
    ≤200 有界化は床の後で backend projection**（`SUMMARY_SUBJECT_CAP`・redacted 済 文字列を slice する *別値* ·
    bounded-at-storage）が適用します。これは Claude Code の `依頼: <要約>`（UserPromptSubmit）と同じで、
    cockpit に *何をしているか*（最重要 KPI）を出すためです。plan.md の表示許可（「ユーザー依頼 / エージェントの
    公開メッセージは見せてよい」）対象で、有界化 ≠ redaction です。
  - **非適用（backend 床に依存）**: 非 shell tool（例 `read_file`）は `tool_input`（`file_path` 等）を
    `payload.input` へ **verbatim** 転送します。そこの secret は backend 床でのみ redact されます。
- **error 封筒は無し**（opencode と異なる）: Gemini に `session.error` hook は無いため、本 adapter は
  `error` イベントを出しません。opencode の ERROR-MINIMIZED に相当する最小化不変条件は、上記
  `tool_response` 最小化です（同一の positive key-allowlist + deep-walk 負照合で検証）。
- 信頼境界は **single-operator / loopback / `INGEST_TOKEN` の内側**。この境界を越える運用（別マシン・
  共有ネットワーク）へ変えるなら client 側 redaction を別途足してください。

---

## 4. 契約テスト

`packages/event-model/test/inv-gemini-adapter.test.ts` が本 `adapter.mjs` を dynamic import し、
REAL 捕獲 fixture（`fixtures/gemini-events.sample.jsonl`）を写像して不変条件
`INV-GEMINI-ADAPTER-{CONTRACT, PAYLOAD, MONOTONIC, NEVER-DENY, ENDED-ONLY-FROM-SESSIONEND, DEDUP,
MINIMIZED}` を検証します（最後の NEVER-DENY は出荷 script を実 subprocess として駆動）。加えて SEC-1
fixture 回帰（fixture に公開ミラー汚染トークンが無い pin）を含みます。backend 統合テスト
`apps/backend/test/inv-gemini-lifecycle.test.ts` は写像イベントを projection reducer + liveness 合成へ
畳み込みます（`completed` へ収束・liveness は `stalled` を過剰断定しない）。写像・配送・event-model
schema が壊れると RED になります。

> **fixture について**: `fixtures/gemini-events.sample.jsonl` は Gemini CLI **0.42.0** からの **実捕獲**
> です（最小 turn の全 8 ライフサイクル hook — `run_shell_command` 1 回と `read_file` 1 回）。
> **ローカルパスのみ中立化**（`/tmp/gemini-grounding`）し、イベント構造・キー・型は **REAL 捕獲のまま**です。

## 5. 互換性

- **Gemini CLI 0.42.0 で検証**（hook stdin payload の実形状に対して確認）。
- Gemini が **hook 形状を変更**すると、本 adapter は **fail-open ゆえ silently 送出停止**しうます
  （未知形状は drop・throw しない）。cockpit に Gemini セッションが出なくなったら、まず Gemini の
  バージョンと hook 形状の変化を疑ってください。hook は対話 TTY コンテキストで発火する点（§1）も
  想起してください（headless 実行では単に発火しないことがあります）。
