/**
 * Realtime Hub (Phase 3 ③ — backend→UI push + UI→Sidecar relay の調停コア).
 *
 * 責務 (transport 非依存・純ロジックで testable):
 *  - **UI subscriber レジストリ**: list 購読者 (全 session 一覧) と per-session 購読者を管理。
 *  - **配信整形**: session_state projection + liveness を **redaction 済 DTO** へ写す。
 *    backend は再 redaction しない (sidecar が INV-REDACTION choke point)。ここでは
 *    永続済 session_state (= redaction 後) のみを参照し、生 payload を新規露出させない。
 *  - **順序保持**: 1 接続 (= 1 WS socket) への送信は push 呼び出し順をそのまま保つ
 *    (同期 send。INV-REALTIME-ORDER)。session 内イベント順序は ingest 側 (append-only) が、
 *    UI 配信順序はこの逐次 push が担保する。
 *  - **承認中継の責務分離**: 実際の sidecar への書き戻しは SidecarRegistry (ingestion 側) が
 *    持つ。hub は「UI から来た承認/interrupt 指示」を relay コールバックへ渡すのみ。
 *
 * transport (WS) は realtime-server.ts が握り、socket を本 hub に登録する。hub は socket を
 * 「send(string) を持つ最小インタフェース」としてしか知らない (テストで偽 socket を注入可能)。
 */
import type {
  ActionKind,
  CaptureMode,
  Continuation,
  EndKind,
  LastTurnOutcome,
  StartKind,
} from "@actradeck/event-model";

import type { LivenessEvidence, LivenessState } from "./liveness.js";
import type { PendingApproval } from "./reducer.js";
import type { ReplayEventDTO } from "./replay-contract.js";

export type { PendingApproval };

/** hub が配信する最小 socket 抽象 (ws / テスト偽物の両対応)。 */
export interface RealtimeSink {
  /** UI へ 1 フレーム送る。失敗 (接続断) は呼び元が握る。 */
  send(data: string): void;
  /** 接続が生きているか (OPEN)。閉じた sink には配信しない。 */
  readonly open: boolean;
}

/** plan.md §3A 必須項目の subset を UI へ push する session 一覧行 DTO。 */
export interface SessionListItem {
  readonly session_id: string;
  readonly provider: string;
  readonly source: string;
  readonly agent_id: string | undefined;
  readonly repo: string | undefined;
  readonly branch: string | undefined;
  readonly cwd: string | undefined;
  /** 正規化状態 (running.* / waiting.* / stalled ...)。未確定は undefined。 */
  readonly state: string | undefined;
  readonly current_action: string | undefined;
  /**
   * 現在のアクションの **kind** (ActionKind closed-enum)。表示時ローカライズ (ADR 019eeac6):
   * UI はこの kind + current_action_subject を locale 別述語テンプレートへ流し込み、normalizer が
   * current_action (summary) へ焼き込んだ日本語固定文字列への依存を断つ。出所は
   * session_state.current_action_kind (projection 由来・eventTypeToActionKind 純写像)。
   * **optional**(後方互換): 欠落 (NULL = 旧行) はキーを落とす。UI は current_action へ fallback。
   */
  readonly current_action_kind?: ActionKind;
  /**
   * 現在のアクションの **対象** 構造値 (command / path / server/tool / query / tool_name / reason)。
   * **出所は redacted payload の allowlist フィールドのみ** (ADR 019eeac6 絶対契約): sidecar choke
   * (redactDeepWithCount) を通った後の payload からのみ projection が引く。summary は出所にしない
   * (日本語焼付けのため)。**秘匿値そのものは載らない** (sink で marker 化済・backend は再 redaction しない)。
   * **optional**(後方互換): 欠落はキーを落とす。
   */
  readonly current_action_subject?: string;
  readonly last_event_at: string | undefined;
  readonly needs_attention: boolean;
  /** liveness 合成状態 (live/idle/stalled/unknown)。 */
  readonly liveness_state: LivenessState;
  readonly stalled_suspected: boolean;
  /**
   * 接続在席(presence): この session を所有する sidecar の egress WS 接続が開いているか
   * (= いま Claude Code が起動中か)。ADR 019ea2bf の二層モデルの **membership** 軸:
   * 一覧に出すか否かを決める(既定 UI は connected=true のみ表示)。`liveness_state`(鮮度=status)
   * とは直交し、connected=true ∧ liveness_state="idle"(起動中だが無活動)は両立する。
   * SidecarRegistry.isLive と等価(grace 中も true)。registry を知らない store は server 層が被せる。
   */
  readonly connected: boolean;
  /**
   * 取得方式 (ADR 019ea476 D8 / 019ea4ba D4)。"managed" = ActraDeck が起動を所有する経路、
   * "attach" = 起動を所有しない CC を hooks 経由で後付け capture する経路。
   * "codex_rollout" = Codex TUI rollout JSONL の passive tail 観測。
   * **optional**(後方互換): 欠落は managed 既定扱い。UI が non-managed capture provenance
   * を示すための判別子。approval relay 可否とは直交する。
   * projection key には使わない (presence/liveness は既存経路)。
   */
  readonly capture_mode?: CaptureMode;
  /**
   * ADR 0015 §D4/§D8: この session の **自己申告完了だが未検証** な work item 数
   * (status='completed' ∧ verification_state='unverified')。work_items 投影の query-derived 集約。
   * **needs_attention とは分離**する (approvals + liveness の警報疲れと結合しない・§D4)。Wall/一覧は
   * これを独立バッジで出す。**optional**(後方互換): 0 または未観測はキーを落とす (バッジ非表示)。
   * 表示専用・projection key 非使用・秘匿値を含まない (非負整数のみ)。
   */
  readonly claimed_unverified_count?: number;
}

