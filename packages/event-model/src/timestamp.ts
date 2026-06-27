/**
 * ISO8601 timestamp の検証 + セッション内単調性チェック (T1 正典).
 *
 * plan.md §6 の例は "2026-05-30T12:34:56.789Z" (UTC, ミリ秒)。内部は UTC ISO8601 を
 * 正典とする。zod v4 の z.iso.datetime には型ポータビリティの既知 issue (#4491) があり、
 * また「セッション内単調性 (INV-EVENT-MONOTONIC)」は zod の範囲外の状態付き検証のため、
 * ここで自前の薄いバリデータ + チェッカを持つ (OTLP 等外部仕様に内部モデルを依存させない)。
 */
import { z } from "zod";

/**
 * ISO8601 / RFC3339 の UTC タイムスタンプか判定する。
 * 受理: 日付・時刻・任意のミリ秒(任意桁) + "Z" または明示オフセット。
 * Date.parse で解釈可能であることも要求する (見かけ上正しいが無効な日付を弾く)。
 */
const ISO8601_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

export function isIso8601(value: string): boolean {
  if (!ISO8601_RE.test(value)) return false;
  const ms = Date.parse(value);
  return Number.isFinite(ms);
}

/** timestamp 用 zod schema (ISO8601 文字列)。 */
export const Timestamp = z
  .string()
  .refine(isIso8601, { message: "timestamp must be an ISO8601 datetime" });
export type Timestamp = z.infer<typeof Timestamp>;

/** ISO8601 文字列を epoch ミリ秒に変換 (比較用)。 */
export function toEpochMs(iso: string): number {
  return Date.parse(iso);
}

/**
 * セッション内 timestamp 単調性チェッカ (INV-EVENT-MONOTONIC).
 *
 * at-least-once / 再送前提のため、同一時刻 (>=) は許容し、時間の巻き戻り (<) のみを
 * 違反とする。session_id ごとに「直近に観測した最大 timestamp」を保持する。
 *
 * 用途: ingestion で順序整合を診断 (断定ではなく検出)。reducer はこれで out-of-order
 * を検知し、再処理 / ログ出力を判断できる。
 */
export class MonotonicTimestampChecker {
  private readonly lastBySession = new Map<string, number>();

  /**
   * イベントを 1 件投入し、単調 (>= 直近) なら true。
   * 巻き戻り (新 < 直近) の場合は false を返し、内部の最大値は更新しない。
   */
  accept(sessionId: string, isoTimestamp: string): boolean {
    const ms = toEpochMs(isoTimestamp);
    if (!Number.isFinite(ms)) return false;
    const last = this.lastBySession.get(sessionId);
    if (last !== undefined && ms < last) {
      return false; // 巻き戻り = 違反
    }
    if (last === undefined || ms > last) {
      this.lastBySession.set(sessionId, ms);
    }
    return true;
  }

  /** セッションの直近最大 timestamp (epoch ms)。未観測なら undefined。 */
  lastSeen(sessionId: string): number | undefined {
    return this.lastBySession.get(sessionId);
  }

  /** セッションの追跡状態をリセット (セッション終了時の解放用)。 */
  reset(sessionId: string): void {
    this.lastBySession.delete(sessionId);
  }
}

/**
 * 上限付き (bounded LRU) セッション単調性チェッカ (TDA-3 対策).
 *
 * 素の {@link MonotonicTimestampChecker} は session_id ごとに最大 timestamp を Map に
 * 常駐保持する。long-running な ingestion プロセスでは distinct session_id が単調増加し、
 * terminal で reset() を呼ばない限り Map が **無制限に増加** (メモリリーク) する。
 *
 * 設計判断: **terminal での単純 reset は採らない**。ActraDeck は at-least-once / 再送前提で
 * あり、session.* 終了イベントの後に遅延・重複・巻き戻りイベントが届きうる。terminal で
 * エントリを消すと、その後の巻き戻り (時刻逆行) を検出できず INV-EVENT-ORDER の診断能力を
 * 失う。代わりに **LRU 上限 + 任意 TTL** で bounded 化する:
 *  - 直近にアクセスされた capacity 件のみ保持 (活動中セッションは確実に残る)。
 *  - 上限超過時は least-recently-used を退避 (古い静止セッションから落とす)。
 *  - TTL 指定時は、参照時に最終アクセスから ttlMs を超えたエントリを失効扱いにする
 *    (= 未観測と同じ。新規として受理し、巻き戻り誤検出しない)。
 *
 * 退避済みセッションが後で再登場した場合は「未観測」として扱われる (last=undefined →
 * 受理)。これは bounded 化の許容トレードオフ (古い静止セッションの巻き戻り検出は諦める)。
 * 活動中セッションは LRU により保持されるため、現実的な順序診断は維持される。
 */
