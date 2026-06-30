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

import type { PolicyCategory } from "@actradeck/event-model";

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
/**
 * ADR 019f0c3e Phase 2: bypass/YOLO 承認ポリシー (どの high-risk カテゴリを明示承認に落とすか) の
 * get/set 要求 (UI→backend→sidecar)。allowlist.request と同じ controlToken 認可境界を通す
 * (不一致/不在は破棄=fail-safe)。`categories` は **closed enum (PolicyCategory) 文字列のみ**で生コマンドを
 * 構造的に含まない (NO-RAW)。受信側は未知値を sanitize で捨てる。policy は **machine-global**
 * (~/.actradeck/approvals/policy.json) ゆえ session_id は relay の宛先解決のみに使う。
 */
export type PolicyRequestMsg = {
  readonly type: "policy.request";
  /** 応答を突合する相関 ID (backend が採番)。 */
  readonly request_id?: string;
  /**
   * "get" | "set" | "unset" | "list" | "resolve"。未知/不在は "get" 扱い (**変更しない方向**の fail-safe)。
   * ADR 019f0eca: "unset"=repo_scope の override 削除 (default 継承へ)。"list"=default + 全 repo override 一覧。
   * "resolve"=操作者入力の絶対パス (path) を git root 解決し scope+effective policy を返す (方式B・読取りのみ)。
   */
  readonly op?: string;
  /** set 時の新カテゴリ集合 (closed enum 文字列・未知値は受信側で破棄)。 */
  readonly categories?: readonly string[];
  /** set 時の **file-level** enabled (env kill-switch は別概念・非永続)。 */
  readonly enabled?: boolean;
  /**
   * ADR 019f0eca: get/set/unset 対象の repo スコープ (省略=default/マシン基準)。allowlist.request の
   * repo_scope と同じ検証境界 (受信側 /^[0-9a-f]{1,64}$/)。raw コマンド/絶対パスは構造的に含まない。
   */
  readonly repo_scope?: string;
  /** ADR 019f0eca: set 時の表示用 repo basename (任意・表示専用)。 */
  readonly repo_label?: string;
  /**
   * ADR 019f0eca 方式B: op="resolve" 専用の操作者入力**絶対パス**。git root 解決にのみ使い **保存しない**。
   * project-scope 封じ込め検証は backend (ACTRADECK_PROJECT_SCOPE) が済ませる。他 op では無視。
   */
  readonly path?: string;
  /**
   * ADR 019f0eca 方式B + SEC-1 (decision 019f0f2f): op="resolve" 専用の project-scope prefix 群
   * (backend の ACTRADECK_PROJECT_SCOPE・絶対パス前方一致)。sidecar が解決済の **物理 git root** を
   * この scope と再照合し、symlink/ancestor で root が scope 外へ抜けるのを拒否する (二段封じ込めの第二段)。
   * 入力 path の lexical 第一段は backend が済ませる。空/省略=封じ込め無し (backend が default-off のとき)。
   * 値は operator 設定の project ディレクトリ prefix (secret でない)・request のみ・保存も echo もしない。
   */
  readonly resolve_scope?: readonly string[];
  /**
   * ADR 019f0eca multi-daemon fan-out (TDA-1・decision 019f0f2f): false のとき set/unset を
   * **memory のみ**反映し disk へ永続しない。backend の fanOutPolicyMutation が他 daemon へ伝播する
   * コピーにのみ false を載せる。owner daemon (操作者の relay 直送) は省略=true で唯一 disk を書く。
   * これにより、再接続後に stale な受信 daemon が full layered を disk へ書戻して厳格 override を黙って
   * 消す silent security-control downgrade を構造的に防ぐ (authoritative な disk 書込は owner 一点に限定)。
   */
  readonly persist?: boolean;
  /** 3#SEC-1: per-session 制御トークン。 */
  readonly token?: string;
};
export type InboundMsg =
  | ApprovalDecisionMsg
  | InterruptMsg
  | DiffRequestMsg
  | AllowlistRequestMsg
  | PolicyRequestMsg;

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

/**
 * ADR 019f0c3e Phase 2: 承認ポリシー get/set 応答 (sidecar→backend)。closed enum のみ (構造的 NO-RAW)。
 */
/**
 * ADR 019f0eca: per-repo オーバーライド 1 件のワイヤ形 (policy.response の repos[] 要素・UI 左ペイン用)。
 * NO-RAW: repo_scope=sha256短縮 / repo_label=basename / categories=closed enum のみ (生コマンド/絶対パス非含)。
 */
export type PolicyRepoWire = {
  readonly repo_scope: string;
  readonly repo_label?: string;
  readonly enabled: boolean;
  readonly categories: readonly PolicyCategory[];
};

