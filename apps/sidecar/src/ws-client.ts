/**
 * WS client — redaction 済みイベントを backend へ送信し、UI からの承認/interrupt を受ける。
 *
 * - 送信は store と協調し「未送信を順序どおり再送」する。ネット断中は store に積まれ、
 *   再接続時に pendingUnsent を flush する。
 * - 受信は承認ブリッジの入口: { type: "approval", request_id, decision } / { type: "interrupt" }。
 *   実際の hook 応答配線は ApprovalBridge (hook-receiver 側) が行う。本クラスは中継のみ。
 *
 * backend (Phase 3) 未完のため、検証では最小 WS sink (ws-sink.ts) で受ける。
 */
import { timingSafeEqual } from "node:crypto";
import { EventEmitter } from "node:events";

import { WebSocket } from "ws";

import type { EventStore } from "./store.js";

export type ApprovalDecisionMsg = {
  readonly type: "approval";
  readonly request_id: string;
  /** 段階③: T1 ApprovalDecision の 4 値 (allow/allow_for_session/deny/cancel)。enum 検証は sidecar.ts。 */
  readonly decision: "allow" | "allow_for_session" | "deny" | "cancel";
  readonly reason?: string;
  /**
   * ADR 019ee0c0: allow_for_session に併せ true なら **再起動跨ぎ永続** allowlist へ登録する
   * (medium-bash + persistable のときのみ・非対象は session-only に degrade)。enum 外/型崩れは sidecar.ts が破棄。
   */
  readonly persist?: boolean;
  /** 3#SEC-1: per-session 制御トークン。不一致/不在は破棄 (fail-safe deny)。 */
  readonly token?: string;
};
export type InterruptMsg = {
  readonly type: "interrupt";
  readonly session_id?: string;
  /** 3#SEC-1: per-session 制御トークン。 */
  readonly token?: string;
};
/**
 * 段階2 (ADR 019ea4ba D2-B): UI→backend→sidecar の diff 本文 **要求**。
 * approval/interrupt と同じ controlToken 認可境界を通す (不一致/不在は破棄=fail-safe)。
 * 要求を受けた sidecar は git diff を生成 → redactDeep 透過 → サイズ切詰め後に
 * diff.response を egress WS で返す (本クラスは要求の検証 + 上流 emit のみ)。
 */
export type DiffRequestMsg = {
  readonly type: "diff.request";
  /** 応答を突合する相関 ID (backend が採番)。 */
  readonly request_id?: string;
  /** どの session への要求か (自セッション以外は上流で拒否)。 */
  readonly session_id?: string;
  /** 3#SEC-1: per-session 制御トークン。 */
  readonly token?: string;
};
/**
 * PAL-v2 (ADR 019ee147): 永続承認 allowlist の list/revoke 要求 (UI→backend→sidecar)。
 * diff.request と同じ controlToken 認可境界を通す (不一致/不在は破棄=fail-safe deny)。
 * allowlist は **machine-global** (~/.actradeck/approvals/allowlist.json を全 daemon が共有) ゆえ
 * session_id は relay の宛先解決のみに使い、entries は session 非依存。要求を受けた sidecar は
 * ApprovalBridge 経由で list/revoke し allowlist.response を egress WS で返す。
 */
export type AllowlistRequestMsg = {
  readonly type: "allowlist.request";
  /** 応答を突合する相関 ID (backend が採番)。 */
  readonly request_id?: string;
  /** "list" | "revoke"。未知/不在は "list" 扱い (破壊しない方向の fail-safe)。 */
  readonly op?: string;
  /** revoke 時の対象署名 (sha256 hex)。 */
  readonly signature?: string;
  /** revoke 時の対象 repo スコープ (省略時は全 scope の同一署名)。 */
  readonly repo_scope?: string;
  /** 3#SEC-1: per-session 制御トークン。 */
  readonly token?: string;
};
export type InboundMsg = ApprovalDecisionMsg | InterruptMsg | DiffRequestMsg | AllowlistRequestMsg;

/** PAL-v2: allowlist エントリの NO-RAW ワイヤ形 (生コマンドは構造的に含まない・sha256/scope/label のみ)。 */
export type AllowlistEntryWire = {
  /** encodeOperationSignature の sha256 hex (生 operand は復元不能)。 */
  readonly signature: string;
  /** repo root の sha256 短縮 (越境防止スコープキー)。 */
  readonly repo_scope: string;
  /** 表示用 repo basename のみ (絶対パス/secret 非含)。 */
  readonly repo_label?: string;
  readonly risk: string;
  readonly created_at_ms: number;
  readonly expires_at_ms: number;
};

