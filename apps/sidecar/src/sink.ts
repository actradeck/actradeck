/**
 * EventSink — INV-REDACTION の唯一の choke point。
 *
 * 順序保証 (decision 019e8e49-d492): emit(rawEvent) は必ず
 *   (1) redact  → (2) parseEvent (検証) → (3) SQLite append → (4) WS enqueue
 * の順で実行する。raw を SQLite / WS に渡す経路は存在しない。
 *
 * 構造的保証:
 * - persist/send は private で、redact 済みの NormalizedEvent しか受け取らない。
 * - 外部に公開する API は emit() のみ。raw を直接 persist/send できない。
 * - 万一 parse 後にも残った原文があれば parse は通っても sink を抜けないよう、
 *   redact は parse の「前」に適用する (parse 失敗時でも raw を保存しない)。
 */
import {
  BoundedMonotonicTimestampChecker,
  type NormalizedEvent,
  parseEvent,
} from "@actradeck/event-model";

import { assertPayloadConsistency } from "./event-factory.js";
import { redactDeepWithCount } from "./redactor.js";
import type { EventStore } from "./store.js";
import type { WsClient } from "./ws-client.js";

/** 3#QA-2: out-of-order 観測の根拠。イベントは落とさず可視化のみ。 */
export interface OutOfOrderObservation {
  readonly session_id: string;
  readonly event_id: string;
  readonly event_type: string;
  /** 後退したイベントの timestamp (ISO8601)。 */
  readonly timestamp: string;
  /** セッションの high-water mark (epoch ms)。 */
  readonly high_water_mark_ms: number;
  /** 後退量 (ms, >0)。 */
  readonly regression_ms: number;
}

export interface EventSinkDeps {
  readonly store: EventStore;
  readonly wsClient: WsClient;
  /** 検証エラーを観測するためのフック (任意)。raw は渡さない。 */
  readonly onValidationError?: (eventType: string, message: string) => void;
  /**
   * 3#QA-2 (INV-EVENT-ORDER 最小 production 配線): セッション内 timestamp が high-water
   * mark より後退した (out-of-order) ときに呼ばれる観測フック。イベント自体は落とさず
   * persist/send する (完全な順序権威は Phase 3 State Engine)。metrics/log で可視化する。
   */
  readonly onOutOfOrder?: (obs: OutOfOrderObservation) => void;
  /**
   * QA-1 (再#2): 順序チェッカが保持する最大セッション数 (LRU 上限)。long-running daemon で
   * distinct session_id に比例した無界増加を防ぐ。既定は backend(ingest-store)と同じ 10_000。
   */
  readonly maxOrderSessions?: number;
  /**
   * QA-1 (再#2): 順序チェッカ・エントリの TTL(ms)。未指定なら LRU のみで bound。
   * 静止セッションを一定時間後に失効させたい場合に指定する。
   */
  readonly orderSessionTtlMs?: number;
}

export class EventSink {
  private readonly store: EventStore;
  private readonly wsClient: WsClient;
  private readonly onValidationError: ((eventType: string, message: string) => void) | undefined;
  private readonly onOutOfOrder: ((obs: OutOfOrderObservation) => void) | undefined;
  /**
   * 3#QA-2 / QA-1(再#2): セッション単位の timestamp 単調性チェッカ。
   * **bounded** (LRU 上限 + 任意 TTL) — backend(ingest-store)と対称に、無界 Map による
   * long-running daemon のメモリリークを防ぐ。両プロセスで order-checker が bounded である
   * 契約をコードで固定する (T1 BoundedMonotonicTimestampChecker)。
   * 注: out-of-order 観測の挙動 (INV-EVENT-ORDER, イベント非破棄) は不変。LRU で退避された
   * 静止セッションは「未観測」として扱われる (活動中セッションは保持される) のみ。
   */
  private readonly orderChecker: BoundedMonotonicTimestampChecker;

  constructor(deps: EventSinkDeps) {
    this.store = deps.store;
    this.wsClient = deps.wsClient;
    this.onValidationError = deps.onValidationError;
    this.onOutOfOrder = deps.onOutOfOrder;
    this.orderChecker = new BoundedMonotonicTimestampChecker({
      maxSessions: deps.maxOrderSessions ?? 10_000,
      ...(deps.orderSessionTtlMs !== undefined ? { ttlMs: deps.orderSessionTtlMs } : {}),
    });
  }

