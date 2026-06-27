/**
 * stdout/stderr collector — PTY 出力を `command.output.delta` 化する。
 *
 * Managed Mode では claude を PTY 子プロセスとして起動するため、その出力 stream を
 * tail する。長時間 Bash の途中 stdout を放置しない (anti-pattern) ため、出力が
 * あれば随時 delta 化し、無音が続けば idle を上流の liveness 合成に委ねる。
 *
 * PTY は stdout/stderr を分離しないため、本コレクタは stream="stdout" 固定で扱う
 * (PTY 特性。stderr 分離が必要なら pipe ベースの collector を別途用いる)。
 *
 * ⚠️ ここで作る delta 候補は EventSink.emit() に渡され redaction される。
 */
import { buildEvent } from "./event-factory.js";
import type { SessionIdentity } from "./session-identity.js";

export interface OutputCollectorOptions {
  /**
   * session 識別の権威 (ADR 019e9462)。固定 sessionId を bake せず emit 時に canonical を
   * 動的解決する。canonical 未確定の早期 PTY output は hold→確定後に発生時刻順で flush される。
   */
  readonly identity: SessionIdentity;
  readonly cwd?: string;
  /** delta をまとめる最大バッファ長 (超過で flush)。 */
  readonly maxChunk?: number;
  /** 無音 flush 間隔 (ms)。バッファに残った端数を吐き出す。 */
  readonly flushMs?: number;
  readonly onEvent: (event: ReturnType<typeof buildEvent>) => void;
}

export class OutputCollector {
  private readonly identity: SessionIdentity;
  private readonly cwd: string | undefined;
  private readonly maxChunk: number;
  private readonly flushMs: number;
  private readonly onEvent: (event: ReturnType<typeof buildEvent>) => void;
  private buffer = "";
  private flushTimer: NodeJS.Timeout | undefined;
  private bytesSeen = 0;

  constructor(opts: OutputCollectorOptions) {
    this.identity = opts.identity;
    this.cwd = opts.cwd;
    this.maxChunk = opts.maxChunk ?? 4096;
    this.flushMs = opts.flushMs ?? 500;
    this.onEvent = opts.onEvent;
  }

  /** PTY data を投入する。 */
  push(data: string): void {
    this.bytesSeen += Buffer.byteLength(data, "utf8");
    this.buffer += data;
    if (this.buffer.length >= this.maxChunk) {
      this.flush();
      return;
    }
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => this.flush(), this.flushMs);
    }
  }

  /** バッファを command.output.delta として吐き出す。 */
  flush(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
    if (this.buffer.length === 0) return;
    const delta = this.buffer;
    this.buffer = "";
    // 発生時刻を**今**固定 (hold されても flush 時刻でなく観測時刻を timestamp に乗せる)。
    const observedAt = new Date().toISOString();
    // output は情報価値が高いので有界化時も保持優先 (category="output")。
    this.identity.emitMonitoring("output", (canonicalSessionId) => {
      this.onEvent(
        buildEvent({
          session_id: canonicalSessionId,
          event_type: "command.output.delta",
          timestamp: observedAt,
          ...(this.cwd !== undefined ? { cwd: this.cwd } : {}),
          payload: { kind: "command.output.delta", stream: "stdout", delta },
        }),
      );
    });
  }

  /** 観測した総バイト数 (stdout heartbeat / liveness 用)。 */
  get totalBytes(): number {
    return this.bytesSeen;
  }

  stop(): void {
    this.flush();
    if (this.flushTimer) clearTimeout(this.flushTimer);
  }
}