/** PAL-v2: allowlist list/revoke 応答 (sidecar→backend)。**生コマンドを決して載せない**。 */
export type AllowlistResponseMsg = {
  readonly type: "allowlist.response";
  readonly request_id: string;
  /** 永続化 honor フラグ (false=disk エントリは dormant。UI が示すため)。 */
  readonly enabled: boolean;
  /** NO-RAW エントリ (期限内のみ)。 */
  readonly entries: readonly AllowlistEntryWire[];
  /** revoke のとき除去件数 (list は省略)。 */
  readonly removed?: number;
};

/** diff 本文応答 (sidecar→backend)。本文は redaction 済み (生 diff は決して載せない)。 */
export type DiffResponseMsg = {
  readonly type: "diff.response";
  readonly request_id: string;
  /** redaction 済み diff 本文 (サイズ規律適用済み)。 */
  readonly body: string;
  readonly truncated: boolean;
  /** redaction が秘匿を検出したか (秘匿値そのものは含めない・件数/bool のみ)。 */
  readonly secret_detected: boolean;
  readonly redaction_count: number;
};

export interface WsClientOptions {
  readonly url: string;
  readonly store: EventStore;
  /**
   * 3#SEC-1: inbound 制御チャネル (approval/interrupt) の認証トークン。
   * sidecar 起動時に crypto.randomBytes(32) で発行する。inbound メッセージは
   * 一致する token を必須とし、不一致/不在は **一切 dispatch しない (fail-safe deny)**。
   * backend 未統合の現状では正しい token を知る peer が存在しないため、実質 inbound 制御を
   * すべて破棄する (= 無認証 WS peer による approval/interrupt 注入を構造的に遮断)。
   * 将来 backend ハンドシェイクで共有する (full HMAC は Phase 3)。
   */
  readonly controlToken?: string;
  /**
   * SEC-2 (egress): backend ingestion (/ingest/ws) の upgrade 認証用 Bearer トークン (env 由来)。
   * 設定時は connect() が `Authorization: Bearer <ingestToken>` ヘッダを付けて接続する
   * (?token= クエリは SEC-1 でログ漏れ温床として禁止。ヘッダのみ)。
   * **未設定時はヘッダ無しで接続する** (後方互換: 無認証 sink 検証を壊さない) が、
   * 認証必須の本番 backend は upgrade を 401 で拒否する点に注意。
   * 値はログ・throw・送信フレーム以外に一切載せない (INV-REDACTION / security.md)。
   */
  readonly ingestToken?: string;
  /**
   * TDA-2 (egress): hello handshake の session_ids に載せる自セッション ID 群。
   * connect() の open 直後に control_token と共に backend へ送り、UI→Sidecar relay の
   * 所有学習を成立させる (これが無いと backend canRelay=false で承認/interrupt が届かない)。
   */
  readonly sessionIds?: readonly string[];
  /**
   * ADR 019e9462: hello を**送る時点で** canonical session_id 群を動的解決する provider。
   * 設定時は `sessionIds` より優先する。canonical 確定後に再接続/再 hello すれば canonical を
   * 載せられる (未確定時は fallback id)。確定前に hello を送っても backend は ingest 流の
   * `observeSession` で canonical 所有を学習するため relay は壊れない (ADR enabler)。
   */
  readonly sessionIdsProvider?: () => readonly string[];
  /** 再接続バックオフ初期値 (ms)。 */
  readonly reconnectBaseMs?: number;
  readonly reconnectMaxMs?: number;
}

/**
 * 承認決定 / interrupt を上流 (hook receiver) へ流すための型付き emitter。
 */
export interface WsClientEvents {
  approval: (msg: ApprovalDecisionMsg) => void;
  interrupt: (msg: InterruptMsg) => void;
  /** 段階2: token 検証済みの diff 本文要求。上流 (Sidecar) が diff を生成し respondDiff で返す。 */
  diffRequest: (msg: DiffRequestMsg) => void;
  /** PAL-v2: token 検証済みの allowlist list/revoke 要求。上流が ApprovalBridge 経由で応答する。 */
  allowlistRequest: (msg: AllowlistRequestMsg) => void;
  connected: () => void;
  disconnected: () => void;
}

