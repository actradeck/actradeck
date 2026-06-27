/**
 * Sidecar 接続レジストリ + UI→Sidecar 中継 (Phase 3 ③).
 *
 * backend は sidecar の ingestion WS 接続 (/ingest/ws) を **唯一の戻り経路**として使い、
 * UI からの承認 (allow/allow_for_session/deny/cancel)・interrupt を対象セッションへ書き戻す。
 *
 * セキュリティ (security.md / INV-APPROVAL / SSRF):
 *  - 中継先は **登録済みセッションに限定**する。任意 URL/PID へは到達しない (in-process で
 *    既存 sidecar WS 接続へ書くだけ)。未登録/切断中セッションへの relay は拒否 (no-op + 失敗)。
 *  - 承認なし自動実行を作らない: backend は UI の明示指示しか中継しない。sidecar 側は
 *    controlToken (per-connection) 不一致を fail-safe deny で破棄するため、backend は
 *    handshake で受け取った controlToken を付与して初めて relay が成立する。token 未受領の
 *    接続へは relay しない (= 承認は届かず sidecar 側タイムアウトで安全側 deny)。
 *  - controlToken は秘匿値。ログ・UI へ出さない (relay ペイロードにのみ載せ sidecar へ戻す)。
 *
 * handshake: sidecar は接続後に最初のフレームとして
 *   { "type": "hello", "control_token": "<sidecar 起動時の randomBytes(32)>",
 *     "session_ids": ["sess_..."] }
 * を送る (後方互換: hello を送らない接続は event ingest はできるが relay 不可)。
 * 以降、ingest した event の session_id でも所有を学習する (hello 未対応 sidecar でも
 * session→connection の対応付けは進むが、controlToken 不在のため relay は依然拒否)。
 */
import { randomUUID } from "node:crypto";

/** sidecar 接続が握る downstream 制御チャネル (ws の最小抽象)。 */
export interface SidecarLink {
  send(data: string): void;
  readonly open: boolean;
}

/** relay 結果。UI への ack 整形に使う。 */
export interface RelayResult {
  readonly ok: boolean;
  readonly error?: string;
}

interface SidecarConn {
  readonly link: SidecarLink;
  /** handshake で受領した per-connection 制御トークン (未受領は undefined → relay 不可)。 */
  controlToken: string | undefined;
  /** この接続が所有する session_id 群 (hello + ingest 観測で学習)。 */
  readonly sessions: Set<string>;
}

/** sidecar が送る handshake フレーム形 (緩く検証する)。 */
interface HelloFrame {
  type: "hello";
  control_token?: unknown;
  session_ids?: unknown;
}

/** sidecar handshake か判定する (ingest event と区別)。 */
export function isHelloFrame(v: unknown): v is HelloFrame {
  return typeof v === "object" && v !== null && (v as { type?: unknown }).type === "hello";
}

/** UI 承認の relay 仕様 (T1 ApprovalDecision を decision に載せる)。 */
export interface ApprovalRelay {
  readonly session_id: string;
  readonly request_id: string;
  readonly decision: string;
  readonly reason?: string;
  /** ADR 019ee0c0: true なら allow_for_session を再起動跨ぎ永続 allowlist へ登録 (sidecar が最終判定)。 */
  readonly persist?: boolean;
}

/**
 * 段階2 (ADR 019ea4ba D2-B): diff 本文応答 (sidecar→backend)。本文は **sidecar で redaction 済み**。
 * backend は再 redaction も永続もしない (sidecar が唯一の choke point)。HTTP 応答へ直渡しする。
 */
export interface DiffResponse {
  /** redaction 済み diff 本文 (生 diff は決して載らない)。 */
  readonly body: string;
  readonly truncated: boolean;
  /** redaction が秘匿を検出したか (秘匿値そのものは含まない・件数/bool のみ)。 */
  readonly secret_detected: boolean;
  readonly redaction_count: number;
}

/** sidecar が送る diff.response フレーム形 (緩く検証する)。 */
interface DiffResponseFrame {
  type: "diff.response";
  request_id?: unknown;
  body?: unknown;
  truncated?: unknown;
  secret_detected?: unknown;
  redaction_count?: unknown;
}

