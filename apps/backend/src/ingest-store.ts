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
  BoundedLruMap,
  BoundedMonotonicTimestampChecker,
  FILE_EVENT_TYPES,
  isActionKind,
  LastTurnOutcome,
  MODEL_STREAM_EVENT_TYPES,
  type ActionKind,
  type NormalizedEvent,
  newEventId,
  gateRedactionCountByKind,
  PROCESS_ALIVE_PAYLOAD_KEY,
  safeParseEvent,
  STDOUT_EVENT_TYPES,
  terminalContinuation,
  terminalEvidenceFor,
  toEpochMs,
  type State,
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
import {
  applyWorkItemsEvent,
  reduceWorkItems,
  WORK_ITEM_REACTIVE_EVENT_TYPES,
  type WorkItem,
  type WorkItemsProjection,
} from "@actradeck/projection";
import { isTerminalStateValue, TERMINAL_STATES } from "@actradeck/event-model";

/**
 * TDA-2: liveness 集約クエリ用の event_type グルーピングは event-model の T1 正典
 * (liveness-signals.ts) を **唯一参照**する。observeFromEvents (TS) と aggregateObservation
 * (SQL) が同じ定数を使うことで分類のドリフトを防ぐ (SQL 側へ再定義しない)。
 */
const STDOUT_TYPES = STDOUT_EVENT_TYPES;
const FILE_TYPES = FILE_EVENT_TYPES;
const MODEL_STREAM_TYPES = MODEL_STREAM_EVENT_TYPES;

/**
 * ADR 0015 §D4: work-items fold を起動する event_type の allow-list。これ以外のイベントは
 * work_items 投影に一切触れず **zero-cost skip** する (fold の apply も同じ条件で no-op)。
 * terminal (session.ended / terminal state 保持イベント) も含めるのは、work item を持つ session を
 * **freeze** して post-terminal の work/diff/command イベントが frozen 行を mutate しないため (受入15)。
 */
// TDA-A2-7 (B1・単一出所化): projection の `WORK_ITEM_REACTIVE_EVENT_TYPES` を **import して共有**する
//   (手書き複製を廃止)。fold に反応 case を足しても projection 側の配列更新だけで backend gate が自動追随し、
//   silent under-count drift を構造的に排除する。projection 側は INV-WORKITEM-REACTIVE-SET-COMPLETE が
//   switch との乖離を回帰固定する。liveness 分類の「event-model T1 正典 import・SQL 側へ再定義しない」規律と同型。
const WORK_ITEM_FOLD_EVENT_TYPES: ReadonlySet<string> = new Set(WORK_ITEM_REACTIVE_EVENT_TYPES);

/** このイベントが work-items fold を起こしうるか (§D4 gate)。terminal state 保持イベントも含む。 */
function isWorkItemFoldEvent(ev: NormalizedEvent): boolean {
  return WORK_ITEM_FOLD_EVENT_TYPES.has(ev.event_type) || isTerminalStateValue(ev.state);
}

/**
 * TDA-2: rebuild SELECT の WHERE gate 用配列 (**単一出所**)。increment 側 `isWorkItemFoldEvent` と
 * **同一集合** を SQL 用に導出する (event_type membership ∪ terminal state 値・手書き二重化しない):
 * event_type は `WORK_ITEM_FOLD_EVENT_TYPES` から、terminal state は `isTerminalStateValue` が参照する
 * 正典 `TERMINAL_STATES` から導出する。`applyWorkItemsEvent` は非対象イベントで prev をそのまま返すため
 * `reduceWorkItems([gated]) == reduceWorkItems([all])` (証明可能に等価)。よって rebuild は gate 済み行
 * だけを読めば十分 (write-tx 内の per-session 全走査を避ける)。
 */
const WORK_ITEM_FOLD_EVENT_TYPES_SQL: readonly string[] = [...WORK_ITEM_FOLD_EVENT_TYPES];
const WORK_ITEM_FOLD_TERMINAL_STATES_SQL: readonly string[] = TERMINAL_STATES as readonly string[];

/**
 * work-items 投影キャッシュの上限 (LRU)。BoundedMonotonicTimestampChecker (順序チェッカ) と同様、
 * long-running プロセスで distinct session_id が無制限に増えても Map が肥大化しないよう bound する。
 * eviction されても correctness は不変 (次の work-relevant イベントで events から lazy 再 fold される・
 * 純コスト = 再読込のみ)。
 */
