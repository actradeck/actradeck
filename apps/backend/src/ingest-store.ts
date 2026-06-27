/**
 * 冪等 Event Store append + session_state projection (Phase 3 backend core).
 *
 * 不変条件 (decision 019e900c / ingestion-events.md):
 * - **append-only**: events を破壊的に更新しない。
 * - **INV-IDEMPOTENCY**: 同一 event_id の再送で重複行ゼロ・projection も二重適用しない。
 *   1 トランザクション内で `INSERT ... ON CONFLICT (event_id) DO NOTHING` を行い、
 *   rowCount=0 (= 既取り込み) なら projection 更新を **skip** する。
 * - **INV-EVENT-ORDER**: out-of-order timestamp は MonotonicTimestampChecker で観測するが
 *   イベントは落とさない (append-only)。順序診断は ingest 結果に含めて返す。
 * - **INV-STATE-TRANSITION**: reducer (純関数) を新規行にのみ適用し、terminal 後 / 不正遷移は
 *   安全側に倒す。
 *
 * トランザクション境界: sessions upsert (FK 充足) → events insert → projection upsert を
 * 単一 BEGIN..COMMIT で行う。失敗は ROLLBACK。
 */
import {
  ALL_EVENT_TYPES,
  ALL_STATES,
  BoundedMonotonicTimestampChecker,
  FILE_EVENT_TYPES,
  isActionKind,
  MODEL_STREAM_EVENT_TYPES,
  type ActionKind,
  type NormalizedEvent,
  newEventId,
  gateRedactionCountByKind,
  PROCESS_ALIVE_PAYLOAD_KEY,
  safeParseEvent,
  STDOUT_EVENT_TYPES,
  toEpochMs,
} from "@actradeck/event-model";
import type { Pool, PoolClient } from "pg";

import {
  synthesizeLiveness,
  type LivenessObservation,
  type LivenessResult,
  type SynthesizeOptions,
} from "./liveness.js";
import {
  applyEvent,
  initialProjection,
  parsePendingApprovals,
  type SessionProjection,
} from "./reducer.js";

/**
 * TDA-2: liveness 集約クエリ用の event_type グルーピングは event-model の T1 正典
 * (liveness-signals.ts) を **唯一参照**する。observeFromEvents (TS) と aggregateObservation
 * (SQL) が同じ定数を使うことで分類のドリフトを防ぐ (SQL 側へ再定義しない)。
 */
const STDOUT_TYPES = STDOUT_EVENT_TYPES;
const FILE_TYPES = FILE_EVENT_TYPES;
const MODEL_STREAM_TYPES = MODEL_STREAM_EVENT_TYPES;

/** 1 イベント取り込みの結果。冪等・順序・状態の診断を返す。 */
export interface IngestResult {
  /** 新規に永続化されたか (false = 既取り込みの重複 → 冪等 no-op)。 */
  readonly inserted: boolean;
  /** session 内 timestamp が単調 (>= 直近) だったか。false でもイベントは落とさない。 */
  readonly monotonic: boolean;
  /** 適用後の projection (重複時は既存値、初回時は適用済み)。 */
  readonly projection: SessionProjection;
  /** 合成 liveness (取り込み直後の最新イベント列から再計算)。 */
  readonly liveness: LivenessResult;
  /** このイベントの state 変更が不正遷移だったか (state ありイベントのみ)。 */
  readonly invalidTransition: boolean;
}

export interface IngestStoreOptions {
  readonly pool: Pool;
  /** liveness 判定オプション (テストで now/閾値固定)。 */
  readonly livenessOptions?: SynthesizeOptions;
  /** TDA-3: 順序チェッカが保持する最大セッション数 (LRU 上限)。既定 10_000。 */
  readonly monotonicMaxSessions?: number;
  /** TDA-3: 順序チェッカ TTL(ms)。未指定なら LRU 上限のみで bound。 */
  readonly monotonicTtlMs?: number;
}

/**
 * Event Store への冪等 append + projection 更新を担うコア。
 *
 * 順序チェッカはプロセス内のセッション順序観測に使う (永続診断ではなく受信時の順序揺れ
 * 検出)。再起動で状態は失われてよい (append-only の DB が真実)。
 *
 * TDA-3: long-running プロセスで distinct session_id が無制限に増えても Map が肥大化しない
 * よう **BoundedMonotonicTimestampChecker (LRU 上限 + 任意 TTL)** を使う。terminal での単純
 * reset は at-least-once 再送の巻き戻り検出を失うため採らない (LRU で活動中のみ保持)。
 */
