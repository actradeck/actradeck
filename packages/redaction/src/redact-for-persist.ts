/**
 * redaction 権威付与 (choke point の単一出所) — ADR 019f2d2c D3。
 *
 * イベント候補全体を redaction し、`redaction_count` / `redaction_count_by_kind` を
 * **redacted ツリーから再算出した権威値**で上書きして返す。呼び出し側 (client / adapter) が
 * 申告した count は信用せず必ず上書きする (count spoof の封じ)。
 *
 * この関数は 2 つの choke point の**唯一の実装**である (二重実装しない):
 *  - sidecar `EventSink.emit` (sink.ts) = sidecar 経路 (hooks / PTY / rollout tail) の権威。
 *  - backend `ingestOne` (ingestion-server.ts) = INGEST_TOKEN 保持アダプタの直 POST 経路の
 *    ingress redaction 床。sidecar を経由しない直 POST が raw で PG に入るのを防ぐ。
 *
 * どちらの経路でも「redaction が persist の前」という順序と、権威 count の意味論を同一に保つ
 * (security-gate-reuse-canonical-parser)。
 *
 * ## 二重適用の収束性 (SEC-1/QA-4・R1 で精緻化)
 * 再適用は **≤2 step で fixpoint に収束する** (発散ゼロ・SEC 実測)。marker `[REDACTED:*]` は
 * 低エントロピーで standalone では secret ルールに再マッチせず、`countRedactionMarkersDeep` は
 * marker を数えるだけ (既 redacted を再 POST しても marker 不変・count = マーカー数・二重マスクなし)。
 * 「完全冪等 (1 step)」ではない例外が 2 つあるが、いずれも **収束する / 非 leak**:
 *   1. **`KEY=<marker>` (credential-assignment 文脈) の再ラップ**: 例 `export TOKEN=[REDACTED:github-token]`
 *      → credential-assignment 規則が `TOKEN=` 文脈で marker 値を再マスク → `[REDACTED:credential-assignment]`。
 *      **kind 帰属が変わるだけで raw leak は無い**。かつ **現実の sidecar single-pass 出力は fixpoint**:
 *      sidecar が `export TOKEN=ghp_...` を 1 pass 適用すると credential-assignment が勝ち
 *      `export TOKEN=[REDACTED:credential-assignment]` を産む (github-token でなく) ため再適用で不変。
 *      (この不変性は sidecar 経路の 9 形の代表出力で実測確認済。)
 *   2. **`>MAX_REDACT_INPUT` の再 truncation**: 超長文字列は redaction 後に MAX_REDACT_INPUT で
 *      切り詰められる。no-op (長さ不変・不動点) になるのは **fixpoint 到達後 (2 回目以降)** であり、
 *      **pass1→pass2 で一度だけ長さが変わりうる** (marker 置換で膨らんだ後に切り詰めが効くため。
 *      実測 262169→262166→fixpoint)。以降は不変で発散しない。
 * いずれも 2 回目の適用で不動点に達し、raw secret を新たに露出しない。
 */
import { redactDeepWithCount } from "./redactor.js";

/**
 * @param input redaction 前のイベント候補 (object を想定。非 object はそのまま返し、
 *   後続の `parseEvent` が T1 で拒否する)。
 * @returns redacted な object に権威 `redaction_count` / `redaction_count_by_kind` を
 *   相乗せしたもの。非 object 入力は redacted 値をそのまま返す。
 */
export function redactEventWithAuthoritativeCounts(input: unknown): unknown {
  const { value, redactionCount, redactionCountByKind } = redactDeepWithCount(input);
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    // 非 object (primitive / array): 権威 count を載せる先が無い。redacted 値のみ返し、
    //   後続の parseEvent が T1 schema で拒否する (raw も redaction 済で漏れない)。
    return value;
  }
  return {
    ...(value as Record<string, unknown>),
    redaction_count: redactionCount,
    redaction_count_by_kind: redactionCountByKind,
  };
}