const DEFAULT_WORK_ITEMS_CACHE_MAX = 10_000;

/** work_items テーブルの全列 (upsert の列順の単一出所)。WorkItem のフィールドと 1:1。 */
const WORK_ITEM_COLUMNS = [
  "session_id",
  "work_item_id",
  "id_scheme",
  "subject",
  "status",
  "ordinal",
  "created_at",
  "created_event_id",
  "claimed_at",
  "claim_event_id",
  "claim_method",
  "claim_fidelity",
  "verification_state",
  "verified_at",
  "verification_event_id",
  "check_kind",
  "check_match",
  "check_exit_code",
  "verified_tree_fp",
  "run_dirty",
  "stale_at",
  "stale_event_id",
  "updated_at",
] as const;

/** WorkItem 1 行を SQL パラメータ配列へ (WORK_ITEM_COLUMNS と同順・timestamptz は ISO 文字列/NULL)。 */
function workItemParams(it: WorkItem): unknown[] {
  return [
    it.session_id,
    it.work_item_id,
    it.id_scheme,
    it.subject ?? null,
    it.status,
    it.ordinal ?? null,
    it.created_at ?? null,
    it.created_event_id ?? null,
    it.claimed_at ?? null,
    it.claim_event_id ?? null,
    it.claim_method ?? null,
    it.claim_fidelity ?? null,
    it.verification_state,
    it.verified_at ?? null,
    it.verification_event_id ?? null,
    it.check_kind ?? null,
    it.check_match ?? null,
    it.check_exit_code ?? null,
    it.verified_tree_fp ?? null,
    it.run_dirty,
    it.stale_at ?? null,
    it.stale_event_id ?? null,
    it.updated_at,
  ];
}

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
  /** ADR 0015 §D4: work-items 投影キャッシュの LRU 上限 (session 数)。既定 10_000。 */
  readonly workItemsCacheMax?: number;
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
  /**
   * ADR 0015 §D4: session_id → 直近の work-items fold 状態 (transient な tree_fp / pending_checks を
   * 含む) の LRU キャッシュ。work_items テーブルの列に存在しない transient を保持するため、
   * backend 再起動やキャッシュ eviction 後は events から lazy 再 fold で再構成する
   * (append-only ゆえ完全 rebuild 可能・migration 追加なし)。Map は挿入順を保つので LRU として使う。
   */
  private readonly workItemsCache: BoundedLruMap<string, WorkItemsProjection>;
  /** TDA-2 観測 (テスト/監視用): 直近 rebuild で読み込んだ gate 済みイベント数 (無 gate なら全件になる)。 */
  private _lastRebuiltEventCount = 0;

  constructor(opts: IngestStoreOptions) {
    this.pool = opts.pool;
    this.livenessOptions = opts.livenessOptions;
    this.workItemsCache = new BoundedLruMap(
      opts.workItemsCacheMax !== undefined && opts.workItemsCacheMax > 0
        ? opts.workItemsCacheMax
        : DEFAULT_WORK_ITEMS_CACHE_MAX,
    );
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
            event_type, state, timestamp, cwd, summary, payload, metrics, seq)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$15::jsonb,$16)
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
          // seq-drop 検知 (ADR 019f4cdb Phase2): client 申告 seq を永続。省略時 NULL (検知対象外)。
          // NormalizedEvent.seq は safe-integer 域の非負整数 (schema 検証済) で pg bigint 列へ載る。
          ev.seq ?? null,
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

      // ADR 0015 §D4: work-items 直交 fold を **同一 ingest tx 内**で増分適用し work_items へ upsert。
      //   対象 event_type のみ gate (他は zero-cost skip)。新規行 (inserted) のみ到達するため
      //   二重 fold しない (冪等・§INV-IDEMPOTENCY と同じ inserted ゲートに整合)。
      if (isWorkItemFoldEvent(ev)) {
        await this.applyWorkItemsIncremental(client, ev);
      }

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
    // ADR 0014 Phase 3a (run lineage・decision 019f8032): sessions へ 5 列を additive 投影する。
    //   空文字は null 化 (permissionMode の書式に倣う)。**projection key には使わない** (lineage/表示専用)。
    //   sticky 方針は sqL の COALESCE 向きで表現する (下記):
    //   - provider_session_id / start_kind / resumed_from_session_id = **first-wins**
    //     (COALESCE(sessions.x, EXCLUDED.x)・started_at と同型。run の起点情報は一度確定したら変えない)。
    //   - end_kind / recoverability = **last-non-null-wins**
    //     (COALESCE(EXCLUDED.x, sessions.x)・permission_mode と同型。終了時に確定/更新)。
    //   この段では sidecar が distinct に採番しない (3b) ため大半 NULL のまま入る (非破壊)。
    const nonEmpty = (v: string | undefined): string | null =>
      typeof v === "string" && v.length > 0 ? v : null;
    const providerSessionId = nonEmpty(ev.provider_session_id);
    const startKind = nonEmpty(ev.start_kind);
    const resumedFrom = nonEmpty(ev.resumed_from_session_id);
    const endKind = nonEmpty(ev.end_kind);
    const recoverability = nonEmpty(ev.recoverability);
    await client.query(
      `INSERT INTO sessions (session_id, provider, source, agent_id, repo, branch, cwd, started_at, capture_mode, permission_mode,
                             provider_session_id, start_kind, resumed_from_session_id, end_kind, recoverability)
       VALUES ($1,$2,$3,$4,$5,$6,$7, CASE WHEN $8 THEN $9::timestamptz ELSE NULL END, $10, $11, $12, $13, $14, $15, $16)
       ON CONFLICT (session_id) DO UPDATE SET
         agent_id = COALESCE(EXCLUDED.agent_id, sessions.agent_id),
         repo     = COALESCE(EXCLUDED.repo, sessions.repo),
         branch   = COALESCE(EXCLUDED.branch, sessions.branch),
         cwd      = COALESCE(EXCLUDED.cwd, sessions.cwd),
         started_at = COALESCE(sessions.started_at, EXCLUDED.started_at),
         capture_mode = COALESCE(EXCLUDED.capture_mode, sessions.capture_mode),
         permission_mode = COALESCE(EXCLUDED.permission_mode, sessions.permission_mode),
         -- run lineage 起点情報: first-wins (一度確定したら変えない)。
         provider_session_id     = COALESCE(sessions.provider_session_id, EXCLUDED.provider_session_id),
         start_kind              = COALESCE(sessions.start_kind, EXCLUDED.start_kind),
         resumed_from_session_id = COALESCE(sessions.resumed_from_session_id, EXCLUDED.resumed_from_session_id),
         -- run 終了情報: last-non-null-wins (終了時に確定/更新)。
         end_kind                = COALESCE(EXCLUDED.end_kind, sessions.end_kind),
         recoverability          = COALESCE(EXCLUDED.recoverability, sessions.recoverability),
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
        providerSessionId,
        startKind,
        resumedFrom,
        endKind,
        recoverability,
      ],
    );
  }

  /** 現在の projection を読む (なければ初期 projection)。 */
  private async readProjection(client: PoolClient, sessionId: string): Promise<SessionProjection> {
    const { rows } = await client.query(
      `SELECT session_id, state, current_action, current_action_kind, current_action_subject,
              last_event_id, last_event_at,
              needs_attention, liveness, pending_approvals,
              secret_detected, secret_redaction_count, secret_redaction_count_by_kind, last_turn_outcome
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
      last_turn_outcome: string | null;
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
      // ADR 0014 直交軸: continuation / terminal_evidence は永続 `state` の純関数ゆえ読込時に
      //   無コストで再導出する (専用列を足さない・drift 源を作らない)。次の applyEvent の finalize
      //   が resultState から同値を再計算するため、この read 値は transient (DTO へは Phase 5 で配線)。
      //   last_turn_outcome は state から導出不能な sticky 軸で、ADR 0014 Phase 3a で session_state
      //   列へ永続する。ここで DB 行を closed-enum gate (toLastTurnOutcome) して復元し、reducer の
      //   prev へ渡す → live 経路が persisted 値を読む → live/replay 非対称 (TDA-2) が解消する。
      continuation: terminalContinuation((r.state ?? undefined) as State | undefined),
      terminal_evidence: terminalEvidenceFor((r.state ?? undefined) as State | undefined),
      last_turn_outcome: toLastTurnOutcome(r.last_turn_outcome),
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
          secret_detected, secret_redaction_count, secret_redaction_count_by_kind, last_turn_outcome, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10::jsonb,$11,$12,$13::jsonb,$14, now())
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
         -- ADR 0014 Phase 3a: turn 結果を EXCLUDED で最新反映 (reducer が sticky 合成済ゆえ正しい)。
         last_turn_outcome              = EXCLUDED.last_turn_outcome,
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
        // ADR 0014 Phase 3a: reducer 合成済 last_turn_outcome を永続 (undefined→NULL)。
        proj.last_turn_outcome ?? null,
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
              secret_detected, secret_redaction_count, secret_redaction_count_by_kind, last_turn_outcome
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
      last_turn_outcome: string | null;
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
      // ADR 0014 直交軸 (readProjection と同一・上記コメント参照): state 純関数の 2 軸は再導出、
      //   last_turn_outcome は Phase 3a で session_state 列から closed-enum gate して復元する。
      continuation: terminalContinuation((r.state ?? undefined) as State | undefined),
      terminal_evidence: terminalEvidenceFor((r.state ?? undefined) as State | undefined),
      last_turn_outcome: toLastTurnOutcome(r.last_turn_outcome),
    };
    return { projection, liveness: reconstructLiveness(r.liveness) };
  }

  /** ADR 0015 §D4: work-items 投影キャッシュが現在保持する session 数 (テスト/監視用・常に <= 上限)。 */
  get workItemsTrackedSessions(): number {
    return this.workItemsCache.size;
  }

  /** TDA-2: 直近 rebuild で読んだ gate 済みイベント数 (gate falsifier 用・rebuild 未発生なら 0)。 */
  get lastRebuiltEventCount(): number {
    return this._lastRebuiltEventCount;
  }

  /**
   * ADR 0015 §D4: work-items 直交 fold を 1 イベント分だけ増分適用し、変化した行を work_items へ upsert。
   *
   * - **cache hit** (increment 経路): 直近の fold 状態 (transient な tree_fp / pending_checks を含む) を
   *   prev とし、prev → next の item を **参照比較 diff** で書く (fold は不変 item の参照を保つため・変化した
   *   item は必ず新オブジェクト → under-upsert しない・over-upsert は冪等)。
   * - **cache miss** (backend 再起動 / 初回 work イベント / LRU eviction): 当該 session の gate 済み全
   *   イベントを canonical 順で読み直し (current を除く) `reduceWorkItems` で prev を再構成する
   *   (lazy 再 fold・events は append-only ゆえ完全 rebuild 可能・migration 不要)。**QA-1**: rebuild 経路は
   *   参照 diff でなく **rebuilt+applied projection の全 item を無条件 upsert (full-reconcile)** する。
   *   これにより、過去に out-of-order 到達で DB 行が canonical と乖離していても (例 table=unverified vs
   *   canonical=passed、tree_fp 未復元)、rebuild を踏んだ時点で canonical へ**修復**される (rebuild は既に
   *   全読済ゆえ追加コストは ≤ MAX_WORK_ITEMS=200 行の upsert のみ・cache-hit 経路の参照 diff は不変)。
   *
   * next をキャッシュへ書き戻す。冪等: 本メソッドは ingest() の `inserted===true` 分岐からのみ呼ばれる
   * (重複 event_id は到達せず) ゆえ同一 event_id 再送で二重 fold しない (§INV-IDEMPOTENCY と同じ inserted ゲート)。
   *
   * 正直な限界 (session_state reducer と同性質): increment (cache-hit) は **到達順**で畳むため、稀な
   * out-of-order 再送では canonical と乖離しうる。乖離は次の rebuild (再起動 / eviction) の full-reconcile で
   * canonical へ修復される (自動修復は rebuild 時点のみ・**rebuild 間の乖離窓は残る**)。canonical 順で
   * ingest される通常経路 (sidecar tail / 受入テスト) では乖離自体が発生しない (table == reduceWorkItems・受入14)。
   */
  private async applyWorkItemsIncremental(client: PoolClient, ev: NormalizedEvent): Promise<void> {
    const sid = ev.session_id;
    const cached = this.workItemsCache.get(sid);
    const rebuilt = cached === undefined;
    const prev = rebuilt ? await this.rebuildWorkItems(client, sid, ev.event_id) : cached;
    const next = applyWorkItemsEvent(prev, ev);
    this.cacheWorkItems(sid, next);
    if (rebuilt) {
      // QA-1 full-reconcile: rebuild 経路は全 item を upsert し DB の乖離を修復する。
      await this.upsertItems(client, next.items);
    } else {
      // increment 経路: 参照 diff で変化行のみ書く。
      await this.upsertWorkItemRows(client, prev, next);
    }
  }

  /**
   * lazy 再 fold: 当該 session の **current を除く gate 済みイベント**を canonical 順で読み直し、
   * `reduceWorkItems` で fold 状態 (items + transient tree_fp / pending_checks + frozen) を再構成する。
   */
  private async rebuildWorkItems(
    client: PoolClient,
    sessionId: string,
    excludeEventId: string,
  ): Promise<WorkItemsProjection> {
    const events = await this.loadSessionEventsForFold(client, sessionId, excludeEventId);
    this._lastRebuiltEventCount = events.length;
    return reduceWorkItems(sessionId, events);
  }

  /**
   * fold 用に session の gate 済みイベント (current 除く) を canonical 順 (timestamp ASC, event_id ASC・
   * replay/webui client fold と同一) で読み、full payload 付き NormalizedEvent へ復元する。
   *
   * TDA-2: SELECT は increment 側と **同一 gate** (WORK_ITEM_FOLD_EVENT_TYPES membership ∪ terminal
   * state 値・単一出所の `*_SQL` 配列) を WHERE へ適用する。非対象イベントは `applyWorkItemsEvent` が
   * prev を返すため fold 結果は不変で、per-session 全走査 (write-tx 内・無界) を避けられる。
   * 契約違反行 (理論上 ingest の parseEvent 境界を通るため発生しないが、別経路書込/破損に備える) は
   * T1 検証で skip する (fold へ流入させない・NO secret 出力)。
   */
  private async loadSessionEventsForFold(
    client: PoolClient,
    sessionId: string,
    excludeEventId: string,
  ): Promise<NormalizedEvent[]> {
    const { rows } = await client.query(
      `SELECT event_id, provider, source, session_id, thread_id, turn_id, agent_id,
              event_type, state, timestamp, cwd, summary, payload, metrics
         FROM events
        WHERE session_id = $1 AND event_id <> $2
          AND (event_type = ANY($3::text[]) OR state = ANY($4::text[]))
        ORDER BY timestamp ASC, event_id ASC`,
      [
        sessionId,
        excludeEventId,
        WORK_ITEM_FOLD_EVENT_TYPES_SQL as string[],
        WORK_ITEM_FOLD_TERMINAL_STATES_SQL as string[],
      ],
    );
    const out: NormalizedEvent[] = [];
    for (const raw of rows as EventRow[]) {
      const ev = rowToFoldEvent(raw, sessionId);
      if (ev !== null) out.push(ev);
    }
    return out;
  }

  /** LRU set (末尾へ移動 + 上限超過 evict は event-model の共有 BoundedLruMap・A2 TDA-4)。 */
  private cacheWorkItems(sessionId: string, proj: WorkItemsProjection): void {
    this.workItemsCache.set(sessionId, proj);
  }

  /**
   * increment 経路 (cache-hit): prev → next で **参照が変わった item のみ**を upsert する (参照 diff)。fold は
   * 不変 item の参照を保つため、参照が変わった item = 値が変わった item (over-upsert しても冪等・
   * under-upsert はしない)。行は増える一方 (removed も status=removed で残る・MAX 200 で bound) ゆえ
   * DELETE は不要。
   */
  private async upsertWorkItemRows(
    client: PoolClient,
    prev: WorkItemsProjection,
    next: WorkItemsProjection,
  ): Promise<void> {
    const prevById = new Map(prev.items.map((it) => [it.work_item_id, it]));
    const changed = next.items.filter((it) => prevById.get(it.work_item_id) !== it);
    await this.upsertItems(client, changed);
  }

  /** work_items へ複数行を upsert する (列順は WORK_ITEM_COLUMNS 単一出所)。increment/rebuild 共有。 */
  private async upsertItems(client: PoolClient, items: readonly WorkItem[]): Promise<void> {
    if (items.length === 0) return;
    const setClause = WORK_ITEM_COLUMNS.map((c) => `${c} = EXCLUDED.${c}`).join(",\n         ");
    const placeholders = WORK_ITEM_COLUMNS.map((_, i) => `$${i + 1}`).join(",");
    for (const it of items) {
      await client.query(
        `INSERT INTO work_items (${WORK_ITEM_COLUMNS.join(",")})
         VALUES (${placeholders})
         ON CONFLICT (session_id, work_item_id) DO UPDATE SET
           ${setClause}`,
        workItemParams(it),
      );
    }
  }
}

