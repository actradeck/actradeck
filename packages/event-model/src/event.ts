/**
 * NormalizedEvent schema (plan.md §6, T1 正典).
 *
 * Claude Code / Codex の差異を吸収した共通イベント。Event Store (append-only) と
 * Realtime 配信契約の基礎。フィールド構成・任意/必須は plan.md §6 の例に厳密準拠する。
 */
import { z } from "zod";

import { EventType } from "./event-type.js";
import { EventId } from "./id.js";
import { Provider, Source } from "./provider.js";
import { State } from "./state.js";
import { Timestamp } from "./timestamp.js";

/**
 * metrics: elapsed_ms 等の数値計測。MVP では数値の record とし、代表キーを optional で
 * ヒント化する (looseObject で追加メトリクスを許容)。
 */
export const Metrics = z.looseObject({
  elapsed_ms: z.number().optional(),
  tokens_in: z.number().optional(),
  tokens_out: z.number().optional(),
  cost_usd: z.number().optional(),
});
export type Metrics = z.infer<typeof Metrics>;

/**
 * payload: event_type ごとに型は payload.ts の discriminated union で別途与える。
 * NormalizedEvent 上では「正規化済みの構造化 record」として緩く受理する
 * (段階導入・前方互換)。厳密判別が必要な場合は EventPayload で再パースする。
 */
export const Payload = z.looseObject({});
export type Payload = z.infer<typeof Payload>;