/** sidecar diff.response か判定する (ingest event / hello と区別)。 */
export function isDiffResponseFrame(v: unknown): v is DiffResponseFrame {
  return typeof v === "object" && v !== null && (v as { type?: unknown }).type === "diff.response";
}

/** diff 要求の relay 結果 (HTTP endpoint へ返す)。 */
export type DiffRelayResult =
  | { readonly ok: true; readonly diff: DiffResponse }
  | { readonly ok: false; readonly error: string };

/** diff 要求の既定タイムアウト (ms)。応答が来なければ安全側で reject する。 */
export const DIFF_REQUEST_TIMEOUT_MS = 5000;

/**
 * PAL-v2 (ADR 019ee147): 永続承認 allowlist の list/revoke round-trip (diff round-trip 対称)。
 * allowlist は **machine-global** (sidecar が ~/.actradeck/approvals/allowlist.json を共有) ゆえ
 * session_id は relay の宛先解決にのみ使う。entries は **NO-RAW** (sha256 署名/scope/basename/risk/時刻)。
 */
export interface AllowlistEntry {
  readonly signature: string;
  readonly repo_scope: string;
  readonly repo_label?: string;
  readonly risk: string;
  readonly created_at_ms: number;
  readonly expires_at_ms: number;
}

/** allowlist 要求の relay 結果 (HTTP endpoint へ返す)。 */
export type AllowlistRelayResult =
  | {
      readonly ok: true;
      /** 永続化 honor フラグ (false=disk エントリは dormant)。 */
      readonly enabled: boolean;
      readonly entries: readonly AllowlistEntry[];
      /** revoke のとき除去件数 (list は省略)。 */
      readonly removed?: number;
    }
  | { readonly ok: false; readonly error: string };

/** sidecar が送る allowlist.response フレーム形 (緩く検証する)。 */
interface AllowlistResponseFrame {
  type: "allowlist.response";
  request_id?: unknown;
  enabled?: unknown;
  entries?: unknown;
  removed?: unknown;
}

/** sidecar allowlist.response か判定する (ingest event / hello / diff.response と区別)。 */
export function isAllowlistResponseFrame(v: unknown): v is AllowlistResponseFrame {
  return (
    typeof v === "object" && v !== null && (v as { type?: unknown }).type === "allowlist.response"
  );
}

/** allowlist 要求の既定タイムアウト (ms)。応答が来なければ安全側で reject する。 */
export const ALLOWLIST_REQUEST_TIMEOUT_MS = 5000;

/**
 * presence(接続在席)の grace 期間 (ms)。ADR 019ea2bf。
 *
 * 接続 close から **この時間だけ** session を live(在席)扱いで残し、egress WS の瞬断→自動
 * 再接続(ws-client backoff base500ms..max10s)を吸収する(再接続+再 hello で grace を cancel し
 * 点滅させない)。5s = 「初回〜数回の再接続(500+1000+2000)を吸収」しつつ「本当に終了した CC を
 * 5s 上界で live 集合から除外」する均衡(10s=backoff 上限だと死亡除外が鈍く KPI を毀損)。
 *
 * 注: backend は sidecar の停止意図(正常終了 vs 瞬断)を transport close からは判別できない
 * (in-band goodbye 無し)。grace は close 種別を問わず一律適用する設計上の割り切り。
 */
export const PRESENCE_GRACE_MS = 5000;

/** presence(接続在席) membership 変化の通知。live=true で in、false で out(grace 満了後)。 */
export type PresenceListener = (sessionId: string, live: boolean) => void;