/**
 * QA-4 (A2 sweep): DB 行 → NormalizedEvent 復元の**共有実装** (単一出所)。
 * rowToFoldEvent (work-items fold) と validateRowForLiveness (liveness M4) がほぼ逐語コピー
 * だったため集約した (silent drift 防止・consolidation-invariant-sweep)。full payload を保持し
 * T1 (safeParseEvent) を通す。契約違反行は null (secret 非出力で理由のみ記録)。
 * `context` は skip ログの経路識別のみに使う (undefined = liveness 経路の従来文言)。
 */
function restoreRowAsEvent(
  r: EventRow,
  sessionId: string,
  context?: string,
): NormalizedEvent | null {
  const isoTs = r.timestamp instanceof Date ? r.timestamp.toISOString() : String(r.timestamp);
  if (!Number.isFinite(Date.parse(isoTs))) {
    const reason =
      context === undefined ? "non-finite timestamp" : `non-finite timestamp (${context})`;
    logSkippedRow(sessionId, r.event_type, reason);
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
    const reason =
      context === undefined
        ? `T1 validation failed (${issues})`
        : `T1 validation failed (${context}: ${issues})`;
    logSkippedRow(sessionId, r.event_type, reason);
    return null;
  }
  return parsed.data;
}

/**
 * ADR 0015 §D4: DB 行を fold 用 NormalizedEvent へ復元する。full payload を保持 (fold は
 * items / check_kind / diff_hash / head_sha / exit_code / request_id を payload から読む)。
 * 実装は restoreRowAsEvent (QA-4 共有)。
 */