/**
 * run lineage の兄弟 run 1 件 (ADR 0014 Phase 3c)。同一 provider_session_id を共有する
 * 観測 run。表示専用の非秘匿メタ (session_id / 開始種別 / 最終活動) のみで、
 * command/payload/secret は載らない。
 */
export interface LineageRun {
  readonly session_id: string;
  /** 開始種別 (closed-enum gate 済・out-of-enum/NULL はキー落とし)。 */
  readonly start_kind?: StartKind;
  /** 最終活動 (ISO)。projection 未着の run は欠落。 */
  readonly last_event_at?: string;
}

/** session 詳細 DTO (一覧 + liveness evidence 分解 + 不正遷移カウント + 承認待ち)。 */
export interface SessionDetail extends SessionListItem {
  readonly last_event_id: string | undefined;
  /** plan.md §17: process/event/stdout/file/model-stream 分解根拠。 */
  readonly liveness_evidence: LivenessEvidence;
  readonly liveness_reason: string;
  readonly liveness_evaluated_at_ms: number;
  readonly invalid_transition_count: number;
  /**
   * 未解決の承認要求 (ADR 019e9999)。UI が承認カードを描画し approve frame に request_id を載せる。
   * 値は sidecar で redaction 済み (D2: 件数による誘導は SessionListItem.needs_attention が担う)。
   */
  readonly pending_approvals: readonly PendingApproval[];
  /**
   * 権限モード (sandbox)。hook 由来 `permission_mode` (default / acceptEdits / bypassPermissions /
   * plan 等) を投影 (ADR 019ea4ba D3 / 段階2)。右ペインに「どこまで自動許可されているか」を示す。
   * **optional**(後方互換): 欠落は未指定 (UI は表示を控える)。表示専用・projection key 非使用。
   */
  readonly permission_mode?: string;
  /**
   * session 内で redaction が一度でも秘匿を検出したか (ADR 019ea4ba 段階2 / 右ペイン secret_detected
   * の session 単位投影)。**秘匿値そのものは載せない** (件数/bool のみ; INV-SECRET-DETECTED-NO-VALUE)。
   * 出所は session_state.secret_detected (projection 由来の永続列)。
   * **optional**(後方互換): 欠落は未観測 (UI は表示を控える)。表示専用・projection key 非使用。
   */
  readonly secret_detected?: boolean;
  /**
   * session 内の `[REDACTED:*]` マーカー累積件数 (secret_detected の補助・検出の濃度)。
   * 出所は session_state.secret_redaction_count。**秘匿値そのものは含まない**。
   * **optional**(後方互換): 欠落時キーを落とす。
   */
  readonly secret_redaction_count?: number;
  /**
   * session 内の redaction を **kind 別**に累積した件数 (強み(a)③ redaction 可視化)。
   * 例 `{ "github-token": 5, "aws-access-key-id": 2 }`。出所は
   * session_state.secret_redaction_count_by_kind (projection 由来)。
   * **秘匿値そのものは含まない** (kind 名 = 公開 enum + 件数のみ)。
   * 正直な整合 (QA-1/TDA-2): 値の総和 <= secret_redaction_count (by_kind は既知 kind の部分集合・
   * scalar は全マーカー数。legacy/混在 event を畳むと sum < count になりうる)。
   * **optional**(後方互換): 欠落 (NULL = 旧行) はキーを落とす (UI は表示を控える)。表示専用。
   */
  readonly secret_redaction_count_by_kind?: Record<string, number>;
  /**
   * ADR 0014 Phase 3c (run lineage・decision 019fd250): 以下はすべて **optional**(後方互換・
   * 欠落時キー落とし = UI は何も主張しない・attach 大半 NULL は正当)。enum 列は sessions の
   * CHECK 無し TEXT を read 時に closed-enum safeParse で gate 済み (SEC-2: out-of-enum の
   * non-ingest writer/backfill/手編集 DB 値を UI へ通さない)。表示専用・projection key 非使用・
   * 秘匿値を含まない (id/enum/ISO のみ)。
   */
  /** provider 発行の raw session id (run lineage の束ねキー)。 */
  readonly provider_session_id?: string;
  /** run の開始種別 (StartKind gate 済)。 */
  readonly start_kind?: StartKind;
  /**
   * この run が継続した元 run の id (lineage エッジ)。**宣言値でありうる** (Codex rollout の
   * forked_from_id): 参照先は未観測・安定会話 id でありうる。UI は session_id で解決し、
   * 未解決は linked-unknown 表示・self-loop 非表示 (ADR 0014 Phase 3 消費者要件)。
   */
  readonly resumed_from_session_id?: string;
  /**
   * resumed_from_session_id が観測済み session として実在するか (EXISTS)。UI の
   * resolved / linked-unknown 分岐の根拠。resumed_from 欠落時はキーごと欠落。
   */
  readonly resumed_from_observed?: boolean;
  /** run の終了種別 (EndKind gate 済)。lifecycle 表示は state が権威で、end_kind から合成しない。 */
  readonly end_kind?: EndKind;
  /**
   * 再開可能性 (stored = provider/process 実証跡・Recoverability gate 済)。表示は
   * event-model `resolveContinuation(stored, state)` (stored-first) の resolved 値 1 つのみ
   * (矛盾値禁止則・decision 019fd250)。
   */
  readonly recoverability?: Continuation;
  /** 直近 turn の結果 (LastTurnOutcome gate 済・session の結果ではない)。 */
  readonly last_turn_outcome?: LastTurnOutcome;
  /**
   * 同一 provider_session_id を共有する run 系譜 (自分含む・started_at 昇順・有界)。
   * 2 run 以上あるときのみ載せる (単独 run は連結情報が無いためキー落とし)。
   */
  readonly lineage_runs?: readonly LineageRun[];
}