export const NormalizedEvent = z.object({
  /** 冪等性キー兼グローバル ID (UUIDv7)。 */
  event_id: EventId,
  provider: Provider,
  source: Source,
  /**
   * canonical session id. ActraDeck が 1 つの観測対象 agent run を識別する唯一の単位
   * (events / sessions / session_state projection / liveness 集約 / relay 所有が join するキー)。
   * managed claude では確定後 = claude の hook session_id (= provider が発行した raw id)。
   * hook 皆無経路では sidecar の暫定 fallback id (ACTRADECK_SESSION) を載せる。
   * 表示・projection の単位はあくまで本フィールド (ADR 019e9462)。
   */
  session_id: z.string().min(1),
  /**
   * provider (claude_code / codex 等) が発行した raw session id。
   * canonical `session_id` と provider の id を**明示分離**するためのメタ (ADR 019e9462)。
   * hook 経路では当面 `session_id === provider_session_id`。fallback 経路では
   * `session_id = ACTRADECK_SESSION, provider_session_id = undefined` となり出所を判別可能にする。
   * **optional**(後方互換): 既存イベント・既存 parse は本フィールド無しでも通る。backend は
   * 当面これを永続しても **projection key には使わない** (将来の相関/resume/thread 用)。
   */
  provider_session_id: z.string().optional(),
  /**
   * 観測モード (ADR 019ea476 D8)。managed = ActraDeck が起動を所有する PTY/app-server 経路、
   * attach = 起動を所有しない CC を hooks 経由で後付け capture する経路。
   * codex_rollout = Codex TUI の rollout JSONL を passive tail する観測専用経路。
   * UI が non-managed capture provenance を示すための判別子。approval relay 可否とは直交する。
   * **optional**(後方互換, 019e9462 の provider_session_id と同パターン): 既存イベント・既存 parse は
   * 本フィールド無しでも通る。**projection key には使わない** (presence/liveness は既存経路)。
   * 欠落時は managed 既定扱い (wire validator は寛容; LIVE-FOUND-3 教訓)。
   */
  capture_mode: z.enum(["managed", "attach", "codex_rollout"]).optional(),
  /**
   * 権限モード (sandbox)。Claude Code hooks の `permission_mode` 由来
   * (default / acceptEdits / bypassPermissions / plan 等)。ActraDeck は監督対象 agent の
   * 「どこまで自動許可されているか」(介入要否の手がかり) を右ペインに表示するために投影する
   * (ADR 019ea4ba D3 / 段階2)。**optional**(後方互換, capture_mode と同パターン): 既存イベント・
   * 既存 parse は本フィールド無しでも通る。**projection key には使わない** (表示専用)。
   * 値は provider が返す自由文字列 (enum 固定しない・将来モード増加に寛容)。
   */
  permission_mode: z.string().optional(),
  /**
   * このイベントの redaction が潰した `[REDACTED:*]` マーカーの件数 (secret_detected の出所)。
   * sink の唯一の choke point (redactDeep 後) で redacted ツリーを走査して観測する
   * **redacted な数値フィールド** (TDA-1: `redactDeepWithCount`)。**秘匿値そのものは一切含まない**
   * (件数のみ)。projection (packages/projection) が session 単位で bool OR (secret_detected) と
   * 合算 (secret_redaction_count) に畳む素 (ADR 019ea4ba 段階2 / INV-SECRET-DETECTED-NO-VALUE)。
   * **optional**(後方互換, permission_mode と同パターン): 既存イベント・既存 parse は本フィールド
   * 無しでも通る。欠落 = 0 件扱い。**projection key には使わない**。
   *
   * TDA-3 (名前衝突の明示・別スコープ): diff-frame の `body.diff.redaction_count`
   * (apps/sidecar/src/diff-provider.ts の DiffResult.redactionCount) とは**別物**。あちらは
   * **pull した 1 つの diff 本文**に限った件数 (その diff スコープ)、こちらは **1 event** の件数で
   * projection が session 単位へ畳む素。両者は同名だがスコープ (diff 単位 / event→session 単位) が
   * 異なる独立フィールドである。
   */
  redaction_count: z.number().int().nonnegative().optional(),
  /**
   * このイベントの redaction を **kind 別**に分解した件数 (強み(a)③ redaction 可視化)。
   * `redaction_count` と**同出所** (sink の redactDeep 後 choke point で redacted ツリーを走査し
   * `[REDACTED:<kind>]` を kind 別集計) であり、**原文非依存** (redacted な件数のみ・秘匿値は一切
   * 含まない)。kind は redactor のマーカー由来の安定 enum (例 `github-token` / `aws-access-key-id`)。
   * 正直な不変条件 (QA-1/TDA-2): `sum(redaction_count_by_kind の値) <= redaction_count`。
   *   redaction_count は全 `[REDACTED:*]` マーカー数 (countRedactionMarkersDeep)、by_kind は
   *   **既知 kind** (REDACTION_RULES 由来) に帰属した件数の部分集合 (phantom kind は除外 / SEC-2)。
   *   等号は全マーカーが既知 kind のときのみ。projection が session 単位で kind 別 merge fold する素。
   * **optional**(後方互換, redaction_count と同パターン): 既存イベント・既存 parse は本フィールド
   * 無しでも通る。欠落 = kind 別件数なし扱い。**projection key には使わない**。
   */
  redaction_count_by_kind: z.record(z.string(), z.number().int().nonnegative()).optional(),
  thread_id: z.string().optional(),
  turn_id: z.string().optional(),
  agent_id: z.string().optional(),
  event_type: EventType,
  /** 正規化状態。delta/heartbeat 等で状態を持たないイベントは省略可。 */
  state: State.optional(),
  /** ISO8601 (UTC) タイムスタンプ。 */
  timestamp: Timestamp,
  cwd: z.string().optional(),
  /** 人間可読の一行要約 (UI のタイムライン用)。 */
  summary: z.string().optional(),
  payload: Payload.default({}),
  metrics: Metrics.default({}),
});
export type NormalizedEvent = z.infer<typeof NormalizedEvent>;

/**
 * 入力 (採番前 / default 適用前) の型。event_id を呼び出し側が省略でき、
 * payload/metrics も省略できる「作成用」ビュー。
 */
export type NormalizedEventInput = z.input<typeof NormalizedEvent>;

/** 厳格パース (失敗時 throw)。ingestion の境界検証で使う。 */
export function parseEvent(input: unknown): NormalizedEvent {
  return NormalizedEvent.parse(input);
}

/** safeParse ラッパ (zod の SafeParseReturnType を返す)。 */
export function safeParseEvent(input: unknown) {
  return NormalizedEvent.safeParse(input);
}