export class WsClient extends EventEmitter {
  private ws: WebSocket | undefined;
  private readonly url: string;
  private readonly store: EventStore;
  private readonly controlToken: string | undefined;
  private readonly ingestToken: string | undefined;
  private readonly sessionIds: readonly string[];
  private readonly sessionIdsProvider: (() => readonly string[]) | undefined;
  private readonly reconnectBaseMs: number;
  private readonly reconnectMaxMs: number;
  private reconnectAttempts = 0;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private flushing = false;
  private closed = false;

  constructor(opts: WsClientOptions) {
    super();
    this.url = opts.url;
    this.store = opts.store;
    this.controlToken = opts.controlToken;
    this.ingestToken = opts.ingestToken;
    this.sessionIds = opts.sessionIds ?? [];
    this.sessionIdsProvider = opts.sessionIdsProvider;
    this.reconnectBaseMs = opts.reconnectBaseMs ?? 500;
    this.reconnectMaxMs = opts.reconnectMaxMs ?? 10_000;
  }

  /**
   * 3#SEC-1: inbound 制御メッセージの token を定数時間比較で検証する。
   * - controlToken 未設定 (=token を共有する backend ハンドシェイク未確立) → 常に false。
   * - msg.token 不在/型不一致/長さ不一致/値不一致 → false。
   * いずれも false なら dispatch しない (fail-safe deny)。
   */
  private isAuthorizedControl(msgToken: unknown): boolean {
    const expected = this.controlToken;
    if (expected === undefined || expected.length === 0) return false; // backend 未統合 → 全破棄
    if (typeof msgToken !== "string" || msgToken.length === 0) return false;
    const a = Buffer.from(expected, "utf8");
    const b = Buffer.from(msgToken, "utf8");
    if (a.length !== b.length) return false; // timingSafeEqual は長さ一致前提
    return timingSafeEqual(a, b);
  }

  get connected(): boolean {
    return this.ws !== undefined && this.ws.readyState === WebSocket.OPEN;
  }