/**
 * Approval Inbox 行 DTO (ADR 019ead14 D1): 承認待ちを持つ live session のラベル + その pending 群。
 * `GET /realtime/approvals` が connected かつ pending 非空の全 session を集約して返す。
 * **新フィールドを足さず**既存 PendingApproval(sidecar redaction 済 allow-list 7 キー)をそのまま運ぶ
 * = 新 redaction 面ゼロ。表示は approval-display の純関数(approvalPrimaryText 等)が担う。
 */
export interface SessionApprovals {
  readonly session_id: string;
  readonly provider: string;
  readonly cwd: string | undefined;
  readonly pending_approvals: readonly PendingApproval[];
}

/**
 * Live Wall 段階1 (ADR 019ead7a D1): 横断フィードの 1 レーン (= 1 connected session)。
 * `session` は既存 SessionListItem (1 行 KPI ラベル: state/liveness/connected 等)、`events` は
 * 当該 session の直近 N 件 (REPLAY_ORDER・既存 ReplayEventDTO allow-list 投影)。新 redaction 面ゼロ。
 */
export interface WallLane {
  readonly session: SessionListItem;
  readonly events: readonly ReplayEventDTO[];
}

/** backend→UI へ送るフレーム (discriminated union)。 */
export type ServerFrame =
  | { readonly type: "snapshot.list"; readonly sessions: readonly SessionListItem[] }
  | { readonly type: "delta.list"; readonly session: SessionListItem }
  | {
      readonly type: "snapshot.detail";
      readonly session_id: string;
      readonly detail: SessionDetail;
    }
  | { readonly type: "delta.detail"; readonly session_id: string; readonly detail: SessionDetail }
  | {
      readonly type: "ack";
      readonly action: "subscribe" | "unsubscribe" | "approve" | "interrupt";
      readonly ok: boolean;
      readonly session_id?: string;
      readonly request_id?: string;
      readonly error?: string;
    };