function rowToFoldEvent(r: EventRow, sessionId: string): NormalizedEvent | null {
  return restoreRowAsEvent(r, sessionId, "work-items fold");
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
 * (payload / summary はログせず、zod issue の path / code のみ)。実装は restoreRowAsEvent (QA-4 共有)。
 */
function validateRowForLiveness(r: EventRow, sessionId: string): NormalizedEvent | null {
  return restoreRowAsEvent(r, sessionId);
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

/**
 * ADR 0014 Phase 3a: session_state.last_turn_outcome (text) を LastTurnOutcome へ復元する。
 * `toActionKind`→`isActionKind` と同型の closed-enum 読み出しゲート: 正典値
 * (completed/failed/interrupted) のみ採用し、NULL / 未知値 (forward-compat・旧行) は **undefined**
 * へ安全側に倒す (再導出しない・原文非依存)。
 *
 * TDA-1 解消: 許容値集合をローカル Set で手写しせず、event-model の runtime `LastTurnOutcome`
 *   (zod enum・単一出所) の `.safeParse` を再利用する (drift 不可・
 *   security-gate-reuse-canonical-parser / consolidation-invariant-sweep-all-copies)。挙動不変。
 */
function toLastTurnOutcome(raw: string | null): LastTurnOutcome | undefined {
  if (typeof raw !== "string") return undefined;
  const parsed = LastTurnOutcome.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
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

/** stale デモ projection 行の既定 TTL (24h)。 */
export const DEFAULT_DEMO_STATE_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * SEC-2 sweep (docker-safety-demo R1・task 019f38b9): 使い捨てデモ session
 * (`demo-safety-*`) の **stale な session_state projection 行**を boot 時に reap する。
 *
 * 背景: 中途で死んだデモ run の projection 行が at-rest に残留する (表示層は
 * approvalsSnapshot の isLive gate で self-heal 済みだが、行そのものは無期限に残る)。
 * デモ session は使い捨てゆえ、TTL (既定 24h) を過ぎた projection 行のみ削除する。
 *
 * 削除は **session_state (projection・再導出可能) のみ**。events / sessions は append-only の
 * 監査証跡としてそのまま残す (INV-REDACTION / audit 履歴を壊さない)。
 * prefix は LIKE メタ文字を escape して先頭一致させる (定数前提だが防御的に)。
 * 戻り値は削除行数 (非負整数・原文非依存)。
 */
export async function reapStaleDemoSessionState(
  pool: Pool,
  opts: { readonly prefix: string; readonly olderThanMs?: number },
): Promise<number> {
  const olderThanMs = opts.olderThanMs ?? DEFAULT_DEMO_STATE_TTL_MS;
  const cutoffIso = new Date(Date.now() - olderThanMs).toISOString();
  const likePattern = `${opts.prefix.replace(/([\\%_])/g, "\\$1")}%`;
  const res = await pool.query(
    `DELETE FROM session_state
      WHERE session_id LIKE $1
        AND COALESCE(last_event_at, updated_at) < $2::timestamptz`,
    [likePattern, cutoffIso],
  );
  return res.rowCount ?? 0;
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
