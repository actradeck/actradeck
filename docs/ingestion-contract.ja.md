# ActraDeck 公開取込コントラクト (Public Ingestion Contract)

> English (canonical): [ingestion-contract.md](./ingestion-contract.md) — synced to this content as of commit 29fddce. 変更は EN 正典を先に更新し、本ファイルを追従させること。

> Status: T3 (derived). 真実の源泉は T1 = `@actradeck/event-model` の zod schema と
> `apps/backend` の ingestion route + INV-\* テスト。本ドキュメントとコードがドリフトした場合は
> **コードが勝つ**。本ドキュメントの golden example はコントラクトテストで pin されており
> (`packages/event-model/test/inv-contract-golden.test.ts` /
> `apps/backend/test/inv-contract-golden.test.ts`)、schema が変わって example が無効化すると
> テストが RED になる。

ADR 019f2d2c (#6a 公開取込コントラクト)。

## 1. 概要

**「どんなツールも、自分の側でイベントを正規化して `/ingest` へ POST すれば ActraDeck に載る」。**

ActraDeck の取込経路 (backend の `/ingest` / `/ingest/ws`) は最初から provider 非依存です。
Claude Code / Codex 以外の任意のコーディングエージェント・CLI・スクリプトも、
本ドキュメントの [NormalizedEvent スキーマ](#4-normalizedevent-スキーマ) に沿った JSON を作って
POST するだけで、cockpit のライブ表示・監査ログ・状態機械に載ります。

この契約は **追加のみで進化** します (additive-only):

- 新しい任意フィールドは optional で足す (既存アダプタは無改修)。
- 開いている次元 (provider) は成長のみ、閉じた次元 (source / event_type) の値は追加のみ。
- 破壊的変更はしない。契約 version フィールドは持たない (additive 規約で不要)。

## 2. 認証

すべての `/ingest` リクエストは **Bearer トークン**認証が必須です。

```
Authorization: Bearer <INGEST_TOKEN>
```

- トークンは backend 起動時の `INGEST_TOKEN` 環境変数 (single-operator / loopback 前提)。
- **`?token=` クエリは受理しません** (URL / アクセスログ漏れの温床のため・SEC-1)。ヘッダのみ。
- 認証は upgrade / body parse の**前**に `timingSafeEqual` で検証し、不正は `401` を返します
  (WS は upgrade させません)。
- 信頼境界: INGEST_TOKEN 保持者は境界の**内側**です。ingress redaction (§5) は
  **正直なアダプタのうっかり secret を止める床**であって、境界内の敵対的 exfil 対策ではありません
  (トークン保持者は DB を直接読めるため、それを脅威として想定しません)。

## 3. 取込経路

### 3.1 HTTP POST `/ingest`

単一イベント (JSON object) または**バッチ** (JSON array) を受けます。

```
POST /ingest
Authorization: Bearer <INGEST_TOKEN>
Content-Type: application/json

<NormalizedEvent>            # 単一
または
[<NormalizedEvent>, ...]     # バッチ
```

レスポンス: `{ "results": [ <IngestAck>, ... ] }`。`results` はリクエストのイベント順。

- 全 ack が `ok:true` なら HTTP `200`、1 件でも失敗すれば `422` (部分成功でも配列で個別 ack を返す)。
- 1 件の不正 (schema 違反等) は当該 ack を `ok:false` にするだけで、他のイベントは取り込まれます。

`IngestAck` (主要フィールド):

| フィールド           | 型       | 意味                                            |
| -------------------- | -------- | ----------------------------------------------- |
| `ok`                 | boolean  | 取込成否                                        |
| `event_id`           | string   | 対象イベント (冪等キー)                         |
| `inserted`           | boolean  | 新規挿入したか (false = 冪等重複)               |
| `duplicate`          | boolean  | 既存 event_id の再送だったか                    |
| `monotonic`          | boolean  | セッション内でタイムスタンプ単調だったか        |
| `state`              | string?  | projection 後の正規化状態                       |
| `invalid_transition` | boolean? | 不正な状態遷移を検出したか (取込自体はする)     |
| `error`              | string?  | `ok:false` のときの理由 (raw secret を含まない) |

### 3.2 WebSocket `/ingest/ws`

双方向ストリーム。1 メッセージ = 1 NormalizedEvent (JSON テキストフレーム)。各メッセージに対して
1 つの `IngestAck` を返します。1 件の不正で接続は落とさず ack エラーで拒否します。
主に sidecar が push に使いますが、公開契約としても同じ形状で利用できます。

### 3.3 冪等性

`event_id` が冪等キーです (at-least-once 前提)。同一 `event_id` の再送は重複挿入されず
`inserted:false` / `duplicate:true` の ack を返します。再処理・再送しても安全です。

## 4. NormalizedEvent スキーマ

正典は `@actradeck/event-model` の `NormalizedEvent` (zod)。必須 / 任意は以下。

| フィールド                                  | 必須 | 型 / 制約                            | 説明                                                                    |
| ------------------------------------------- | ---- | ------------------------------------ | ----------------------------------------------------------------------- |
| `event_id`                                  | ✅   | UUIDv7                               | 冪等キー兼グローバル ID                                                 |
| `provider`                                  | ✅   | slug `^[a-z][a-z0-9_-]{0,31}$`       | 発生元エージェント (WHO)。§4.1                                          |
| `source`                                    | ✅   | closed enum                          | 取込経路 (HOW)。§4.2                                                    |
| `session_id`                                | ✅   | 非空 string                          | 観測対象 run の canonical 識別子 (join キー)                            |
| `event_type`                                | ✅   | closed enum                          | イベント種別 (意味)。§4.3                                               |
| `timestamp`                                 | ✅   | ISO8601 (UTC)                        | 発生時刻                                                                |
| `state`                                     |      | 正規化状態 enum                      | `running.*` / `waiting.*` / terminal 等。delta/heartbeat は省略可       |
| `provider_session_id`                       |      | string                               | provider が発行した raw session id (相関用・projection key にしない)    |
| `capture_mode`                              |      | `managed`\|`attach`\|`codex_rollout` | 観測モード (表示専用)                                                   |
| `permission_mode`                           |      | string                               | sandbox / 権限モード (表示専用)                                         |
| `thread_id` `turn_id` `agent_id`            |      | string                               | 相関メタ                                                                |
| `cwd`                                       |      | string                               | 作業ディレクトリ                                                        |
| `summary`                                   |      | string                               | 人間可読の一行要約 (タイムライン用)                                     |
| `payload`                                   |      | object                               | `event_type` 整合の構造化 record (省略時 `{}`)                          |
| `metrics`                                   |      | object                               | `elapsed_ms` / `tokens_in` / `tokens_out` / `cost_usd` 等 (省略時 `{}`) |
| `redaction_count` `redaction_count_by_kind` |      | 非負整数 / record                    | §5 参照。**client 申告は信用されず backend が権威再導出する**           |
| `seq`                                       |      | 非負整数                             | 任意の per-session ドロップ検知カウンタ。§4.4 参照。                    |

### 4.1 provider = WHO (slug 開放)

`provider` は「どのエージェント CLI か」を表し、**slug で開放**されています。

- 正規表現: `^[a-z][a-z0-9_-]{0,31}$` (小文字英字始まり・`[a-z0-9_-]`・全体 1〜32 文字)。
- 既知値 `claude_code` / `codex` の意味論は不変。未知 slug (例 `my_tool` / `aider`) も
  受理され pipeline を貫通し、cockpit に slug がそのままラベル表示されます。
- **regex は charset/長さの有界化であって secret 検出ではありません**: 空白 / 大文字 / 記号 /
  パス区切り / 引用符を含めず 32 文字上限ゆえ、**大半の実 secret・生パス・生コマンドは長さ・大文字・
  記号で弾かれます**。非 slug は fail-safe に reject され、保存も表示もされません。
- 正直な限界: これは有界化であって「秘匿値か」の意味判定ではありません。**32 文字以内の小文字英数
  トークン (例 `sk_live_abcdef`) は valid slug として通ります**。「secret を運べない」とは断定しません
  (秘匿値の判定は §5 の redaction 層の責務であって provider slug 規則の責務ではない)。

### 4.2 source = HOW (closed enum)

`source` は「どの取込経路で入ったか」を表し、**閉じた enum** です。

| 値           | 意味                                                            |
| ------------ | --------------------------------------------------------------- |
| `hooks`      | Claude Code hooks (HTTP)                                        |
| `app_server` | Codex App Server (JSON-RPC)                                     |
| `rollout`    | Codex TUI rollout JSONL passive tail                            |
| `sdk`        | SDK streaming connector                                         |
| `external`   | **第三者アダプタが本契約に沿って `/ingest` へ直 POST する経路** |

第三者ツールからの直取込は必ず **`source: "external"`** を使ってください。取込経路は有限の集合ゆえ、
slug 化せず単一値で「外部直取込」を意味的に正確に表します (経路詐称・drift を防ぐ)。

なお `source` は直 POST では **caller が申告する値**であり、backend は経路の実在検証をしません
(closed enum は値集合の drift を防ぐのであって、詐称防止ではありません)。例えば直 POST するアダプタが
`source: "hooks"` を申告しても backend はそれを受理します。`source` は「どの経路と主張しているか」を
表す表示・分類用のメタであり、認証・認可の判断には使いません (それは INGEST_TOKEN の責務・§2)。

### 4.3 event_type = 意味 (closed enum・開放しない)

`event_type` は projection の状態機械 (reducer が各 type に状態遷移を結線) が意味を持つため、
**閉じたまま**です。未知の `event_type` を受理すると状態遷移が静かに欠落する correctness ホールに
なるため、**正規化はアダプタ側の責務**です。自分のツールのイベントを、下記のいずれかへ写像してから
POST してください (未知 type は reject されます):

<!-- EVENT-TYPES:START -->

`session.started` `session.ended` `turn.started` `turn.plan.updated` `turn.completed`
`turn.failed` `agent.message.delta` `agent.reasoning_summary.delta` `tool.started`
`tool.output.delta` `tool.completed` `tool.failed` `tool.permission.requested`
`tool.permission.resolved` `command.started` `command.output.delta` `command.completed`
`file.change.proposed` `file.change.approved` `file.change.applied` `diff.updated`
`mcp.call.started` `mcp.call.completed` `web.search.started` `subagent.started`
`subagent.completed` `context.compacted` `heartbeat` `stalled.detected` `error`

<!-- EVENT-TYPES:END -->

(この一覧は `@actradeck/event-model` の `ALL_EVENT_TYPES` と **集合一致**することを契約テスト
`inv-contract-golden.test.ts` が pin する — doc 側で列挙が増減/typo すると RED になる。)

### 4.4 seq = ドロップ検知カウンタ (任意)

external adapter は at-most-once で取り込み、イベントを **silent に drop** しうるため、ActraDeck は本来
「adapter は送ったが store に無い」中間イベントを検知できません。adapter が **per-session `seq`** —
**同一 `session_id` 内で 0 起点・1 ずつ増分する非負整数** — を全 emit に載せると、backend は受信した seq
集合の穴から欠落を **下限**で検知できます:

```
missing_lower_bound = (max_seq − min_seq + 1) − distinct(seq)
```

これは cockpit の監査カバレッジ・パネルに provider 単位で出ます (hedged な `欠落 ≥N?` chip)。

- **任意・additive**: `seq` を省略 (既存 adapter) しても完全に後方互換で、そのイベントは単に **検知対象外**
  になります。非負整数のみ受理します。
- **重複は collapse**: 同一 `seq` の再送 (at-least-once retry) は欠落を捏造しません — `distinct(seq)` が
  吸収します (`event_id` 冪等・§3.3 と対称)。
- **密性前提**: `seq` は **per-session の連続(dense)カウンタ**である必要があります。そうでない場合
  (session 跨ぎの global カウンタ誤用や sparse/ランダム値) は区間が膨張し、下限が無意味な巨大値になります。
  そのため backend は **区間の過半が穴** の session (密性前提違反) の欠落信号を **抑制** します。検知は
  adapter が「per-session 連番」規約を守るときにのみ有効です。
- **正直な限界 — これは *下限*です**: **末尾 drop** (受信した最大 `seq` より後ろ) と **先頭 drop** (最小
  `seq` より前) は **原理的に検知不能** — 区間が縮むだけです。検知できるのは受信区間 `[min, max]` の
  **内部の穴**だけで、真の欠落数はこれ以上でありえます。backend は `seq` を **再導出しません** (redaction
  件数と異なり、順序情報は client のみが持つため) — 申告値をそのまま保存し、信頼境界は §2 と同じ
  (single-operator / INGEST_TOKEN) です。件数のみで生の内容は運びません。
- **抑制は無償ではない — 実際の大量 drop は非密カウンタと区別できない**: 規約準拠 adapter でも、受信区間の
  **過半を失う**実ドロップは非密カウンタの誤用と **区別できない**ため同様に抑制されます。その session は
  `seq_missing_lower_bound` へ **0** しか寄与せず、欠落数としてではなく `seq_suppressed_session_count`
  (診断カウント) で **のみ** 表面化します。つまり抑制は「偽の巨大警報を避ける」代わりに「極端に大きな
  drop の検知」を手放すトレードオフです — 下限だけでなく抑制カウントも見てください。

## 5. Ingress redaction 床 (保存前 redaction)

redaction の choke point は **2 層**あります:

1. sidecar の `EventSink.emit` (sidecar 経由の全イベント)。
2. backend の ingress (直 POST 含む全イベント)。

**直 POST するアダプタは sidecar を経由しない**ため、backend は `/ingest` で受けた
すべてのイベントに対し、`store.ingest` (PG 書込) の**前**に無条件で secret redaction を適用します
(共有 `@actradeck/redaction`)。したがって:

- あなたのアダプタが誤って secret を含むイベントを送っても、raw secret は PG に着地しません
  (`[REDACTED:<kind>]` マーカーへ置換されてから保存されます)。
- `redaction_count` / `redaction_count_by_kind` は **backend が実マーカー数から権威再導出** します。
  **client が申告した count 値は信用されず上書きされます** (count spoof を封じる)。これらは
  redaction 件数 (非負整数・kind 別) のみで、**秘匿値そのものは一切含みません**。
- 既に `[REDACTED:*]` マーカーを含むイベントを再送しても、マーカーは低エントロピーで secret ルールに
  再マッチしないため二重マスクされません (冪等)。

これは「正直なアダプタのうっかり secret を止める床」であり、sidecar 経路との redaction 対称性の
回復です。§2 の信頼境界のとおり、境界内の意図的 exfil への耐性は主張しません。

## 6. Golden example

以下は `provider` に未知 slug (`my_tool`)・`source: "external"` を使った、実際に `/ingest` へ通る
最小イベントです。この JSON はコントラクトテストで `parseEvent` に通され、実 PG の `/ingest` へ
POST して挿入されることまで検証されています (schema 変更で無効化すると CI が RED)。

<!-- GOLDEN-EVENT:START -->

```json
{
  "event_id": "0192f8a0-1234-7abc-89de-f01234567890",
  "provider": "my_tool",
  "source": "external",
  "session_id": "my-tool-run-2026-07-04-abc123",
  "seq": 0,
  "event_type": "command.started",
  "state": "running.command_executing",
  "timestamp": "2026-07-04T12:34:56.789Z",
  "cwd": "/home/dev/project",
  "summary": "Running build for my_tool",
  "payload": {
    "kind": "command.started",
    "command": "npm run build",
    "cwd": "/home/dev/project",
    "risk_level": "low"
  },
  "metrics": { "elapsed_ms": 0 }
}
```

<!-- GOLDEN-EVENT:END -->

`curl` での送信例:

```bash
curl -sS -X POST "$ACTRADECK_INGEST_URL/ingest" \
  -H "Authorization: Bearer $INGEST_TOKEN" \
  -H "Content-Type: application/json" \
  --data-binary @golden-event.json
# => {"results":[{"type":"ack","ok":true,"event_id":"0192f8a0-...","inserted":true,...}]}
```

## 7. 実働アダプタ例

`docs/examples/ingest-adapter/` に、外部ツールの行イベントを NormalizedEvent へ写像して直 POST する
最小の Node アダプタ (単一ファイル) があります。`provider` に slug・`source: "external"` を使います。
実行方法は同ディレクトリの `README.md` を参照してください。

`docs/examples/opencode-adapter/` は **実プロダクト (opencode) 向けの外部アダプタ第1号**です。opencode の
plugin フック (event bus + `tool.execute.before/after`) をライフサイクル毎の NormalizedEvent
(`session.started` / `turn.started` / bash は `command.started`・`command.completed`(exit code)・
bash 以外の tool は `tool.started`・`tool.completed` / `agent.message.delta` / `diff.updated`(counts のみ) /
`error`(封筒最小化) / `turn.completed(idle)`) へ写像します (`provider=opencode` / `source=external` /
observe-only)。写像の全表は同ディレクトリ `README.md` §3 を参照してください。REAL 捕獲 fixture で駆動する契約
テスト `INV-OPENCODE-ADAPTER-*` (`packages/event-model/test/inv-opencode-adapter.test.ts`) を伴います。
写像表・ローカル実走手順・**backend 床が唯一の redaction 防御である旨の正直な開示**は同ディレクトリの
`README.md` を参照してください。

`docs/examples/gemini-adapter/` は **実プロダクト (Gemini CLI) 向けの外部アダプタ第2号**です。opencode
plugin と違い、これは Gemini の **hook `command`** — **1 イベントにつき 1 回起動される短命プロセス** —
で、Gemini のライフサイクル hook を NormalizedEvent へ写像します (`session.started` / `turn.started` /
`run_shell_command`→`command.started`・`command.completed` / 他 tool→`tool.started`・`tool.completed` /
`turn.completed(idle)` / `session.ended`) (`provider=gemini` / `source=external` / observe-only・
never-deny: stdout は常に `{}`)。Gemini は **実終端シグナル** (`SessionEnd`) を持つため `session.ended`
は正当に発行されます (SessionEnd 由来のみ・捏造しない)。契約テスト `INV-GEMINI-ADAPTER-*`
(`packages/event-model/test/inv-gemini-adapter.test.ts`) と backend 統合テスト
(`apps/backend/test/inv-gemini-lifecycle.test.ts`) を伴い、どちらも Gemini CLI 0.42.0 の REAL 捕獲で
駆動されます。写像表・正準 hook 設定・**backend 床が唯一の redaction 防御である旨の正直な開示**は
同ディレクトリの `README.md`（日本語は `README.ja.md`）を参照してください。