/** UI→backend へ来るフレーム (discriminated union)。 */
export type ClientFrame =
  | { readonly type: "subscribe"; readonly session_id: string }
  | { readonly type: "unsubscribe"; readonly session_id: string }
  | {
      readonly type: "approve";
      readonly session_id: string;
      readonly request_id: string;
      /** T1 ApprovalDecision (allow / allow_for_session / deny / cancel)。 */
      readonly decision: string;
      readonly reason?: string;
      /**
       * ADR 019ee0c0: true なら allow_for_session を **再起動跨ぎ永続** allowlist へ登録するよう
       * sidecar へ中継する (sidecar が medium-bash 等の eligibility を最終判定・非対象は session-only)。
       */
      readonly persist?: boolean;
    }
  | { readonly type: "interrupt"; readonly session_id: string };

interface UiConnection {
  readonly sink: RealtimeSink;
  /** この接続が購読中の session_id 群 (空 = list のみ)。 */
  readonly subscriptions: Set<string>;
}

/**
 * Realtime Hub。UI 接続の登録・購読・配信を司る。
 *
 * - 接続登録時に list snapshot を送るのは server 側 (DB アクセスを伴うため)。hub は登録のみ。
 * - push(list/detail) は server が DB から DTO を作って呼ぶ (hub は DB を知らない)。
 */
export class RealtimeHub {
  private readonly connections = new Set<UiConnection>();
  /** session_id → その session を購読中の接続集合 (O(1) 配信)。 */
  private readonly sessionSubscribers = new Map<string, Set<UiConnection>>();

  /** 接続を登録する。戻り値は購読操作のためのハンドル。 */
  register(sink: RealtimeSink): UiConnectionHandle {
    const conn: UiConnection = { sink, subscriptions: new Set() };
    this.connections.add(conn);
    return new UiConnectionHandle(this, conn);
  }

  /** 現在の UI 接続数 (テスト/監視)。 */
  get connectionCount(): number {
    return this.connections.size;
  }

  /** session を購読中の接続数 (テスト/監視)。 */
  subscriberCount(sessionId: string): number {
    return this.sessionSubscribers.get(sessionId)?.size ?? 0;
  }

  /** 内部: 接続を session 購読へ追加。 */
  _subscribe(conn: UiConnection, sessionId: string): void {
    conn.subscriptions.add(sessionId);
    let set = this.sessionSubscribers.get(sessionId);
    if (!set) {
      set = new Set();
      this.sessionSubscribers.set(sessionId, set);
    }
    set.add(conn);
  }