export class SidecarRegistry {
  /** link インスタンス → 接続メタ。close 時に O(1) 解除。 */
  private readonly conns = new Map<SidecarLink, SidecarConn>();
  /** session_id → 所有接続。後勝ち (再接続で最新接続が所有を引き継ぐ)。 */
  private readonly sessionOwner = new Map<string, SidecarConn>();
  /**
   * close で所有解放した session の grace タイマ (session_id → Timeout)。
   * grace 中の session は isLive=true(在席)で一覧に残る。満了で out 確定(presence false 通知)。
   * 同 session を新接続が再 claim したらタイマを cancel し live 維持(flapping 吸収)。
   */
  private readonly graceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** presence membership 変化リスナ (delta.list 発火源)。 */
  private readonly presenceListeners: PresenceListener[] = [];
  /** grace 期間 (ms)。既定 PRESENCE_GRACE_MS。テスト/統合で短縮注入可能。 */
  private readonly graceMs: number;
  /**
   * 段階2 (ADR 019ea4ba D2-B): 未解決の diff 要求 (request_id → 解決/タイムアウト)。
   * sidecar が diff.response を返したら resolveDiff が該当 Promise を解決する。タイムアウトで
   * 安全側 reject し、応答本文を **at-rest に貯めない** (解決後即破棄)。
   */
  private readonly pendingDiffs = new Map<
    string,
    { resolve: (r: DiffRelayResult) => void; timer: ReturnType<typeof setTimeout> }
  >();
  /** diff 要求のタイムアウト (ms)。テストで短縮注入可能。 */
  private readonly diffTimeoutMs: number;
  /**
   * PAL-v2 (ADR 019ee147): 未解決の allowlist 要求 (request_id → 解決/タイムアウト)。
   * sidecar が allowlist.response を返したら resolveAllowlist が該当 Promise を解決する。
   * pendingDiffs と同型 (応答を at-rest に貯めず解決後即破棄・タイムアウトで安全側 reject)。
   */
  private readonly pendingAllowlist = new Map<
    string,
    { resolve: (r: AllowlistRelayResult) => void; timer: ReturnType<typeof setTimeout> }
  >();
  /** allowlist 要求のタイムアウト (ms)。テストで短縮注入可能。 */
  private readonly allowlistTimeoutMs: number;

  constructor(
    opts: { graceMs?: number; diffTimeoutMs?: number; allowlistTimeoutMs?: number } = {},
  ) {
    this.graceMs = opts.graceMs ?? PRESENCE_GRACE_MS;
    this.diffTimeoutMs = opts.diffTimeoutMs ?? DIFF_REQUEST_TIMEOUT_MS;
    this.allowlistTimeoutMs = opts.allowlistTimeoutMs ?? ALLOWLIST_REQUEST_TIMEOUT_MS;
  }

  /** 接続を登録する (handshake 前。controlToken はまだ無い)。 */
  add(link: SidecarLink): void {
    if (this.conns.has(link)) return;
    this.conns.set(link, { link, controlToken: undefined, sessions: new Set() });
  }

  /**
   * 接続を除去する (close 時)。所有 session も解放するが、presence は **即 out にせず**
   * PRESENCE_GRACE_MS の grace タイマ経由で out 確定する(瞬断→再接続の点滅を吸収)。
   */
  remove(link: SidecarLink): void {
    const conn = this.conns.get(link);
    if (!conn) return;
    for (const sid of conn.sessions) {
      if (this.sessionOwner.get(sid) === conn) {
        this.sessionOwner.delete(sid);
        this.startGrace(sid); // 即 false 通知せず grace 経由。
      }
    }
    this.conns.delete(link);
  }

  /**
   * handshake を処理する。control_token が文字列ならこの接続の relay 認可に使う。
   * session_ids があれば所有付けする。戻り値 = 受理した (hello として処理した) か。
   */
  handleHello(link: SidecarLink, frame: HelloFrame): boolean {
    const conn = this.conns.get(link);
    if (!conn) return false;
    if (typeof frame.control_token === "string" && frame.control_token.length > 0) {
      conn.controlToken = frame.control_token;
    }
    if (Array.isArray(frame.session_ids)) {
      // ADR 019eb365: hello は **この接続の権威的 membership**。新集合を claim し、この接続が
      // 所有していたが新集合に**無い** session は release (grace→presence false)。sidecar が reap して
      // hello 再送した終了済 session を Wall から落とす (INV-PRESENCE-RELEASE)。
      const next = new Set<string>();
      for (const sid of frame.session_ids) {
        if (typeof sid === "string" && sid.length > 0) next.add(sid);
      }
      for (const sid of next) this.claim(conn, sid);
      for (const sid of [...conn.sessions]) {
        if (!next.has(sid)) this.releaseSession(conn, sid);
      }
    }
    return true;
  }

