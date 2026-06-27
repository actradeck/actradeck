/**
 * 再接続バックオフ (jitter 付き指数) — reconnect storm 回避.
 *
 * WebSearch 反映 (websocket.org / oneuptime 2026):
 *  - 固定間隔リトライ禁止: サーバ再起動時に全クライアントが同位相で殺到する (storm)。
 *  - 指数バックオフ: base から factor 倍ずつ、cap で頭打ち。
 *  - **full jitter**: `random() * delay` で各クライアントのリトライ位相をばらす (脱同期)。
 *  - 無限リトライ禁止: 上限試行で諦める (既定 12 回 ≒ 約 2 分でギブアップ可能)。
 *
 * 純ロジック・決定論 (RNG を注入可能) にして、境界をテストで赤化できるようにする
 * (状態と表示の分離: ここは「次に何 ms 待つか」だけを決める)。
 */
export interface BackoffOptions {
  /** 初回遅延 (ms)。既定 500。 */
  readonly baseMs?: number;
  /** 乗数。既定 2。 */
  readonly factor?: number;
  /** 上限遅延 (ms)。既定 30_000。 */
  readonly capMs?: number;
  /** 最大試行回数。これを超えたら諦める。既定 12。 */
  readonly maxAttempts?: number;
  /** [0,1) を返す乱数源 (テスト注入用)。既定 Math.random。 */
  readonly random?: () => number;
}

const DEFAULT_BACKOFF: Required<Omit<BackoffOptions, "random">> = {
  baseMs: 500,
  factor: 2,
  capMs: 30_000,
  maxAttempts: 12,
};

/**
 * 再接続スケジューラ。`nextDelayMs()` を呼ぶたび試行カウントを進め、
 * full jitter 付きの待ち時間を返す。接続成功時に `reset()` する。
 */
export class ReconnectBackoff {
  private attempt = 0;
  private readonly baseMs: number;
  private readonly factor: number;
  private readonly capMs: number;
  private readonly maxAttempts: number;
  private readonly random: () => number;

  constructor(opts: BackoffOptions = {}) {
    this.baseMs = opts.baseMs ?? DEFAULT_BACKOFF.baseMs;
    this.factor = opts.factor ?? DEFAULT_BACKOFF.factor;
    this.capMs = opts.capMs ?? DEFAULT_BACKOFF.capMs;
    this.maxAttempts = opts.maxAttempts ?? DEFAULT_BACKOFF.maxAttempts;
    this.random = opts.random ?? Math.random;
  }

  /** これまでに消費した試行回数。 */
  get attempts(): number {
    return this.attempt;
  }

  /** これ以上リトライすべきか (上限内か)。 */
  get canRetry(): boolean {
    return this.attempt < this.maxAttempts;
  }

  /**
   * 次の待ち時間 (ms)。試行カウントを 1 進める。
   * 計算: `cap(base * factor^attempt, capMs)` を上限とし、full jitter `random()*upper`。
   * 上限超過 (canRetry=false) なら `null` を返す (= 諦める)。
   */
  nextDelayMs(): number | null {
    if (!this.canRetry) return null;
    const exp = this.baseMs * Math.pow(this.factor, this.attempt);
    const upper = Math.min(exp, this.capMs);
    this.attempt += 1;
    // full jitter: 0..upper の一様乱数 (位相を散らして storm を避ける)。
    const jittered = this.random() * upper;
    return Math.floor(jittered);
  }

  /** 接続成功時に試行カウントをリセットする。 */
  reset(): void {
    this.attempt = 0;
  }
}
