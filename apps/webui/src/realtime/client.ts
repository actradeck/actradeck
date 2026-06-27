/**
 * RealtimeClient — ブラウザ side の WS クライアント (transport 非依存・テスト可能).
 *
 * 設計 (CLAUDE.md / frontend.md):
 *  - ブラウザは **same-origin** で BFF (Next.js custom server) の `/realtime/ws` へ繋ぐ。
 *    REALTIME_TOKEN は **クライアントに渡らない** (BFF が server-side で Bearer を付ける)。
 *    本クラスは token を一切扱わない (構造的に UI へ漏れない)。
 *  - 再接続は jitter 付き指数バックオフ (ReconnectBackoff) で storm を避ける。
 *  - 受信は parseServerFrame で境界バリデートし、未知/壊れフレームは捨てて接続維持。
 *  - **状態と表示の分離**: 本クラスは「接続状態」と「受信フレーム」を callback で外へ出すだけ。
 *    一覧の畳み込みは list-reducer、描画は React 側が担う。
 *  - 再接続後は subscribe を自動再送し、サーバ snapshot で再同期する (取りこぼし防止)。
 *
 * WebSocket / setTimeout を注入可能にして、vitest (node) で実ブラウザ無しに赤化できる。
 */
import { ReconnectBackoff, type BackoffOptions } from "./backoff";
import { parseServerFrame } from "./parse-frame";

import type { ClientFrame, ServerFrame } from "./contract";

/** クライアントが外へ公開する接続状態 (表示用)。停止断定はしない。 */
export type ConnectionStatus = "connecting" | "open" | "reconnecting" | "closed";

/** 注入される最小 WebSocket 抽象 (browser WebSocket / テスト偽物の両対応)。 */
export interface SocketLike {
  send(data: string): void;
  close(): void;
  onopen: (() => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
}

export type SocketFactory = (url: string) => SocketLike;

/** タイマー抽象 (テストで fake timers / 即時実行に差し替え可能)。 */
export interface TimerLike {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface RealtimeClientOptions {
  /** BFF の same-origin WS URL (例: `ws://localhost:55400/realtime/ws`)。token は含めない。 */
  readonly url: string;
  readonly socketFactory: SocketFactory;
  readonly timer?: TimerLike;
  readonly backoff?: BackoffOptions;
  /** 受信フレーム (パース済) を 1 件ずつ通知。 */
  readonly onFrame?: (frame: ServerFrame) => void;
  /** 接続状態の変化を通知 (表示用)。 */
  readonly onStatus?: (status: ConnectionStatus) => void;
  /** バックオフ上限到達で諦めたときの通知 (運用可視化用)。 */
  readonly onGaveUp?: () => void;
}

const defaultTimer: TimerLike = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

export class RealtimeClient {
  private socket: SocketLike | null = null;
  private status: ConnectionStatus = "closed";
  private readonly backoff: ReconnectBackoff;
  private reconnectHandle: unknown = null;
  private stopped = false;
  /** 再接続後に復元する購読集合 (取りこぼし防止のため自動再 subscribe)。 */
  private readonly subscriptions = new Set<string>();
  private readonly timer: TimerLike;

  constructor(private readonly opts: RealtimeClientOptions) {
    this.timer = opts.timer ?? defaultTimer;
    this.backoff = new ReconnectBackoff(opts.backoff);
  }

  get connectionStatus(): ConnectionStatus {
    return this.status;
  }

  /** 現在購読中の session_id 群 (テスト/表示)。 */
  get activeSubscriptions(): readonly string[] {
    return [...this.subscriptions];
  }

  /** 接続を開始する。既に動作中なら no-op。 */
  start(): void {
    this.stopped = false;
    if (this.socket) return;
    this.open();
  }

  /** 明示停止。以降は再接続しない。 */
  stop(): void {
    this.stopped = true;
    if (this.reconnectHandle !== null) {
      this.timer.clearTimeout(this.reconnectHandle);
      this.reconnectHandle = null;
    }
    if (this.socket) {
      const s = this.socket;
      this.socket = null;
      s.close();
    }
    this.setStatus("closed");
  }

  /** 詳細購読を送る (接続中なら即送信、未接続でも集合に保持し再接続後に再送)。 */
  subscribe(sessionId: string): void {
    this.subscriptions.add(sessionId);
    this.sendFrame({ type: "subscribe", session_id: sessionId });
  }

  unsubscribe(sessionId: string): void {
    this.subscriptions.delete(sessionId);
    this.sendFrame({ type: "unsubscribe", session_id: sessionId });
  }

  /**
   * 制御フレーム送信 (approve / interrupt)。このスライスでは導線最小だが、
   * 契約 (ClientFrame) を満たす送信口を用意しておく (UI からの注入を T1 検証は BFF/backend が担う)。
   * 接続が無いときは黙って捨てる (古い操作を勝手にキューしない — 安全側)。
   */
  send(frame: ClientFrame): void {
    this.sendFrame(frame);
  }

  private sendFrame(frame: ClientFrame): void {
    if (this.socket && this.status === "open") {
      this.socket.send(JSON.stringify(frame));
    }
  }

  private open(): void {
    this.setStatus(this.backoff.attempts === 0 ? "connecting" : "reconnecting");
    const socket = this.opts.socketFactory(this.opts.url);
    this.socket = socket;

    socket.onopen = () => {
      this.backoff.reset();
      this.setStatus("open");
      // 再接続後は購読を再送し snapshot で再同期する (取りこぼし防止)。
      for (const sid of this.subscriptions) {
        socket.send(JSON.stringify({ type: "subscribe", session_id: sid } satisfies ClientFrame));
      }
    };

    socket.onmessage = (ev) => {
      if (typeof ev.data !== "string") return; // バイナリは契約外 — 捨てる。
      const frame = parseServerFrame(ev.data);
      if (frame) this.opts.onFrame?.(frame);
      // パース不能フレームは黙って捨て、接続は維持する (敵対/壊れフレーム耐性)。
    };

    socket.onerror = () => {
      // error 単体では再接続しない。onclose に集約して二重スケジュールを防ぐ。
    };

    socket.onclose = () => {
      this.socket = null;
      if (this.stopped) {
        this.setStatus("closed");
        return;
      }
      this.scheduleReconnect();
    };
  }

  private scheduleReconnect(): void {
    const delay = this.backoff.nextDelayMs();
    if (delay === null) {
      // 上限到達: storm を起こさず諦める (無限リトライ禁止)。
      this.setStatus("closed");
      this.opts.onGaveUp?.();
      return;
    }
    this.setStatus("reconnecting");
    this.reconnectHandle = this.timer.setTimeout(() => {
      this.reconnectHandle = null;
      if (!this.stopped) this.open();
    }, delay);
  }

  private setStatus(next: ConnectionStatus): void {
    if (this.status === next) return;
    this.status = next;
    this.opts.onStatus?.(next);
  }
}