  /**
   * authoritative hello で集合から外れた session の所有を解放し grace を張る (ADR 019eb365)。
   * 別接続が所有 (後勝ち再接続) していれば触らない (multiplex 安全)。即 false でなく grace 経由で
   * flapping を吸収する (connection close の remove と同経路)。
   */
  private releaseSession(conn: SidecarConn, sessionId: string): void {
    if (this.sessionOwner.get(sessionId) !== conn) return;
    conn.sessions.delete(sessionId);
    this.sessionOwner.delete(sessionId);
    this.startGrace(sessionId);
  }

  /**
   * ingest 観測から session 所有を学習する (hello を送らない接続でも対応付けは進む)。
   * ただし controlToken 未受領なら relay は依然拒否される (認可は token に依存)。
   */
  observeSession(link: SidecarLink, sessionId: string): void {
    const conn = this.conns.get(link);
    if (!conn) return;
    this.claim(conn, sessionId);
  }

  private claim(conn: SidecarConn, sessionId: string): void {
    // 変化検出は **状態変更の前**に評価する(grace 中は isLive=true のため、再 claim で
    // grace を cancel しても membership は true のまま= false→true の偽 delta を出さない)。
    const wasLive = this.isLive(sessionId);
    // grace 中の再 claim はタイマを cancel(flapping 吸収: 点滅させない)。
    const timer = this.graceTimers.get(sessionId);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.graceTimers.delete(sessionId);
    }
    conn.sessions.add(sessionId);
    this.sessionOwner.set(sessionId, conn); // 後勝ち (再接続が所有を引き継ぐ)
    // not-live → live への遷移のみ通知(接続が open のとき)。
    if (!wasLive && conn.link.open) this.emitPresence(sessionId, true);
  }

  /** close で所有解放した session の grace タイマを張る(満了で out 確定)。 */
  private startGrace(sessionId: string): void {
    const existing = this.graceTimers.get(sessionId);
    if (existing !== undefined) clearTimeout(existing); // 二重 close は最新起点で張り直す。
    const timer = setTimeout(() => {
      this.graceTimers.delete(sessionId);
      // 満了時点で再 claim されていなければ out 確定(claim は timer を cancel するため、
      // ここに到達=未再接続)。belt-and-suspenders で isLive を再確認。
      if (!this.isLive(sessionId)) this.emitPresence(sessionId, false);
    }, this.graceMs);
    // TDA-3 / SEC-2: grace タイマが唯一の生存理由なら event loop を止めない(embedded/test の
    // app.close() を遅延させない)。fake timer 環境では unref が無いことがあるため任意呼び出し。
    timer.unref?.();
    this.graceTimers.set(sessionId, timer);
  }

  /** presence 変化を全リスナへ通知(リスナ例外は presence 状態を壊さない)。 */
  private emitPresence(sessionId: string, live: boolean): void {
    for (const cb of this.presenceListeners) {
      try {
        cb(sessionId, live);
      } catch {
        // リスナ側の失敗は presence membership に波及させない。
      }
    }
  }

  /**
   * session が live(接続在席)か。一覧 membership の単一判定窓口(ADR 019ea2bf)。
   * 在席 = 所有接続が open、または grace 中。**controlToken の有無は無関係**
   * (presence は「起動中か」であり relay 認可とは直交)。
   */
  isLive(sessionId: string): boolean {
    if (this.graceTimers.has(sessionId)) return true; // grace 中は在席扱い。
    const conn = this.sessionOwner.get(sessionId);
    return !!conn && conn.link.open;
  }

  /**
   * 現在 presence 集合に居る session_id 群(grace 中も含む)。順序不定。
   *
   * 列挙/可観測性のための公開面(snapshot を registry 主導で一括 overlay したい将来用途、
   * および INV-LIVE-PRESENCE の検証)。**leak sink には載せない**(session_id をログ/送信路へ
   * 出さない: redaction 境界は sidecar、backend は projection のみ流す)。
   */
  liveSessionIds(): string[] {
    const ids = new Set<string>();
    for (const [sid, conn] of this.sessionOwner) {
      if (conn.link.open) ids.add(sid);
    }
    for (const sid of this.graceTimers.keys()) ids.add(sid);
    return [...ids];
  }

  /** presence membership 変化を購読する(delta.list 発火源として server が配線)。 */
  onPresenceChange(cb: PresenceListener): void {
    this.presenceListeners.push(cb);
  }

  /** pending grace タイマ数(テスト/監視: claim の cancel・dispose の clear を直接 pin する)。 */
  get pendingGraceCount(): number {
    return this.graceTimers.size;
  }

  /**
   * registry を破棄する(graceful shutdown / preClose)。pending grace タイマを全 clear し
   * presence リスナを解放する。TDA-3 / SEC-2: grace タイマ(setTimeout)が唯一の生存理由でも
   * app.close() 後の event loop 居座り(最大 graceMs)を防ぐ(unref と二重防御)。冪等。
   */
  dispose(): void {
    for (const timer of this.graceTimers.values()) clearTimeout(timer);
    this.graceTimers.clear();
    this.presenceListeners.length = 0;
    // 段階2: 未解決 diff 要求を安全側 reject し、タイマを解放する (本文は貯めていない)。
    for (const [, pending] of this.pendingDiffs) {
      clearTimeout(pending.timer);
      pending.resolve({ ok: false, error: "server shutting down" });
    }
    this.pendingDiffs.clear();
    // PAL-v2: 未解決 allowlist 要求も安全側 reject (応答を貯めていない)。
    for (const [, pending] of this.pendingAllowlist) {
      clearTimeout(pending.timer);
      pending.resolve({ ok: false, error: "server shutting down" });
    }
    this.pendingAllowlist.clear();
  }

  /** 接続数 (テスト/監視)。 */
  get connectionCount(): number {
    return this.conns.size;
  }

  /** session が relay 可能か (所有接続が open かつ controlToken 受領済み)。 */
  canRelay(sessionId: string): boolean {
    const conn = this.sessionOwner.get(sessionId);
    return !!conn && conn.link.open && typeof conn.controlToken === "string";
  }

  /**
   * UI 承認を対象 session の sidecar へ中継する。
   *
   * INV-APPROVAL / SSRF:
   *  - 未登録 session / 切断中 / controlToken 未受領 → relay せず失敗を返す
   *    (承認は届かず sidecar 側タイムアウトで安全側 deny に倒れる)。
   *  - controlToken を付与して sidecar の inbound 制御チャネル (WsClient) を通す。
   */
  relayApproval(relay: ApprovalRelay): RelayResult {
    const conn = this.sessionOwner.get(relay.session_id);
    if (!conn) return { ok: false, error: "session not registered" };
    if (!conn.link.open) return { ok: false, error: "sidecar disconnected" };
    if (typeof conn.controlToken !== "string") {
      return { ok: false, error: "no control channel (handshake incomplete)" };
    }
    const msg = {
      type: "approval" as const,
      request_id: relay.request_id,
      decision: relay.decision,
      token: conn.controlToken,
      ...(relay.reason !== undefined ? { reason: relay.reason } : {}),
      // ADR 019ee0c0: persist は true のときのみ載せる (sidecar が medium-bash 等の最終判定)。
      ...(relay.persist === true ? { persist: true } : {}),
    };
    try {
      conn.link.send(JSON.stringify(msg));
      return { ok: true };
    } catch {
      return { ok: false, error: "relay send failed" };
    }
  }

  /** UI interrupt を対象 session の sidecar へ中継する (承認と同じ認可境界)。 */
  relayInterrupt(sessionId: string): RelayResult {
    const conn = this.sessionOwner.get(sessionId);
    if (!conn) return { ok: false, error: "session not registered" };
    if (!conn.link.open) return { ok: false, error: "sidecar disconnected" };
    if (typeof conn.controlToken !== "string") {
      return { ok: false, error: "no control channel (handshake incomplete)" };
    }
    const msg = { type: "interrupt" as const, session_id: sessionId, token: conn.controlToken };
    try {
      conn.link.send(JSON.stringify(msg));
      return { ok: true };
    } catch {
      return { ok: false, error: "relay send failed" };
    }
  }

  /**
   * 段階2 (ADR 019ea4ba D2-B): 対象 session の sidecar へ diff 本文 **要求** を中継し、
   * 応答 (diff.response) を待って返す round-trip。
   *
   * INV-DETAIL-PULL-AUTH / SSRF (relayApproval/relayInterrupt と同一境界):
   *  - 未登録 session / 切断中 / controlToken 未受領 → 即 reject (任意 URL/PID へ到達しない)。
   *  - diff 要求には controlToken を付与する。sidecar は token 不一致を fail-safe deny で破棄するため、
   *    handshake で受け取った token を持つ正当な接続のみが応答できる。
   *  - **backend は diff 本文を生成も再 redaction も永続もしない** (sidecar が唯一の choke point)。
   *    pending Promise を解決して HTTP 応答へ直渡しし、解決後はメモリから即破棄する (at-rest なし)。
   *  - 応答が来ない (sidecar 不調 / 接続断) ときは diffTimeoutMs で安全側 reject。
   */
  requestDiff(sessionId: string): Promise<DiffRelayResult> {
    const conn = this.sessionOwner.get(sessionId);
    if (!conn) return Promise.resolve({ ok: false, error: "session not registered" });
    if (!conn.link.open) return Promise.resolve({ ok: false, error: "sidecar disconnected" });
    if (typeof conn.controlToken !== "string") {
      return Promise.resolve({ ok: false, error: "no control channel (handshake incomplete)" });
    }
    const requestId = randomUUID();
    return new Promise<DiffRelayResult>((resolve) => {
      const timer = setTimeout(() => {
        this.pendingDiffs.delete(requestId);
        resolve({ ok: false, error: "diff request timed out" });
      }, this.diffTimeoutMs);
      timer.unref?.();
      this.pendingDiffs.set(requestId, { resolve, timer });
      const msg = {
        type: "diff.request" as const,
        request_id: requestId,
        session_id: sessionId,
        token: conn.controlToken,
      };
      try {
        conn.link.send(JSON.stringify(msg));
      } catch {
        clearTimeout(timer);
        this.pendingDiffs.delete(requestId);
        resolve({ ok: false, error: "relay send failed" });
      }
    });
  }

  /**
   * 段階2: sidecar からの diff.response を該当 pending 要求へ解決する (ingestion-server が配線)。
   * request_id が未知 (タイムアウト済 / 二重応答) なら no-op。本文は redaction 済みである前提
   * (backend は再 redaction しない)。解決後は pending から即破棄して本文を保持しない。
   */
  resolveDiff(frame: {
    request_id?: unknown;
    body?: unknown;
    truncated?: unknown;
    secret_detected?: unknown;
    redaction_count?: unknown;
  }): void {
    if (typeof frame.request_id !== "string") return;
    const pending = this.pendingDiffs.get(frame.request_id);
    if (!pending) return; // 未知 / タイムアウト済 → 黙殺。
    clearTimeout(pending.timer);
    this.pendingDiffs.delete(frame.request_id);
    pending.resolve({
      ok: true,
      diff: {
        body: typeof frame.body === "string" ? frame.body : "",
        truncated: frame.truncated === true,
        secret_detected: frame.secret_detected === true,
        redaction_count:
          typeof frame.redaction_count === "number" && Number.isFinite(frame.redaction_count)
            ? frame.redaction_count
            : 0,
      },
    });
  }

  /** pending diff 要求数 (テスト/監視: タイムアウト・解決後の破棄を pin する)。 */
  get pendingDiffCount(): number {
    return this.pendingDiffs.size;
  }

  /**
   * PAL-v2 (ADR 019ee147): 対象 session の sidecar へ allowlist の list/revoke 要求を中継し、
   * 応答 (allowlist.response) を待って返す round-trip (requestDiff と同一境界・対称実装)。
   *
   * INV-PAL-V2-RELAY-SCOPE / SSRF (relayApproval/requestDiff と同一境界):
   *  - 未登録 session / 切断中 / controlToken 未受領 → 即 reject (任意 URL/PID へ到達しない)。
   *  - 要求に controlToken を付与する。sidecar は token 不一致を fail-safe deny で破棄するため、
   *    handshake で受け取った token を持つ正当な接続のみが応答できる。
   *  - allowlist は **machine-global**。session_id は宛先解決にのみ使い、entries は session 非依存。
   *  - **backend は entries を生成も永続もしない** (sidecar の NO-RAW ビューを直渡し)。解決後即破棄。
   *  - 応答が来ない (sidecar 不調 / 接続断) ときは allowlistTimeoutMs で安全側 reject。
   */
  requestAllowlist(
    sessionId: string,
    op: "list" | "revoke",
    signature?: string,
    repoScope?: string,
  ): Promise<AllowlistRelayResult> {
    const conn = this.sessionOwner.get(sessionId);
    if (!conn) return Promise.resolve({ ok: false, error: "session not registered" });
    if (!conn.link.open) return Promise.resolve({ ok: false, error: "sidecar disconnected" });
    if (typeof conn.controlToken !== "string") {
      return Promise.resolve({ ok: false, error: "no control channel (handshake incomplete)" });
    }
    const requestId = randomUUID();
    return new Promise<AllowlistRelayResult>((resolve) => {
      const timer = setTimeout(() => {
        this.pendingAllowlist.delete(requestId);
        resolve({ ok: false, error: "allowlist request timed out" });
      }, this.allowlistTimeoutMs);
      timer.unref?.();
      this.pendingAllowlist.set(requestId, { resolve, timer });
      const msg = {
        type: "allowlist.request" as const,
        request_id: requestId,
        op,
        token: conn.controlToken,
        ...(signature !== undefined ? { signature } : {}),
        ...(repoScope !== undefined ? { repo_scope: repoScope } : {}),
      };
      try {
        conn.link.send(JSON.stringify(msg));
      } catch {
        clearTimeout(timer);
        this.pendingAllowlist.delete(requestId);
        resolve({ ok: false, error: "relay send failed" });
      }
    });
  }

  /**
   * PAL-v2: sidecar からの allowlist.response を該当 pending 要求へ解決する (ingestion-server が配線)。
   * request_id 未知 (タイムアウト済 / 二重応答) なら no-op。entries は NO-RAW 前提
   * (backend は再構築しない)。解決後は pending から即破棄して応答を保持しない。
   * 構造検証: entries の各要素を allow-list フィールドのみへ畳む (敵対 sidecar の余剰 raw を載せない)。
   */
  resolveAllowlist(frame: {
    request_id?: unknown;
    enabled?: unknown;
    entries?: unknown;
    removed?: unknown;
  }): void {
    if (typeof frame.request_id !== "string") return;
    const pending = this.pendingAllowlist.get(frame.request_id);
    if (!pending) return; // 未知 / タイムアウト済 → 黙殺。
    clearTimeout(pending.timer);
    this.pendingAllowlist.delete(frame.request_id);
    const rawEntries = Array.isArray(frame.entries) ? frame.entries : [];
    const entries: AllowlistEntry[] = [];
    for (const e of rawEntries) {
      if (typeof e !== "object" || e === null) continue;
      const r = e as Record<string, unknown>;
      // allow-list 投影: 既知フィールドのみ・型不一致は除外 (余剰 key / raw は構造的に落とす)。
      if (typeof r.signature !== "string" || typeof r.repo_scope !== "string") continue;
      entries.push({
        signature: r.signature,
        repo_scope: r.repo_scope,
        ...(typeof r.repo_label === "string" ? { repo_label: r.repo_label } : {}),
        risk: typeof r.risk === "string" ? r.risk : "",
        created_at_ms:
          typeof r.created_at_ms === "number" && Number.isFinite(r.created_at_ms)
            ? r.created_at_ms
            : 0,
        expires_at_ms:
          typeof r.expires_at_ms === "number" && Number.isFinite(r.expires_at_ms)
            ? r.expires_at_ms
            : 0,
      });
    }
    pending.resolve({
      ok: true,
      enabled: frame.enabled === true,
      entries,
      ...(typeof frame.removed === "number" && Number.isFinite(frame.removed)
        ? { removed: frame.removed }
        : {}),
    });
  }

  /** pending allowlist 要求数 (テスト/監視: タイムアウト・解決後の破棄を pin する)。 */
  get pendingAllowlistCount(): number {
    return this.pendingAllowlist.size;
  }
}