  /** 内部: 接続を session 購読から外す。 */
  _unsubscribe(conn: UiConnection, sessionId: string): void {
    conn.subscriptions.delete(sessionId);
    const set = this.sessionSubscribers.get(sessionId);
    if (set) {
      set.delete(conn);
      if (set.size === 0) this.sessionSubscribers.delete(sessionId);
    }
  }

  /** 内部: 接続を完全に除去 (close 時)。全購読を解除する。 */
  _remove(conn: UiConnection): void {
    for (const sid of conn.subscriptions) {
      const set = this.sessionSubscribers.get(sid);
      if (set) {
        set.delete(conn);
        if (set.size === 0) this.sessionSubscribers.delete(sid);
      }
    }
    conn.subscriptions.clear();
    this.connections.delete(conn);
  }

  /** 1 接続へ 1 フレームを送る (open かつ送信成功時のみ)。失敗は静かに破棄。 */
  private sendTo(conn: UiConnection, frame: ServerFrame): void {
    if (!conn.sink.open) return;
    try {
      conn.sink.send(JSON.stringify(frame));
    } catch {
      // 送信失敗 (接続断途中) は無視。close ハンドラが _remove する。
    }
  }

  /** list snapshot を 1 接続へ送る (接続直後の初期同期)。 */
  sendListSnapshot(handle: UiConnectionHandle, sessions: readonly SessionListItem[]): void {
    this.sendTo(handle.conn, { type: "snapshot.list", sessions });
  }

  /** detail snapshot を 1 接続へ送る (subscribe 直後)。 */
  sendDetailSnapshot(handle: UiConnectionHandle, sessionId: string, detail: SessionDetail): void {
    this.sendTo(handle.conn, { type: "snapshot.detail", session_id: sessionId, detail });
  }

  /** ack を 1 接続へ送る。 */
  sendAck(handle: UiConnectionHandle, ack: Extract<ServerFrame, { type: "ack" }>): void {
    this.sendTo(handle.conn, ack);
  }

  /**
   * 一覧 delta を全 list 購読者 (= 全接続) へ broadcast する。
   * 接続の Set 反復順 = 登録順を保つため、同一接続に対する連続 push は順序保持される。
   */
  broadcastListDelta(item: SessionListItem): void {
    const frame: ServerFrame = { type: "delta.list", session: item };
    for (const conn of this.connections) this.sendTo(conn, frame);
  }

  /**
   * 詳細 delta を当該 session の購読者のみへ送る (絞り込み配信)。
   * 購読者ゼロなら no-op (誰も見ていない session の detail は流さない)。
   */
  pushDetailDelta(sessionId: string, detail: SessionDetail): void {
    const set = this.sessionSubscribers.get(sessionId);
    if (!set) return;
    const frame: ServerFrame = { type: "delta.detail", session_id: sessionId, detail };
    for (const conn of set) this.sendTo(conn, frame);
  }
}

/**
 * 1 UI 接続のハンドル。server (transport) が socket ライフサイクルに沿って購読操作する。
 * hub 内部の UiConnection を外へ漏らさず、操作だけ公開する。
 */
export class UiConnectionHandle {
  constructor(
    private readonly hub: RealtimeHub,
    /** @internal hub からのみ参照する。 */
    readonly conn: UiConnection,
  ) {}

  subscribe(sessionId: string): void {
    this.hub._subscribe(this.conn, sessionId);
  }
  unsubscribe(sessionId: string): void {
    this.hub._unsubscribe(this.conn, sessionId);
  }
  /** 接続クローズ時に全購読解除 + レジストリから除去。 */
  remove(): void {
    this.hub._remove(this.conn);
  }
  /** この接続が当該 session を購読中か。 */
  isSubscribed(sessionId: string): boolean {
    return this.conn.subscriptions.has(sessionId);
  }
}
