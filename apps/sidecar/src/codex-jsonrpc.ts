/**
 * Codex App Server JSON-RPC framing + client (ADR 019ea31b (a)).
 *
 * transport (実バイナリ probe 確定):
 * - stdout は **line-delimited JSON** (`{...}\n`)。LSP の Content-Length ヘッダは使わない。
 * - 送信 = `JSON.stringify(msg) + "\n"`。受信 = stdout を行バッファし 1 行 = 1 message。
 * - JSON-RPC "lite": `jsonrpc:"2.0"` ヘッダは付けない (codex は要求しない)。methods は lowercase。
 * - RequestId は string | int64。
 *
 * 本モジュールは **framing と message 多重化のみ** を担う (spawn は codex-runner.ts)。
 * stdin/stdout の生 stream を注入し、テストでフェイク stream で頑健性 (INV-CODEX-FRAME) を固定する。
 *
 * INV-CODEX-FRAME (頑健性):
 * - 複数 message が 1 read に連結 / 1 message が複数 read に分割 / 空行 / 不正 JSON 行を
 *   skip してもプロセスを落とさない (parser は throw しない)。
 */

/** JSON-RPC id (string | number)。codex は string|int64 を許す。 */
export type CodexRequestId = string | number;

/** 受信した JSON-RPC message (envelope を判別せず raw で渡す)。 */
export interface CodexInboundMessage {
  readonly id?: CodexRequestId;
  readonly method?: string;
  readonly params?: unknown;
  readonly result?: unknown;
  readonly error?: { code?: number; message?: string; data?: unknown };
  readonly [k: string]: unknown;
}

/** stdin の書き込み口 (child.stdin の部分集合)。テストでフェイク注入可能。 */
export interface WritableLike {
  write(chunk: string): unknown;
}

/** stdout の読み取り口 (child.stdout の部分集合)。`data` で Buffer|string を受ける。 */
export interface ReadableLike {
  on(event: "data", listener: (chunk: Buffer | string) => void): unknown;
  off?(event: "data", listener: (chunk: Buffer | string) => void): unknown;
}

export interface CodexJsonRpcOptions {
  readonly stdin: WritableLike;
  readonly stdout: ReadableLike;
  /** 受信した notification / server-request (id 付き method)。 */
  readonly onMessage: (msg: CodexInboundMessage) => void;
  /** 不正 JSON 行を観測 (テスト・診断)。プロセスは落とさない。 */
  readonly onParseError?: (line: string, err: unknown) => void;
  /**
   * R2 (ADR 019f2421): send の同期 write が死 stream で throw (ERR_STREAM_DESTROYED / EPIPE) した
   * ときに **局所** で観測する (テスト・診断)。プロセスを落とさない (未指定なら握り潰す)。
   * NO-RAW: 呼び元 (codex-runner) は errno code 等の非 raw メタのみを diag へ流す。
   */
  readonly onWriteError?: (err: unknown) => void;
}

/**
 * line-delimited JSON の送受信を担う最小クライアント。
 *
 * request/response の相関は呼び出し側 (codex-runner) が pending map で持つため、本クラスは
 * 「行を組み立てて parse し onMessage へ渡す」「メッセージを 1 行で書き出す」のみに徹する。
 */
export class CodexJsonRpc {
  /**
   * R3 (ADR 019f2421): 行未満の残バッファの上限。newline 無しの巨大 line (flood/OOM) で
   * `buffer` が無界に伸びるのを防ぐ。rollout tailer の MAX_TAIL_CHUNK (16 MiB・codex-rollout-tailer.ts)
   * と同 order・同クラス (無界 Buffer→capped) の可用性/OOM 対策。上限は文字長で見る (byte 近似・十分厳しい)。
   */
  private static readonly MAX_BUFFER_BYTES = 16 * 1024 * 1024;

  private readonly stdin: WritableLike;
  private readonly opts: CodexJsonRpcOptions;
  /** 行未満の残バッファ (分割 read を跨いで 1 行を組み立てる)。 */
  private buffer = "";
  private readonly onData = (chunk: Buffer | string): void => this.ingest(chunk);

  constructor(opts: CodexJsonRpcOptions) {
    this.opts = opts;
    this.stdin = opts.stdin;
    opts.stdout.on("data", this.onData);
  }

  /**
   * 1 メッセージを line-JSON で送信する (`JSON.stringify(msg) + "\n"`)。
   * 送信値はここで序列化のみ。redaction は **送信路ではなく** sink.emit choke で行う
   * (本 stdin は codex への制御チャネルで観測イベントではない)。
   */
  send(msg: Record<string, unknown>): void {
    try {
      this.stdin.write(JSON.stringify(msg) + "\n");
    } catch (err) {
      // R2 (ADR 019f2421): 死んだ/破棄済み stream への write は **同期 throw** しうる
      // (ERR_STREAM_DESTROYED)。これを素通しさせると CLI の uncaughtException →
      // process.exit(1) = daemon 全体 fatal 終了になる (cli.ts:472)。ここで局所吸収し、
      // 呼び元へ非 raw で通知する (async EPIPE は runner の stdin "error" listener が受ける)。
      this.opts.onWriteError?.(err);
    }
  }

  /**
   * stdout chunk を取り込み、改行で行分割して 1 行ずつ parse する。
   * - 分割 read: buffer に貯めて改行が来るまで保持。
   * - 連結 read: 1 chunk 内の複数行を順に処理。
   * - 空行 / 空白のみ行: skip。
   * - 不正 JSON 行: onParseError で観測し skip (throw しない = プロセスを落とさない)。
   */
  private ingest(chunk: Buffer | string): void {
    this.buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    // 末尾に改行が無い分は buffer に残す (次 read で続きを連結)。
    let nlIdx: number;
    while ((nlIdx = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, nlIdx);
      this.buffer = this.buffer.slice(nlIdx + 1);
      this.handleLine(line);
    }
    // R3 (ADR 019f2421): 完全な行を全て消費した後の残 partial-frame が上限を超えたら
    // (= newline 無しで無界に伸びる flood/OOM) buffer を捨てて fail-safe に縮退する。
    // NO-RAW: onParseError には **固定リテラル + 破棄バイト数のみ** を渡す (raw 本文は echo しない)。
    if (this.buffer.length > CodexJsonRpc.MAX_BUFFER_BYTES) {
      const droppedBytes = this.buffer.length;
      this.buffer = "";
      this.opts.onParseError?.(
        `<oversized frame dropped: ${droppedBytes} bytes, no newline>`,
        new Error("frame buffer cap exceeded"),
      );
    }
  }

  private handleLine(rawLine: string): void {
    // CRLF 耐性: 末尾 \r を除去。
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (line.trim().length === 0) return; // 空行 skip
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (err) {
      this.opts.onParseError?.(line, err);
      return; // 不正行は skip (プロセスを落とさない)
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      this.opts.onParseError?.(line, new Error("non-object JSON message"));
      return;
    }
    this.opts.onMessage(parsed as CodexInboundMessage);
  }

  /** stdout リスナを解除する (shutdown 時)。 */
  dispose(): void {
    this.opts.stdout.off?.("data", this.onData);
  }
}