export interface BoundedMonotonicOptions {
  /** 保持する最大セッション数 (LRU)。既定 10_000。 */
  readonly maxSessions?: number;
  /** エントリの生存時間 (ms)。未指定なら TTL 無効 (LRU のみで bound)。 */
  readonly ttlMs?: number;
  /** TTL 判定用の時刻源 (テスト注入用)。既定 Date.now。 */
  readonly now?: () => number;
}

export class BoundedMonotonicTimestampChecker {
  /** session_id → { 最大 timestamp(ms), 最終アクセス時刻(ms) }。Map 挿入順 = LRU 順。 */
  private readonly entries = new Map<string, { maxMs: number; touchedAt: number }>();
  private readonly maxSessions: number;
  private readonly ttlMs: number | undefined;
  private readonly now: () => number;

  constructor(opts: BoundedMonotonicOptions = {}) {
    const max = opts.maxSessions ?? 10_000;
    if (!Number.isInteger(max) || max < 1) {
      throw new Error("maxSessions must be a positive integer");
    }
    this.maxSessions = max;
    this.ttlMs = opts.ttlMs;
    this.now = opts.now ?? Date.now;
  }

  /**
   * イベントを 1 件投入し、単調 (>= 直近) なら true。巻き戻り (新 < 直近) は false。
   * 非有限 timestamp は false。アクセスのたびに LRU を更新し、上限超過分を退避する。
   */
  accept(sessionId: string, isoTimestamp: string): boolean {
    const ms = toEpochMs(isoTimestamp);
    if (!Number.isFinite(ms)) return false;

    const nowMs = this.now();
    const existing = this.peekFresh(sessionId, nowMs);
    const last = existing?.maxMs;

    if (last !== undefined && ms < last) {
      // 巻き戻り = 違反。最大値は更新しないが、LRU 的には「触れた」ので順序だけ更新する。
      this.touch(sessionId, last, nowMs);
      return false;
    }
    const nextMax = last === undefined ? ms : Math.max(last, ms);
    this.touch(sessionId, nextMax, nowMs);
    return true;
  }

  /** セッションの直近最大 timestamp (epoch ms)。未観測 / 失効 / 退避済みは undefined。 */
  lastSeen(sessionId: string): number | undefined {
    return this.peekFresh(sessionId, this.now())?.maxMs;
  }

  /** セッションの追跡状態をリセット (任意・明示解放用。bounded なので必須ではない)。 */
  reset(sessionId: string): void {
    this.entries.delete(sessionId);
  }

  /** 現在保持しているセッション数 (テスト/監視用)。常に <= maxSessions。 */
  get size(): number {
    return this.entries.size;
  }

  /** TTL 失効を考慮してエントリを取得 (失効していたら削除して undefined)。 */
  private peekFresh(
    sessionId: string,
    nowMs: number,
  ): { maxMs: number; touchedAt: number } | undefined {
    const e = this.entries.get(sessionId);
    if (e === undefined) return undefined;
    if (this.ttlMs !== undefined && nowMs - e.touchedAt > this.ttlMs) {
      this.entries.delete(sessionId);
      return undefined;
    }
    return e;
  }

  /** LRU 更新 (delete→set で最近使用へ移動) + 上限超過分を先頭 (LRU) から退避。 */
  private touch(sessionId: string, maxMs: number, nowMs: number): void {
    this.entries.delete(sessionId);
    this.entries.set(sessionId, { maxMs, touchedAt: nowMs });
    while (this.entries.size > this.maxSessions) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }
}

/**
 * 既に時系列順に並んだ列挙が単調 (>=) かを純関数で検査する。
 * テスト・バッチ検証用 (状態を持たない)。
 */
export function isMonotonicNonDecreasing(isoTimestamps: readonly string[]): boolean {
  for (let i = 1; i < isoTimestamps.length; i++) {
    const prev = toEpochMs(isoTimestamps[i - 1]!);
    const cur = toEpochMs(isoTimestamps[i]!);
    if (!Number.isFinite(prev) || !Number.isFinite(cur)) return false;
    if (cur < prev) return false;
  }
  return true;
}