  /**
   * QA-1 (再#2) テスト/監視用: 順序チェッカが現在保持しているセッション数。
   * 常に maxOrderSessions 以下 (bounded 不変条件の観測点)。redact→parse→append→send
   * 経路には一切関与しない read-only アクセサ。
   */
  get orderTrackedSessions(): number {
    return this.orderChecker.size;
  }

  /**
   * 唯一の公開入口。任意の (まだ redaction されていない可能性のある) イベント候補を受け、
   * redact → parse → persist → send を一気通貫で行う。
   *
   * @returns 永続化された redaction 済み NormalizedEvent。検証失敗時は undefined。
   */
  emit(rawCandidate: NormalizedEvent | Record<string, unknown>): NormalizedEvent | undefined {
    // (1) redaction を「最初」に適用する。以降 raw は使わない。
    //   TDA-1 (hot-path): redactDeepWithCount は redactDeep と**同一の redacted 値**を返しつつ、
    //   その走査内で `[REDACTED:*]` マーカー件数を同梱する。これにより従来の二重 JSON.stringify
    //   (count 用 + store.append の永続用) のうち count 用を排し、走査 1 回で件数を得る。
    const {
      value: redacted,
      redactionCount,
      redactionCountByKind,
    } = redactDeepWithCount(rawCandidate);

    // (1') secret_detected の出所: redacted event の top-level `redaction_count` を付与する。
    //   - 観測対象は **redactDeep 適用後** の redacted のみ (raw event は一切見ない)。
    //   - count は redacted の数値ゆえ原文非依存・再 redaction 不要 (新 redaction 面を増やさない)。
    //   - 既に呼び出し側が redaction_count を載せていても、ここで走査から再計算した正準値で
    //     **上書き**する (sink が唯一の権威。観測点を choke point に固定する)。
    //   - 強み(a)③: redaction_count_by_kind も同一走査から付与する (raw は見ない・sink が権威で
    //     上書き・原文非依存)。kind 名 + 件数のみ。正直な不変条件 (round-1 方針A / QA-1 / TDA-2):
    //     **sum(by_kind) <= redaction_count**。scalar は全 `[REDACTED:*]` マーカー数
    //     (countRedactionMarkersDeep)、by_kind は既知 kind (KNOWN_REDACTION_KINDS allowlist) に
    //     帰属したマーカーの部分集合。等号は全マーカーが既知 kind のときのみ (phantom kind は除外)。
    const withCount: Record<string, unknown> = {
      ...(redacted as Record<string, unknown>),
      redaction_count: redactionCount,
      redaction_count_by_kind: redactionCountByKind,
    };

    // (2) 正規化境界の検証 (T1) + payload 判別 union 強制 (3#TDA-1)。
    //   失敗時は raw を一切残さず破棄 (kind!=event_type / union 不適合も含む)。
    let event: NormalizedEvent;
    try {
      event = parseEvent(withCount);
      assertPayloadConsistency(event);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const et =
        typeof (redacted as Record<string, unknown>).event_type === "string"
          ? ((redacted as Record<string, unknown>).event_type as string)
          : "unknown";
      this.onValidationError?.(et, message);
      return undefined;
    }

    // (3') 3#QA-2: セッション内 timestamp の単調性を観測する (INV-EVENT-ORDER 最小配線)。
    //   high-water mark より後退したら out-of-order として可視化。**イベントは落とさない**
    //   (再送・clock skew を許容し、順序権威は Phase 3 State Engine)。観測は persist 前に
    //   行い、後退時も append/send は通常どおり継続する。
    const beforeHwm = this.orderChecker.lastSeen(event.session_id);
    const monotonic = this.orderChecker.accept(event.session_id, event.timestamp);
    if (!monotonic && beforeHwm !== undefined && this.onOutOfOrder) {
      const ts = Date.parse(event.timestamp);
      this.onOutOfOrder({
        session_id: event.session_id,
        event_id: event.event_id,
        event_type: event.event_type,
        timestamp: event.timestamp,
        high_water_mark_ms: beforeHwm,
        regression_ms: Number.isFinite(ts) ? beforeHwm - ts : 0,
      });
    }

    // (3) append-only 永続化 (redaction 済みのみ)。
    this.store.append(event);

    // (4) 送信キューへ (接続中なら即 flush、断なら store に残り再送)。
    this.wsClient.notifyAppended();

    return event;
  }
}