export type PolicyResponseMsg = {
  readonly type: "policy.response";
  readonly request_id: string;
  /** file-level enabled (operator 設定値・UI チェックボックスが反映する状態)。 */
  readonly enabled: boolean;
  /** ゲート対象カテゴリ (PolicyCategory.options の安定順・NO-RAW)。 */
  readonly categories: readonly PolicyCategory[];
  /** env kill-switch 状態 (false=全体パススルー中・UI 警告用)。既定 true。 */
  readonly env_gate_enabled?: boolean;
  /**
   * ADR 019f0eca: get/set/unset が指す repo スコープ (省略=default)。UI が「どの scope を表示中か」を知る。
   */
  readonly repo_scope?: string;
  /** ADR 019f0eca: 当該 repo の表示用 basename (override が存在する場合のみ)。 */
  readonly repo_label?: string;
  /** ADR 019f0eca: repo_scope 指定時に override が存在するか (true=override / false=default 継承)。 */
  readonly is_override?: boolean;
  /** ADR 019f0eca: op="list" 時のみ。default + 全 repo override の一覧 (左ペイン)。 */
  readonly repos?: readonly PolicyRepoWire[];
  /** 失敗時のみ (検証エラー等・原文非依存の短文)。 */
  readonly error?: string;
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
  /**
   * ADR 019f1582 follow-up: この daemon が policy.request を処理して応答できるか。true のとき hello に
   * `policy_capable: true` を載せ、backend が connectedDaemons (UI の daemon-addressed policy 宛先) に
   * 含める。policyRequest ハンドラを wire する daemon (managed sidecar / attach) のみ true。observe-only
   * の codex-rollout daemon は false (既定) で、policy 非対応 daemon を addressing した timeout を防ぐ。
   */
  readonly policyCapable?: boolean;
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
  /** ADR 019f0c3e Phase 2: token 検証済みの承認ポリシー get/set 要求。上流が ApprovalBridge で応答する。 */
  policyRequest: (msg: PolicyRequestMsg) => void;
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
  private readonly policyCapable: boolean;
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
    this.policyCapable = opts.policyCapable ?? false;
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
        // connect-open と reannounce は同一 builder を共有し control_token / session_ids /
        // policy_capable を一様に載せる (TDA-1: 片方欠落だと reannounce で capability 降格する H 回帰)。
        this.sendRaw(this.buildHelloFrame());
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
    // 3#SEC-1: 制御チャネル (approval/interrupt/diff.request/allowlist.request/policy.request) は認証必須。
    // token 不一致/不在はここで破棄し、emit に至らせない (= 各ハンドラへ到達不能)。
    if (
      msg.type === "approval" ||
      msg.type === "interrupt" ||
      msg.type === "diff.request" ||
      msg.type === "allowlist.request" ||
      msg.type === "policy.request"
    ) {
      if (!this.isAuthorizedControl(msg.token)) return; // fail-safe deny
    }
    // SEC-R2-1 (decision 019f0d22) 構造 backstop: 制御 handler は同期 emit で呼ばれるため、handler 内の
    // 想定外 throw (例: 永続の disk 失敗) がここを貫通すると ws message コールバックへ伝播し
    // uncaughtException → daemon crash になる。emit を try/catch で囲い、いかなる listener throw でも
    // daemon を落とさない (現行 5 handler + 将来追加も自動で網羅し per-site 漏れを構造的に防ぐ)。
    // 各 handler 側の graceful 化 (ApprovalBridge.safePersist 等) と二段構え (最終 crash net)。
    try {
      if (msg.type === "approval") this.emit("approval", msg);
      else if (msg.type === "interrupt") this.emit("interrupt", msg);
      else if (msg.type === "diff.request") this.emit("diffRequest", msg);
      else if (msg.type === "allowlist.request") this.emit("allowlistRequest", msg);
      else if (msg.type === "policy.request") this.emit("policyRequest", msg);
    } catch {
      // graceful 層が処理しない想定外 throw のみ到達する最終 crash net。daemon を生存させる。
    }
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
   * ADR 019f0c3e Phase 2: 承認ポリシー get/set 応答を backend へ返す (egress WS の fire-and-forget)。
   * categories は **closed enum (PolicyCategory) のみ**で生コマンドを構造的に含まない (NO-RAW)。
   * 接続断時は応答が届かず backend 側がタイムアウトで安全側 reject する。
   */
  respondPolicy(msg: PolicyResponseMsg): void {
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
    // TDA-1 (decision 019f1859): connect-open と同一 builder を共有し policy_capable を一様に載せる。
    // 以前は reannounce が policy_capable を落とし、backend handleHello の無条件上書きで capability が
    // false へ降格 → connectedDaemons 脱落 → daemon-addressed policy 宛先消失する H 回帰があった。
    this.sendRaw(this.buildHelloFrame());
  }

  /**
   * hello frame を組む単一出所 (connect-open と reannounce で共有・TDA-2 drift 根治)。
   * control_token / session_ids / policy_capable を一様に載せる。session_ids は ADR 019e9462 の
   * provider があれば送信時点で canonical を動的解決し (未確定時は fallback)、無ければ固定値 (後方互換)。
   * 呼び元が controlToken 確立済みを保証する (本メソッドは frame 文字列を返すのみ)。
   */
  private buildHelloFrame(): string {
    const sessionIds = this.sessionIdsProvider
      ? [...this.sessionIdsProvider()]
      : [...this.sessionIds];
    return JSON.stringify({
      type: "hello",
      control_token: this.controlToken,
      session_ids: sessionIds,
      // ADR 019f1582 follow-up: policy.request を処理できる daemon のみ広告 (managed/attach=true)。
      // 載せない (=false) と backend は connectedDaemons から除外し UI が addressing しない。
      // connect/reannounce 両経路で一様に載せる (TDA-1: 片方欠落だと reannounce で capability 降格)。
      ...(this.policyCapable ? { policy_capable: true } : {}),
    });
  }

  close(): void {
    this.closed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws?.close();
  }
}