  connect(): void {
    if (this.closed) return;
    // SEC-2 (egress): ingestToken があれば upgrade リクエストに Authorization: Bearer を付ける
    // (?token= は禁止)。未設定なら後方互換でヘッダ無し接続 (本番 backend は 401)。
    // 再接続 (scheduleReconnect→connect) でも connect() に集約されるため毎回ヘッダが付く。
    const ws =
      this.ingestToken !== undefined && this.ingestToken.length > 0
        ? new WebSocket(this.url, { headers: { Authorization: `Bearer ${this.ingestToken}` } })
        : new WebSocket(this.url);
    this.ws = ws;
    ws.on("open", () => {
      this.reconnectAttempts = 0;
      this.emit("connected");
      // TDA-2 (egress): flush の **前に** hello frame を送る。controlToken 未設定
      // (backend 未統合検証) なら hello を送らない (fail-safe 設計と整合)。
      // control_token は送信フレームにのみ載せ、ログ・throw には出さない。
      if (this.controlToken !== undefined && this.controlToken.length > 0) {
        // ADR 019e9462: provider があれば hello 送信時点で canonical を動的解決する
        // (未確定時は fallback id)。無ければ構成時の固定 sessionIds を載せる (後方互換)。
        const sessionIds = this.sessionIdsProvider
          ? [...this.sessionIdsProvider()]
          : [...this.sessionIds];
        this.sendRaw(
          JSON.stringify({
            type: "hello",
            control_token: this.controlToken,
            session_ids: sessionIds,
          }),
        );
      }
      void this.flush();
    });
    ws.on("message", (data: Buffer) => this.handleInbound(data));
    ws.on("close", () => {
      this.emit("disconnected");
      this.scheduleReconnect();
    });
    ws.on("error", () => {
      // close が続いて発火するので再接続は close 側に委ねる。
    });
  }

  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer) return;
    const delay = Math.min(this.reconnectMaxMs, this.reconnectBaseMs * 2 ** this.reconnectAttempts);
    this.reconnectAttempts += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.connect();
    }, delay);
  }

  private handleInbound(data: Buffer): void {
    let msg: InboundMsg;
    try {
      msg = JSON.parse(data.toString("utf8")) as InboundMsg;
    } catch {
      return;
    }
    // 3#SEC-1: 制御チャネル (approval/interrupt/diff.request/allowlist.request) は認証必須。
    // token 不一致/不在はここで破棄し、emit に至らせない (= 各ハンドラへ到達不能)。
    if (
      msg.type === "approval" ||
      msg.type === "interrupt" ||
      msg.type === "diff.request" ||
      msg.type === "allowlist.request"
    ) {
      if (!this.isAuthorizedControl(msg.token)) return; // fail-safe deny
    }
    if (msg.type === "approval") this.emit("approval", msg);
    else if (msg.type === "interrupt") this.emit("interrupt", msg);
    else if (msg.type === "diff.request") this.emit("diffRequest", msg);
    else if (msg.type === "allowlist.request") this.emit("allowlistRequest", msg);
  }

  /**
   * 段階2 (ADR 019ea4ba D2-B): diff 本文応答を backend へ返す (egress WS の fire-and-forget)。
   * body は **必ず redaction 済み** (呼び元 = Sidecar が diff-provider の redactDeep 透過後の
   * DiffResult を渡す)。本クラスは生 diff を組み立てない・redaction を行わない (choke は diff-provider)。
   * 接続断時は応答が届かず backend 側がタイムアウトで安全側 reject する (本文を貯めない)。
   */
  respondDiff(msg: DiffResponseMsg): void {
    this.sendRaw(JSON.stringify(msg));
  }

  /**
   * PAL-v2 (ADR 019ee147): allowlist list/revoke 応答を backend へ返す (egress WS の fire-and-forget)。
   * entries は **必ず NO-RAW** (呼び元 = daemon が ApprovalBridge.listPersistedApprovals の sha256 署名
   * ビューを渡す)。本クラスは生コマンドを組み立てない。接続断時は backend 側がタイムアウトで安全側 reject。
   */
  respondAllowlist(msg: AllowlistResponseMsg): void {
    this.sendRaw(JSON.stringify(msg));
  }

  /**
   * イベントが店 (store) に積まれたことを通知 → 接続中なら即 flush。
   * sink は append 後にこれを呼ぶ。
   */
  notifyAppended(): void {
    if (this.connected) void this.flush();
  }

  /** 未送信を順序どおり送り、ack を待たずに sent マーク (at-least-once + 冪等 event_id)。 */
  private async flush(): Promise<void> {
    if (this.flushing || !this.connected) return;
    this.flushing = true;
    try {
      for (;;) {
        const batch = this.store.pendingUnsent(200);
        if (batch.length === 0) break;
        const sentIds: string[] = [];
        for (const row of batch) {
          if (!this.connected) break;
          const ok = await this.send(row.event_json);
          if (!ok) break;
          sentIds.push(row.event_id);
        }
        this.store.markSent(sentIds);
        if (sentIds.length < batch.length) break;
      }
    } finally {
      this.flushing = false;
    }
  }

  /**
   * 接続中なら 1 フレームを fire-and-forget で送る (hello handshake 用)。
   * flush の ack 待ち順序とは独立に、open 直後の最初のフレームとして送るために使う。
   */
  private sendRaw(payload: string): void {
    if (!this.connected || !this.ws) return;
    this.ws.send(payload);
  }

  private send(payload: string): Promise<boolean> {
    return new Promise((resolve) => {
      if (!this.connected || !this.ws) return resolve(false);
      this.ws.send(payload, (err) => resolve(err === undefined || err === null));
    });
  }

  /**
   * 観測中 session 集合が変化したとき hello を再送する (presence membership の権威更新・ADR 019eb365)。
   * 接続中のみ送る (未接続なら次の open handshake が sessionIdsProvider で最新集合を載せる)。
   * controlToken 未設定なら no-op。backend は authoritative hello として、この接続が所有するが
   * 新集合に**無い** session を grace release する (INV-PRESENCE-RELEASE)。
   */
  reannounce(): void {
    if (this.controlToken === undefined || this.controlToken.length === 0) return;
    const sessionIds = this.sessionIdsProvider
      ? [...this.sessionIdsProvider()]
      : [...this.sessionIds];
    this.sendRaw(
      JSON.stringify({ type: "hello", control_token: this.controlToken, session_ids: sessionIds }),
    );
  }

  close(): void {
    this.closed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws?.close();
  }
}