export class IngestStore {
  private readonly pool: Pool;
  private readonly monotonic: BoundedMonotonicTimestampChecker;
  private readonly livenessOptions: SynthesizeOptions | undefined;

  constructor(opts: IngestStoreOptions) {
    this.pool = opts.pool;
    this.livenessOptions = opts.livenessOptions;
    this.monotonic = new BoundedMonotonicTimestampChecker({
      ...(opts.monotonicMaxSessions !== undefined
        ? { maxSessions: opts.monotonicMaxSessions }
        : {}),
      ...(opts.monotonicTtlMs !== undefined ? { ttlMs: opts.monotonicTtlMs } : {}),
    });
  }

  /** TDA-3: 順序チェッカが現在保持するセッション数 (テスト/監視用。常に <= 上限)。 */
  get monotonicTrackedSessions(): number {
    return this.monotonic.size;
  }

  /**
   * 検証済み NormalizedEvent を 1 件取り込む。
   *
   * 順序: 監視 (monotonic 観測) → tx 内で sessions upsert → events insert (ON CONFLICT
   * DO NOTHING) → 新規時のみ projection を reducer で更新 → liveness 合成。重複時は
   * projection を読み出して返すのみ (二重適用しない)。
   */
  async ingest(ev: NormalizedEvent): Promise<IngestResult> {
    // 順序診断 (イベントは落とさない: append-only)。
    const monotonic = this.monotonic.accept(ev.session_id, ev.timestamp);

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");

      // FK 充足: 親 sessions を冪等 upsert。session.started 以外でも到達しうるため先行。
      await this.upsertSession(client, ev);

      // 冪等 append: 同一 event_id は DO NOTHING (重複行ゼロ)。
      const ins = await client.query(
        `INSERT INTO events
           (id, event_id, provider, source, session_id, thread_id, turn_id, agent_id,
            event_type, state, timestamp, cwd, summary, payload, metrics)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$15::jsonb)
         ON CONFLICT (event_id) DO NOTHING`,
        [
          newEventId(), // 内部 PK (時系列ソート可能)。
          ev.event_id,
          ev.provider,
          ev.source,
          ev.session_id,
          ev.thread_id ?? null,
          ev.turn_id ?? null,
          ev.agent_id ?? null,
          ev.event_type,
          ev.state ?? null,
          new Date(toEpochMs(ev.timestamp)).toISOString(),
          ev.cwd ?? null,
          ev.summary ?? null,
          JSON.stringify(ev.payload ?? {}),
          JSON.stringify(ev.metrics ?? {}),
        ],
      );

      const inserted = (ins.rowCount ?? 0) > 0;

      if (!inserted) {
        // TDA-2: 冪等 no-op は **新情報ゼロ**。projection も liveness も再計算しない。
        // 永続済みの session_state (projection + liveness jsonb) を 1 回の読出で返す
        // (旧実装はここでも 500 行 SELECT + 全合成して O(N^2) を招いていた)。
        const persisted = await this.readPersistedState(client, ev.session_id);
        await client.query("COMMIT");
        return {
          inserted: false,
          monotonic,
          projection: persisted.projection,
          liveness: persisted.liveness,
          invalidTransition: false,
        };
      }

      // 新規行: 現 projection を読み (なければ初期) → reducer 適用 → upsert。
      const prev = await this.readProjection(client, ev.session_id);
      const { projection: next, invalidTransition } = applyEvent(prev, ev);

      // TDA-2: liveness は per-signal の集約クエリ (条件付き MAX) で導出する。全件 (≤500 行)
      // を読み込み safeParseEvent で再検証する旧実装は N 増加で O(N^2) だった。集約は
      // インデックス走査 1 回で各シグナルの最終時刻 + 最新 heartbeat 生死のみを取る。
      const liveness = await this.computeLivenessAggregated(client, ev.session_id);

      await this.upsertProjection(client, next, liveness);

      await client.query("COMMIT");
      return { inserted: true, monotonic, projection: next, liveness, invalidTransition };
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  /** sessions を冪等 upsert (FK 親)。session.started payload からメタを拾う。 */
  private async upsertSession(client: PoolClient, ev: NormalizedEvent): Promise<void> {
    const payload = (ev.payload ?? {}) as { repo?: unknown; branch?: unknown };
    const repo = typeof payload.repo === "string" ? payload.repo : null;
    const branch = typeof payload.branch === "string" ? payload.branch : null;
    const isStart = ev.event_type === "session.started";
    // ADR 019ea4ba D4 / TDA-1: capture_mode を sessions 行へ投影する。NormalizedEvent.capture_mode
    // は optional (欠落 = managed 既定; T1 寛容)。**projection key には使わない**。
    // COALESCE で sticky にし、一度 attach が観測されたら後続の欠落イベントで managed へ戻さない
    // (= attach daemon 経路は全 emit に capture_mode=attach を被せる前提・観測モードは session 不変)。
    const captureMode = ev.capture_mode ?? null;
    // 段階2 (ADR 019ea4ba D3): permission_mode (sandbox) を sessions 行へ投影。
    //   capture_mode (観測モード = session 不変) と異なり permission_mode は session 途中で
    //   変わりうる (default→acceptEdits 等) ため、**欠落時のみ既存維持** (COALESCE で NULL 上書き回避)・
    //   非欠落なら最新値で更新する (last-non-null-wins)。表示専用・projection key 非使用。
    const permissionMode =
      typeof ev.permission_mode === "string" && ev.permission_mode.length > 0
        ? ev.permission_mode
        : null;
    await client.query(
      `INSERT INTO sessions (session_id, provider, source, agent_id, repo, branch, cwd, started_at, capture_mode, permission_mode)
       VALUES ($1,$2,$3,$4,$5,$6,$7, CASE WHEN $8 THEN $9::timestamptz ELSE NULL END, $10, $11)
       ON CONFLICT (session_id) DO UPDATE SET
         agent_id = COALESCE(EXCLUDED.agent_id, sessions.agent_id),
         repo     = COALESCE(EXCLUDED.repo, sessions.repo),
         branch   = COALESCE(EXCLUDED.branch, sessions.branch),
         cwd      = COALESCE(EXCLUDED.cwd, sessions.cwd),
         started_at = COALESCE(sessions.started_at, EXCLUDED.started_at),
         capture_mode = COALESCE(EXCLUDED.capture_mode, sessions.capture_mode),
         permission_mode = COALESCE(EXCLUDED.permission_mode, sessions.permission_mode),
         updated_at = now()`,
      [
        ev.session_id,
        ev.provider,
        ev.source,
        ev.agent_id ?? null,
        repo,
        branch,
        ev.cwd ?? null,
        isStart,
        new Date(toEpochMs(ev.timestamp)).toISOString(),
        captureMode,
        permissionMode,
      ],
    );
  }

  /** 現在の projection を読む (なければ初期 projection)。 */
  private async readProjection(client: PoolClient, sessionId: string): Promise<SessionProjection> {
    const { rows } = await client.query(
      `SELECT session_id, state, current_action, current_action_kind, current_action_subject,
              last_event_id, last_event_at,
              needs_attention, liveness, pending_approvals,
              secret_detected, secret_redaction_count, secret_redaction_count_by_kind
         FROM session_state WHERE session_id = $1`,
      [sessionId],
    );
    if (rows.length === 0) return initialProjection(sessionId);
    const r = rows[0] as {
      session_id: string;
      state: string | null;
      current_action: string | null;
      current_action_kind: string | null;
      current_action_subject: string | null;
      last_event_id: string | null;
      last_event_at: Date | null;
      needs_attention: boolean;
      liveness: { invalid_transition_count?: number } | null;
      pending_approvals: unknown;
      secret_detected: boolean | null;
      secret_redaction_count: number | null;
      secret_redaction_count_by_kind: unknown;
    };
    return {
      session_id: r.session_id,
      state: (r.state ?? undefined) as SessionProjection["state"],
      current_action: r.current_action ?? undefined,
      // 表示時ローカライズ (ADR 019eeac6): kind は DB text を isActionKind で gate (未知値は
      //   undefined・forward-compat)。subject は redacted な構造値ゆえそのまま (NULL→undefined)。
      current_action_kind: toActionKind(r.current_action_kind),
      current_action_subject: r.current_action_subject ?? undefined,
      last_event_id: r.last_event_id ?? undefined,
      last_event_at: r.last_event_at ? r.last_event_at.toISOString() : undefined,
      needs_attention: r.needs_attention,
      pending_approvals: parsePendingApprovals(r.pending_approvals),
      invalid_transition_count: r.liveness?.invalid_transition_count ?? 0,
      // QA-1: DB NULL (= 旧行・未観測) は fold 内部では false/0 起点に潰してよい。これは
      //   「prior 未観測 + 新 event」の畳み込みが「prior=false/0 + 新 event」と恒等だから
      //   (NULL≡未加算)。**この coalesce は fold 入力限定**で、結果は upsertProjection が
      //   観測値 (false/0 or true/N) として必ず書き戻すため NULL のまま残らない。
      //   「未観測」を保持して UI に誤った安心を与えない責務は **DTO 側** (realtime-store
      //   rowToDetail が NULL→キー落とし=undefined) が負う。役割分担を分ける。
      secret_detected: r.secret_detected ?? false,
      secret_redaction_count:
        typeof r.secret_redaction_count === "number" ? r.secret_redaction_count : 0,
      // 強み(a)③: kind 別累積。NULL (旧行) は {} 起点 (NULL≡未加算で fold 恒等)。
      secret_redaction_count_by_kind: parseRedactionCountByKind(r.secret_redaction_count_by_kind),
    };
  }

  /** projection + liveness を session_state へ upsert。 */
  private async upsertProjection(
    client: PoolClient,
    proj: SessionProjection,
    liveness: LivenessResult,
  ): Promise<void> {
    // liveness jsonb に「合成結果 + 不正遷移カウント」を分解保持する (UI が根拠表示できる)。
    const livenessJson = JSON.stringify({
      state: liveness.state,
      reason: liveness.reason,
      stalled_suspected: liveness.stalledSuspected,
      evaluated_at_ms: liveness.evaluatedAtMs,
      evidence: liveness.evidence,
      invalid_transition_count: proj.invalid_transition_count,
    });
    // needs_attention は reducer の承認待ち判定 OR liveness が stalled 候補。
    const needsAttention = proj.needs_attention || liveness.stalledSuspected;
    // pending_approvals は reducer 由来 (redaction 済み)。jsonb 配列で永続する。
    const pendingApprovalsJson = JSON.stringify(proj.pending_approvals ?? []);
    // 強み(a)③: kind 別件数を jsonb で永続する (件数 + kind 名のみ・秘匿値非保持)。
    const secretRedactionCountByKindJson = JSON.stringify(
      proj.secret_redaction_count_by_kind ?? {},
    );
    await client.query(
      `INSERT INTO session_state
         (session_id, state, current_action, current_action_kind, current_action_subject,
          last_event_id, last_event_at,
          liveness, needs_attention, pending_approvals,
          secret_detected, secret_redaction_count, secret_redaction_count_by_kind, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10::jsonb,$11,$12,$13::jsonb, now())
       ON CONFLICT (session_id) DO UPDATE SET
         state                          = EXCLUDED.state,
         current_action                 = EXCLUDED.current_action,
         current_action_kind            = EXCLUDED.current_action_kind,
         current_action_subject         = EXCLUDED.current_action_subject,
         last_event_id                  = EXCLUDED.last_event_id,
         last_event_at                  = EXCLUDED.last_event_at,
         liveness                       = EXCLUDED.liveness,
         needs_attention                = EXCLUDED.needs_attention,
         pending_approvals              = EXCLUDED.pending_approvals,
         secret_detected                = EXCLUDED.secret_detected,
         secret_redaction_count         = EXCLUDED.secret_redaction_count,
         secret_redaction_count_by_kind = EXCLUDED.secret_redaction_count_by_kind,
         updated_at                     = now()`,
      [
        proj.session_id,
        // TDA-1: first-observation 未確定 (undefined) は **NULL** で永続する。
        // "created" を貼ると DB round-trip 後に「未確定」と「本物の created」が区別不能になり、
        // 次の ingest で running.* が created→running の不正遷移として詰まる (KPI 違反)。
        // readProjection が NULL→undefined で復元することで reducer の first-observation
        // 意味論 (current undefined のとき遷移検査せず running.* を accept) を DB 跨ぎで保つ。
        proj.state ?? null,
        proj.current_action ?? null,
        // 表示時ローカライズ (ADR 019eeac6): kind/subject を additive で永続。undefined は NULL。
        proj.current_action_kind ?? null,
        proj.current_action_subject ?? null,
        proj.last_event_id ?? null,
        proj.last_event_at ? new Date(toEpochMs(proj.last_event_at)).toISOString() : null,
        livenessJson,
        needsAttention,
        pendingApprovalsJson,
        // secret_detected の session 単位投影 (projection 由来; 件数のみ・秘匿値非保持)。
        proj.secret_detected,
        proj.secret_redaction_count,
        secretRedactionCountByKindJson,
      ],
    );
  }

  /**
   * TDA-2: セッションの liveness を **集約クエリ 1 回**で合成する (O(N) インデックス走査)。
   *
   * 観測の導出 (各シグナルの最終時刻 + 最新 heartbeat 生死) は本番経路の正典
   * `aggregateObservationSql` に委譲し、その出力を synthesizeLiveness で状態へ写す。
   * `aggregateObservationSql` は parity テストで TS リファレンス `observeFromEvents` と縛られる
   * (TDA-1 退行ガード)。旧 computeLiveness の O(N^2) 全行再検証は廃した (memory 教訓1)。
   */
  private async computeLivenessAggregated(
    client: PoolClient,
    sessionId: string,
  ): Promise<LivenessResult> {
    const obs = await aggregateObservationSql(client, sessionId);
    return synthesizeLiveness(obs, this.livenessOptions);
  }

  /**
   * TDA-2: 永続済み session_state から projection + liveness を 1 回の読出で復元する
   * (冪等 no-op 用。再計算しない)。session_state が無ければ初期 projection + unknown liveness。
   */
  private async readPersistedState(
    client: PoolClient,
    sessionId: string,
  ): Promise<{ projection: SessionProjection; liveness: LivenessResult }> {
    const { rows } = await client.query(
      `SELECT session_id, state, current_action, current_action_kind, current_action_subject,
              last_event_id, last_event_at,
              needs_attention, liveness, pending_approvals,
              secret_detected, secret_redaction_count, secret_redaction_count_by_kind
         FROM session_state WHERE session_id = $1`,
      [sessionId],
    );
    if (rows.length === 0) {
      // 重複だが projection 未作成 (理論上 race のみ)。安全に初期値 + unknown を返す。
      return {
        projection: initialProjection(sessionId),
        liveness: synthesizeLiveness({}, this.livenessOptions),
      };
    }
    const r = rows[0] as {
      session_id: string;
      state: string | null;
      current_action: string | null;
      current_action_kind: string | null;
      current_action_subject: string | null;
      last_event_id: string | null;
      last_event_at: Date | null;
      needs_attention: boolean;
      liveness: PersistedLiveness | null;
      pending_approvals: unknown;
      secret_detected: boolean | null;
      secret_redaction_count: number | null;
      secret_redaction_count_by_kind: unknown;
    };
    const projection: SessionProjection = {
      session_id: r.session_id,
      state: (r.state ?? undefined) as SessionProjection["state"],
      current_action: r.current_action ?? undefined,
      current_action_kind: toActionKind(r.current_action_kind),
      current_action_subject: r.current_action_subject ?? undefined,
      last_event_id: r.last_event_id ?? undefined,
      last_event_at: r.last_event_at ? r.last_event_at.toISOString() : undefined,
      needs_attention: r.needs_attention,
      pending_approvals: parsePendingApprovals(r.pending_approvals),
      invalid_transition_count: r.liveness?.invalid_transition_count ?? 0,
      secret_detected: r.secret_detected ?? false,
      secret_redaction_count:
        typeof r.secret_redaction_count === "number" ? r.secret_redaction_count : 0,
      secret_redaction_count_by_kind: parseRedactionCountByKind(r.secret_redaction_count_by_kind),
    };
    return { projection, liveness: reconstructLiveness(r.liveness) };
  }
}

/**
 * TDA-2 / TDA-1 parity 基準: セッションの LivenessObservation を **集約クエリ 1 回**で導出する
 * (本番経路の正典)。`observeFromEvents` (TS リファレンス実装) と **同一の観測結果**を返すことを
 * parity テストで縛る。両者が乖離すると TDA-1 のような本番 stalled 誤判定が混入するため、この
 * 関数を export し observeFromEvents と直接突き合わせ可能にする。
 *
 * 各シグナルの「最終観測時刻」を条件付き MAX(timestamp) で 1 パス集約する:
 *  - event: process_alive **boolean false** の heartbeat (死亡通知) **のみ**を除外した活動の
 *    最新時刻。naked heartbeat (process_alive 無し) / process_alive:true / 非 heartbeat は活動
 *    として数える (observeFromEvents と厳密一致)。
 *  - stdout / file / modelStream: event-model の T1 分類 (liveness-signals.ts) に属する最新時刻。
 *  - process: 最新 heartbeat 行を full T1 検証してから process_alive と観測時刻を採用。
 *
 * M4 (TDA-6) との整合: 集約は **enum 妥当な行のみ** を対象 (event_type/state を T1 enum で
 * フィルタ)。enum リストは T1 (ALL_EVENT_TYPES / ALL_STATES) を唯一参照し SQL へ再定義しない。
 */
export async function aggregateObservationSql(
  client: PoolClient,
  sessionId: string,
): Promise<LivenessObservation> {
  const validTypes = ALL_EVENT_TYPES as readonly string[];
  const validStates = ALL_STATES as readonly string[];
  // 集約: 各シグナルの最終時刻 (条件付き MAX) + 最新 heartbeat 行の全列を 1 クエリで取る。
  // $1 sessionId, $2 validTypes, $3 validStates, $4 stdout, $5 file, $6 model types
  const { rows } = await client.query(
    `WITH valid AS (
       SELECT * FROM events
        WHERE session_id = $1
          AND event_type = ANY($2::text[])
          AND (state IS NULL OR state = ANY($3::text[]))
     ),
     agg AS (
       SELECT
         -- event: 死亡通知 heartbeat (process_alive=false) **のみ**を除外した活動の最新時刻。
         -- TDA-2 正典: 除外は **真の JSON boolean false** のときだけ。TS observeFromEvents の
         -- "typeof alive === boolean && alive === false" ゲートと鏡写し。
         --   payload->'process_alive' は jsonb 値を返す (->> の text 化ではない):
         --     - JSON boolean false → 'false'::jsonb に一致 → 除外。
         --     - JSON 文字列 "false" → '"false"'::jsonb なので一致せず → **活動として数える**
         --       (boolean でないため TS も活動扱い)。
         --     - 数値 0 / naked (キー無し=NULL) → 一致せず → 活動。
         -- これにより loose record で保存されうる文字列 "false" / 数値 0 で SQL と TS が乖離しない。
         -- 3値論理ガード: naked heartbeat は payload->'process_alive' が NULL となり、
         -- NULL = 'false'::jsonb は UNKNOWN → FILTER(WHERE NULL) で誤って除外されるため、
         -- COALESCE(..., false) で「boolean false に一致したときだけ true」へ畳む。
         max(extract(epoch from timestamp) * 1000)
           FILTER (WHERE NOT (event_type = 'heartbeat'
                              AND COALESCE(payload->'process_alive' = 'false'::jsonb, false)))
             AS event_ms,
         max(extract(epoch from timestamp) * 1000)
           FILTER (WHERE event_type = ANY($4::text[])) AS stdout_ms,
         max(extract(epoch from timestamp) * 1000)
           FILTER (WHERE event_type = ANY($5::text[])) AS file_ms,
         max(extract(epoch from timestamp) * 1000)
           FILTER (WHERE event_type = ANY($6::text[])) AS model_ms
         FROM valid
     ),
     hb AS (
       -- process 生死を確定できる最新 heartbeat 行 (full 列)。
       -- TDA-2 parity: TS observeFromEvents は process_alive が **真の JSON boolean** の
       -- heartbeat だけで process を更新する。文字列 "true"/"false" や数値は typed heartbeat
       -- として採用しない。よって SQL も payload->'process_alive' ∈ {true,false}::jsonb
       -- (jsonb boolean) でフィルタし、naked (キー無し) / 文字列 / 数値を除外する。
       -- naked heartbeat (process_alive 無し) が最新でも、それより古い typed heartbeat の
       -- 生死を保持する (naked を最新 heartbeat として掴んで process を取りこぼさない)。
       --
       -- TDA-1 tie-break 正典: 同一 max-timestamp の typed heartbeat が複数ある場合の勝者は
       -- **event_id 最大**。SQL の PK id (DB 内部採番) は TS から不可視で、配列順は SQL から
       -- 不可視のため、両側が共有できる唯一の安定キーである event_id (UUIDv7) を tie-break に
       -- 使う。observeFromEvents も同一規約 (timestamp 最新 → event_id 最大) で揃える
       -- (INV-LIVENESS-PARITY が同一 timestamp / opposite-alive ペアで縛る)。
       SELECT event_id, provider, source, session_id, thread_id, turn_id, agent_id,
              event_type, state, timestamp, cwd, summary, payload, metrics
         FROM valid
        WHERE event_type = 'heartbeat'
          AND payload->'process_alive' IN ('true'::jsonb, 'false'::jsonb)
        ORDER BY timestamp DESC, event_id DESC
        LIMIT 1
     )
     SELECT agg.event_ms, agg.stdout_ms, agg.file_ms, agg.model_ms,
            to_jsonb(hb.*) AS hb_row
       FROM agg LEFT JOIN hb ON true`,
    [
      sessionId,
      validTypes,
      validStates,
      STDOUT_TYPES as readonly string[],
      FILE_TYPES as readonly string[],
      MODEL_STREAM_TYPES as readonly string[],
    ],
  );

  const r = rows[0] as
    | {
        event_ms: string | number | null;
        stdout_ms: string | number | null;
        file_ms: string | number | null;
        model_ms: string | number | null;
        hb_row: EventRow | null;
      }
    | undefined;

  const num = (v: string | number | null | undefined): number | undefined => {
    if (v === null || v === undefined) return undefined;
    const n = typeof v === "number" ? v : Number(v);
    return Number.isFinite(n) ? n : undefined;
  };

  const out: {
    process?: { alive: boolean; atMs: number };
    event?: { atMs: number };
    stdout?: { atMs: number };
    file?: { atMs: number };
    modelStream?: { atMs: number };
  } = {};

  if (r) {
    const eventMs = num(r.event_ms);
    const stdoutMs = num(r.stdout_ms);
    const fileMs = num(r.file_ms);
    const modelMs = num(r.model_ms);
    if (eventMs !== undefined) out.event = { atMs: eventMs };
    if (stdoutMs !== undefined) out.stdout = { atMs: stdoutMs };
    if (fileMs !== undefined) out.file = { atMs: fileMs };
    if (modelMs !== undefined) out.modelStream = { atMs: modelMs };

    // M4: 最新 heartbeat 行を full T1 検証 (safeParseEvent)。契約違反なら process 未観測扱い。
    if (r.hb_row) {
      const hbEvent = validateRowForLiveness(r.hb_row, sessionId);
      if (hbEvent !== null) {
        const alive = (hbEvent.payload as Record<string, unknown>)[PROCESS_ALIVE_PAYLOAD_KEY];
        const atMs = num(extractMs(r.hb_row.timestamp));
        if (typeof alive === "boolean" && atMs !== undefined) {
          out.process = { alive, atMs };
        }
      }
    }
  }
  return out;
}

/**
 * TDA-6 / M4: 単一 DB 行を T1 (@actradeck/event-model safeParseEvent) で **検証**する。
 *
 * TDA-2 で liveness 合成を集約クエリ化したため、全行を rowToEvent で再検証する経路は
 * 廃した。ただし M4 の契約 (Event Store から読んだ行も T1 を満たすことを強制し、契約違反行を
 * liveness へ流入させない) は維持する:
 *  - 集約クエリは enum 妥当な行のみを対象 (event_type/state を T1 enum でフィルタ)。これが
 *    M4 の観測契約 (不正 event_type / out-of-enum state 行を liveness から除外) を満たす。
 *  - liveness が唯一 payload を参照する **最新 heartbeat 行** だけは、本関数で safeParseEvent に
 *    よる full T1 検証を通し、契約違反なら除外する (payload 汚染の防御)。
 *
 * 戻り値 null = この行は契約違反のため liveness 合成から除外。skip 時は **secret を出力しない**
 * (payload / summary はログせず、zod issue の path / code のみ)。
 */
function validateRowForLiveness(r: EventRow, sessionId: string): NormalizedEvent | null {
  const isoTs = r.timestamp instanceof Date ? r.timestamp.toISOString() : String(r.timestamp);
  if (!Number.isFinite(Date.parse(isoTs))) {
    logSkippedRow(sessionId, r.event_type, "non-finite timestamp");
    return null;
  }

  const ev: Record<string, unknown> = {
    event_id: r.event_id,
    provider: r.provider,
    source: r.source,
    session_id: r.session_id,
    event_type: r.event_type,
    timestamp: isoTs,
    payload: r.payload ?? {},
    metrics: r.metrics ?? {},
  };
  if (r.thread_id != null) ev.thread_id = r.thread_id;
  if (r.turn_id != null) ev.turn_id = r.turn_id;
  if (r.agent_id != null) ev.agent_id = r.agent_id;
  if (r.state != null) ev.state = r.state;
  if (r.cwd != null) ev.cwd = r.cwd;
  if (r.summary != null) ev.summary = r.summary;

  const parsed = safeParseEvent(ev);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join(".") || "<root>"}:${i.code}`)
      .join(",");
    logSkippedRow(sessionId, r.event_type, `T1 validation failed (${issues})`);
    return null;
  }
  return parsed.data;
}

/** 契約違反行の skip を secret 非出力で記録する (event_type は enum なので秘匿性なし)。 */
function logSkippedRow(sessionId: string, eventType: string, reason: string): void {
  // session_id / event_type / reason のみ。payload・summary・credential は出力しない。
  console.warn(
    `[ingest-store] skipped contract-invalid event row for liveness synthesis: ` +
      `session_id=${sessionId} event_type=${eventType} reason=${reason}`,
  );
}

interface EventRow {
  event_id: string;
  provider: string;
  source: string;
  session_id: string;
  thread_id: string | null;
  turn_id: string | null;
  agent_id: string | null;
  event_type: string;
  state: string | null;
  timestamp: Date | string;
  cwd: string | null;
  summary: string | null;
  payload: Record<string, unknown> | null;
  metrics: Record<string, unknown> | null;
}

/** timestamptz (Date or ISO string) を epoch ms へ。非有限は undefined。 */
function extractMs(ts: Date | string): number | undefined {
  const ms = ts instanceof Date ? ts.getTime() : Date.parse(ts);
  return Number.isFinite(ms) ? ms : undefined;
}

/**
 * 強み(a)③: session_state.secret_redaction_count_by_kind (jsonb) を Record<string, number> へ
 * 復元する。NULL (旧行・未観測) / 非 object / 不正値は **{}** へ安全側に倒す (NULL≡未加算で fold
 * 恒等)。値は非負有限数のみ採用 (件数のみ・kind 名は文字列キーで原文非依存)。
 */
/**
 * 表示時ローカライズ (ADR 019eeac6): session_state.current_action_kind (text) を ActionKind へ復元する。
 * DB text + 読み出しゲート (redaction-kinds T1 昇格 019ec744 と同型): `isActionKind` を満たす値のみ
 * 採用し、NULL / 未知値 (forward-compat) は **undefined** へ安全側に倒す。再 redaction はしない。
 */
function toActionKind(raw: string | null): ActionKind | undefined {
  return typeof raw === "string" && isActionKind(raw) ? raw : undefined;
}

function parseRedactionCountByKind(raw: unknown): Record<string, number> {
  // SEC-1r/TDA-2: read 層も write/merge/audit と同一 helper で gate する (closed-enum key
  //   allowlist + 正整数値域)。restore-from-backup / ops backfill / gate デプロイ前の既存行 経由で
  //   phantom が jsonb に紛れても、fold の prev 入力や no-op 返却 projection から launder されない。
  return gateRedactionCountByKind(raw);
}

/** session_state.liveness jsonb の永続表現 (upsertProjection が書く形)。 */
interface PersistedLiveness {
  state?: string;
  reason?: string;
  stalled_suspected?: boolean;
  evaluated_at_ms?: number;
  evidence?: Record<string, unknown>;
  invalid_transition_count?: number;
}

/**
 * TDA-2: 永続済み liveness jsonb を LivenessResult へ復元する (冪等 no-op 用)。
 * no-op は新情報ゼロなので、保存済みの合成結果をそのまま返す (再合成しない)。
 * jsonb が欠損/破損していれば unknown へ安全側に倒す。
 */
function reconstructLiveness(p: PersistedLiveness | null): LivenessResult {
  const validStates = new Set(["live", "idle", "stalled", "unknown"]);
  const state =
    p && typeof p.state === "string" && validStates.has(p.state)
      ? (p.state as LivenessResult["state"])
      : "unknown";
  const evidence = (p?.evidence ?? {}) as LivenessResult["evidence"];
  const reason = p?.reason ?? "restored from persisted session_state (idempotent no-op)";
  const evaluatedAtMs = typeof p?.evaluated_at_ms === "number" ? p.evaluated_at_ms : 0;
  return {
    state,
    evidence,
    reason,
    evaluatedAtMs,
    stalledSuspected: p?.stalled_suspected ?? state === "stalled",
  };
}
