/**
 * Audit view read layer (強み(a) ガバナンス監査ビュー).
 *
 * replay-store と同方針: append-only な sessions / session_state / events を **allow-list 投影**で
 * 集約し、backend は再 redaction しない (sidecar choke が唯一の権威)。本層は生 payload / command 本文 /
 * path 本文を一切 SELECT せず、監査に必要な集計値 (redaction kind 別件数 / 承認 decision 別件数 /
 * 高リスク件数 / メタ) と per-session 詳細の承認エントリ allow-list のみを返す (INV-AUDIT-EXPORT-NO-RAW)。
 *
 * redaction kind 別件数は read 層でも **closed-enum gate** を再適用する (event-model REDACTION_KINDS。
 * SEC-1r の write-gate 単一依存を audit 経路では二重防御化し、万一 dirty な jsonb 行があっても
 * 既知 kind 以外を集計・export に載せない)。
 */
import {
  gateRedactionCountByKind,
  REDACTION_KINDS,
  REDACTION_MARKER_PATTERN,
  REDACTION_MARKER_PREFIX,
  REDACTION_MARKER_SUFFIX,
  redactionMarker,
} from "@actradeck/event-model";

import {
  emptyDecisionTally,
  AUDIT_DECISIONS,
  type AuditApprovalEntry,
  type AuditDecision,
  type AuditDecisionTally,
  type AuditRangeReport,
  type AuditRangeTotals,
  type AuditSessionSummary,
  type RedactionOccurrence,
  type RedactionOccurrences,
  DEFAULT_AUDIT_LIMIT,
  DEFAULT_REDACTION_OCCURRENCE_LIMIT,
  MAX_AUDIT_LIMIT,
  MAX_REDACTION_OCCURRENCE_LIMIT,
} from "./audit-contract.js";
import type { RedactionKind } from "@actradeck/event-model";
import { cwdScopeClause, parseProjectScope } from "./project-scope.js";

import type { Pool } from "pg";

const APPROVAL_EVENT_TYPES = ["tool.permission.requested", "tool.permission.resolved"] as const;
const HIGH_RISK_LEVELS = new Set(["high", "critical"]);

/**
 * 単一 literal マーカーの出現数を数える SQL 式 (drill-down と backfill 再導出が**共有する唯一の計数式**)。
 * `(len(blob) - len(replace(blob, marker, ''))) / len(marker)` = blob 中の marker 出現数 (整数除算・
 * 分子は marker 長の倍数)。`blobExpr` は計数対象テキスト列/式、`markerExpr` は marker 文字列を産む
 * SQL (bind param `$2` でも `'[REDACTED:' || k.kind || ']'` でも可)。閉じ `]` 込みで別 kind の prefix
 * 衝突を排除する (drill-down で実 PG 検証済: to_jsonb-text の literal 計数 == canonical
 * countRedactionMarkersByKindDeep の deep 走査計数・160==160)。両経路がこの 1 式に帰着するため
 * headline (backfill) と drill-down の数値はコード構造上一致する。
 */
const markerCountExpr = (blobExpr: string, markerExpr: string): string =>
  `(length(${blobExpr}) - length(replace(${blobExpr}, ${markerExpr}, ''))) / length(${markerExpr})`;

// TDA-5: marker のラベル接頭/接尾 (`[REDACTED:`/`]`) を event-model 単一 source から SQL 文字列リテラルへ。
// kindSqlExpr (例 `k.kind`) を接頭/接尾で挟む SQL 式を産む。接頭/接尾はコンパイル時定数だが ' を二重化して
// SQL-safe に (防御的)。生成結果は従来の `('[REDACTED:' || k.kind || ']')` と byte 一致。
const sqlStringLit = (s: string): string => `'${s.replace(/'/g, "''")}'`;
const sqlMarkerExpr = (kindSqlExpr: string): string =>
  `(${sqlStringLit(REDACTION_MARKER_PREFIX)} || ${kindSqlExpr} || ${sqlStringLit(REDACTION_MARKER_SUFFIX)})`;

/**
 * 全マーカー (任意 known/unknown kind) を数える正規表現 source。**event-model の正典 source
 * `REDACTION_MARKER_PATTERN` を共有**する (TDA-2: 文字クラス `[a-z0-9-]+` を各層で再ハードコード
 * せず単一化。sidecar の `REDACTION_MARKER_RE` も同じ source から派生し SQL↔TS のドリフトを構造閉塞)。
 * scalar 再導出 (countRedactionMarkersDeep 相当) に Postgres `regexp_count` の pattern として渡す
 * (bind param・literal 化しない)。`[REDACT-TRUNCATED:N]` は `[REDACTED:` を含まず非マッチ。
 */
const ALL_MARKERS_REGEX = REDACTION_MARKER_PATTERN;

interface SessionMetaRow {
  session_id: string;
  provider: string;
  source: string;
  agent_id: string | null;
  repo: string | null;
  branch: string | null;
  cwd: string | null;
  capture_mode: string | null;
  permission_mode: string | null;
  state: string | null;
  started_at: Date | null;
  ended_at: Date | null;
  last_event_at: Date | null;
  secret_detected: boolean | null;
  secret_redaction_count: number | null;
  secret_redaction_count_by_kind: unknown;
}

interface ApprovalGroupRow {
  session_id: string;
  event_type: string;
  decision: string | null;
  risk_level: string | null;
  n: number;
}

const SESSION_META_COLUMNS = `s.session_id, s.provider, s.source, s.agent_id, s.repo, s.branch, s.cwd,
        s.capture_mode, s.permission_mode, s.started_at, s.ended_at,
        ss.state, ss.last_event_at, ss.secret_detected, ss.secret_redaction_count,
        ss.secret_redaction_count_by_kind`;

/** jsonb の kind 別件数を closed-enum + 正整数で gate する (null-proto・既知 kind のみ)。
 *  SEC-1r/TDA-2: read/carry/merge 全面と同一 helper を共有 (値述語・key allowlist の単一出所)。 */
function gateKindCounts(raw: unknown): Record<string, number> {
  return gateRedactionCountByKind(raw, true);
}

function asDecision(raw: string | null): AuditDecision | undefined {
  return raw !== null && (AUDIT_DECISIONS as readonly string[]).includes(raw)
    ? (raw as AuditDecision)
    : undefined;
}

/** approval グループ行 (1 session 分) を summary へ畳む。 */
function foldApprovals(rows: readonly ApprovalGroupRow[]): {
  total: number;
  byDecision: AuditDecisionTally;
  highRisk: number;
} {
  const byDecision = emptyDecisionTally();
  let total = 0;
  let highRisk = 0;
  for (const r of rows) {
    if (r.event_type === "tool.permission.requested") {
      total += r.n;
      if (r.risk_level !== null && HIGH_RISK_LEVELS.has(r.risk_level)) highRisk += r.n;
    } else if (r.event_type === "tool.permission.resolved") {
      const d = asDecision(r.decision);
      if (d !== undefined) byDecision[d] += r.n;
    }
  }
  return { total, byDecision, highRisk };
}

function metaToSummary(
  r: SessionMetaRow,
  approvals: { total: number; byDecision: AuditDecisionTally; highRisk: number },
  entries?: readonly AuditApprovalEntry[],
): AuditSessionSummary {
  const decidedTotal = AUDIT_DECISIONS.reduce((acc, d) => acc + approvals.byDecision[d], 0);
  return {
    session_id: r.session_id,
    provider: r.provider,
    source: r.source,
    agent_id: r.agent_id ?? undefined,
    repo: r.repo ?? undefined,
    branch: r.branch ?? undefined,
    cwd: r.cwd ?? undefined,
    capture_mode: r.capture_mode ?? undefined,
    permission_mode: r.permission_mode ?? undefined,
    state: r.state ?? undefined,
    started_at: r.started_at?.toISOString(),
    ended_at: r.ended_at?.toISOString(),
    last_event_at: r.last_event_at?.toISOString(),
    secret_detected: r.secret_detected ?? false,
    secret_redaction_count: r.secret_redaction_count ?? 0,
    secret_redaction_count_by_kind: gateKindCounts(r.secret_redaction_count_by_kind),
    approvals: {
      total: approvals.total,
      by_decision: approvals.byDecision,
      pending: Math.max(0, approvals.total - decidedTotal),
    },
    high_risk_op_count: approvals.highRisk,
    ...(entries !== undefined ? { entries } : {}),
  };
}

/**
 * backfill 用の at-rest 再導出結果 (1 session 分)。**原文非保持** (件数のみ・kind は closed-enum)。
 * scalar = 全マーカー数 (canonical countRedactionMarkersDeep 相当・known∪unknown)。byKind = known
 * kind 別件数 (closed-enum・正整数のみ・0 は除外)。`sum(byKind) <= scalar` が構造的に成立 (known⊆all)。
 */
export interface RederivedRedactionCounts {
  readonly session_id: string;
  readonly scalar: number;
  readonly byKind: Record<string, number>;
}

export class AuditStore {
  /**
   * @param projectScope cwd 前方一致 allowlist (省略時は env ACTRADECK_PROJECT_SCOPE)。空=全件 (既定)。
   *   rangeReport (監査ビュー一覧) を一致セッションのみへ絞る (narrows only)。
   *   **display hygiene であって authz 境界ではない** (SEC-1 / ADR 019e92ae): per-session 詳細
   *   (sessionSummary) は scope を適用しない — token 保持者が任意 session_id を渡せば scope 外も引ける。
   *   単一信頼オペレータ前提では leak ではないが、非信頼閲覧者へ共有するなら by-id にも gate 要 (詳細は
   *   project-scope.ts の「境界」)。
   */
  constructor(
    private readonly pool: Pool,
    private readonly projectScope: readonly string[] = parseProjectScope(
      process.env.ACTRADECK_PROJECT_SCOPE,
    ),
  ) {}

  /** 1 セッションの監査要約。detail=true で承認エントリ列 (allow-list) を付ける。 */
  async sessionSummary(
    sessionId: string,
    opts?: { readonly detail?: boolean },
  ): Promise<AuditSessionSummary | undefined> {
    const { rows: metaRows } = await this.pool.query<SessionMetaRow>(
      `SELECT ${SESSION_META_COLUMNS}
         FROM sessions s
         LEFT JOIN session_state ss ON ss.session_id = s.session_id
        WHERE s.session_id = $1`,
      [sessionId],
    );
    const meta = metaRows[0];
    if (!meta) return undefined;

    const { rows: groupRows } = await this.pool.query<ApprovalGroupRow>(
      `SELECT session_id,
              event_type,
              payload->>'decision' AS decision,
              payload->>'risk_level' AS risk_level,
              count(*)::int AS n
         FROM events
        WHERE session_id = $1 AND event_type = ANY($2::text[])
        GROUP BY session_id, event_type, decision, risk_level`,
      [sessionId, APPROVAL_EVENT_TYPES],
    );
    const approvals = foldApprovals(groupRows);

    let entries: AuditApprovalEntry[] | undefined;
    if (opts?.detail) entries = await this.approvalEntries(sessionId);

    return metaToSummary(meta, approvals, entries);
  }

  /**
   * per-session 承認エントリ (allow-list)。1 エントリ = 1 承認要求 (operation)、decision は
   * request_id 突合で resolved から補完。command/path 本文・生 payload は載せない。
   */
  async approvalEntries(sessionId: string): Promise<AuditApprovalEntry[]> {
    const { rows: reqRows } = await this.pool.query<{
      event_id: string;
      timestamp: Date;
      request_id: string | null;
      tool_name: string | null;
      risk_level: string | null;
      command: string | null;
      path: string | null;
      auto_allowed: boolean | null;
    }>(
      // command/path は **sidecar redaction 済み at-rest** な payload の allow-list 投影
      // (replay-store の display 用フィールドと同一の redacted 列・backend は再 redaction しない)。
      // 「何を承認したか」を per-session 詳細でのみ示す (range/CSV には entries 自体を載せない)。
      `SELECT event_id,
              timestamp,
              payload->>'request_id' AS request_id,
              payload->>'tool_name' AS tool_name,
              payload->>'risk_level' AS risk_level,
              payload->>'command' AS command,
              COALESCE(payload->>'path', payload->>'file_path') AS path,
              CASE
                WHEN jsonb_typeof(payload->'auto_allowed') = 'boolean'
                THEN (payload->>'auto_allowed')::boolean
                ELSE NULL
              END AS auto_allowed
         FROM events
        WHERE session_id = $1 AND event_type = 'tool.permission.requested'
        ORDER BY timestamp ASC, event_id ASC
        LIMIT $2`,
      [sessionId, MAX_AUDIT_LIMIT],
    );
    const { rows: resRows } = await this.pool.query<{
      request_id: string | null;
      decision: string | null;
    }>(
      `SELECT payload->>'request_id' AS request_id, payload->>'decision' AS decision
         FROM events
        WHERE session_id = $1 AND event_type = 'tool.permission.resolved'
        ORDER BY timestamp ASC, event_id ASC`,
      [sessionId],
    );
    const decisionByRequest = new Map<string, AuditDecision>();
    for (const r of resRows) {
      const d = asDecision(r.decision);
      if (r.request_id !== null && d !== undefined) decisionByRequest.set(r.request_id, d);
    }
    return reqRows.map((r) => ({
      event_id: r.event_id,
      timestamp: r.timestamp.toISOString(),
      tool_name: r.tool_name ?? undefined,
      risk_level: r.risk_level ?? undefined,
      command: r.command ?? undefined,
      path: r.path ?? undefined,
      decision: r.request_id !== null ? decisionByRequest.get(r.request_id) : undefined,
      auto_allowed: r.auto_allowed ?? undefined,
    }));
  }

  /**
   * 強み(a) ガバナンス証跡 drill-down: 指定 kind の redaction が起きた個別イベントを返す。
   *
   * 監査詳細の kind 別件数 (例 `high-entropy-secret ×2672`) から「どのイベントで・いつ」を辿る。
   * **per-event redaction 件数は events テーブルにカラムとして残っていない** (ingest 時に top-level
   * redaction_count(_by_kind) を破棄し session_state へ fold するのみ・ingest-store.ts)。本層は
   * **at-rest redacted データから再導出**する: events.payload(jsonb)/summary/cwd/metrics に永続された
   * 安定マーカー `[REDACTED:<kind>]` を SQL 部分一致で計数する。
   *
   * 整合性 (INV-REDACTION-OCCURRENCE-FOLD): sink は **redacted event 候補オブジェクト全体**を走査して
   * per-event count を算出し、**その redacted event をそのまま永続**してから session_state へ fold する。
   * 本層は走査ドメインを sink へ寄せるため、列を手で列挙せず **`to_jsonb(events.*)::text` = events 行
   * 全体の JSON テキスト**上でマーカーを計数する (payload/summary/cwd だけでなく thread_id/turn_id/
   * agent_id 等の自由文字列列も自動網羅し、将来の列追加にも頑健・SEC-1/QA-1)。
   *
   * 本層は **ground truth** (実 PG 検証・REAL DATA): drill-down は保存済 redacted イベントの at-rest
   * マーカーを直接計数するため、その値は「ストアに現在存在する当該 kind マーカーの実数」そのもの。
   * 計数ロジックは sidecar の canonical scanner `countRedactionMarkersByKindDeep` と一致することを実 PG で
   * 実証済 (同一 redacted 行に対し to_jsonb-text の literal 計数 == deep 走査計数)。マーカーは ASCII
   * (`[`/`]`/`:`/`[a-z0-9-]`) で JSON 直列化に逐語出現し、閉じ `]` 込み検索ゆえ別 kind との prefix 衝突は
   * ない。`[REDACT-TRUNCATED:N]` は `[REDACTED:` を含まず誤マッチしない。
   *
   * headline (session_state.secret_redaction_count_by_kind) との関係 — **`Σ(occurrence.count) >=
   * fold[kind]` (drill-down が権威)**: headline は ingest 時の宣言値 (`NormalizedEvent.redaction_count_
   * by_kind`) を projection が積算した **running aggregate** で、feature ロールアウトの過渡 (sidecar が
   * by_kind を出す前 / backend が by_kind projection を持つ前に取り込んだイベント) で**歴史的に過少計上
   * しうる**。実データでこの差は観測されている (例: ある session で headline=136 に対し再導出=160)。
   * drill-down は at-rest 実体からの再導出ゆえ headline より正確で、両者が一致するのは projection が
   * 過少計上していない (= 現行スタックで取り込んだ) イベントのみのとき。**headline を ground truth へ
   * 揃えるには session_state の backfill が必要** (別タスク・本層は read 専用で headline を書き換えない)。
   * 実 PG テスト (inv-redaction-occurrences) は「宣言==マーカーな統制 fixture で Σ==fold」を pin し、
   * 再導出の**計数正当性**を保証する (real-data の過少計上は projection 側の別問題)。
   *
   * **INV-AUDIT-EXPORT-NO-RAW**: 原文秘匿は返さない。kind は呼び出し側で closed-enum 検証済み
   * (normalizeRedactionKind)。count は非負整数。command/path は replay/承認エントリと同一の at-rest
   * redacted allow-list 投影 (backend 再 redaction なし)。生 payload・非 allow-list キーは投影しない。
   *
   * @param kind closed-enum 検証済み redaction kind (route が normalizeRedactionKind で保証)。
   */
  async redactionOccurrences(opts: {
    readonly sessionId: string;
    readonly kind: RedactionKind;
    readonly limit?: number;
  }): Promise<RedactionOccurrences> {
    const limit = Math.min(
      opts.limit ?? DEFAULT_REDACTION_OCCURRENCE_LIMIT,
      MAX_REDACTION_OCCURRENCE_LIMIT,
    );
    const fetchLimit = limit + 1;
    // 検索マーカー (literal)。kind は呼び出し側で REDACTION_KINDS 検証済みゆえ `[a-z0-9-]` のみ。
    // bind param で渡す (文字列補間しない)。閉じ `]` 込みで別 kind の prefix 衝突を排除。
    const marker = redactionMarker(opts.kind); // TDA-5: ラベル書式は event-model 単一 source 由来。
    const { rows } = await this.pool.query<{
      event_id: string;
      event_type: string;
      timestamp: Date;
      command: string | null;
      path: string | null;
      cnt: number;
    }>(
      // blob = to_jsonb(e.*)::text (events 行全体・全永続列を網羅) 上で literal marker を計数する。
      // CTE で blob を materialize し、WHERE strpos(blob,$2)>0 で候補へ pre-filter (= cnt>=1 と等価)。
      // cnt = (len(blob) - len(replace(blob,marker,''))) / len(marker) は整数除算 (分子は marker 長の
      // 倍数)。timestamp ASC で limit+1 取得し has_more 判定。command/path は redacted allow-list 投影。
      // TDA-3: command/path は CTE 内で投影し、payload(jsonb 全体)を carry しない
      // (外側は redacted command/path 文字列と blob のみ参照。blob=to_jsonb で payload は既に内包)。
      `WITH ev AS (
         SELECT event_id,
                event_type,
                timestamp,
                payload->>'command' AS command,
                COALESCE(payload->>'path', payload->>'file_path') AS path,
                to_jsonb(e.*)::text AS blob
           FROM events e
          WHERE session_id = $1
       )
       SELECT event_id,
              event_type,
              timestamp,
              command,
              path,
              ${markerCountExpr("blob", "$2")} AS cnt
         FROM ev
        WHERE strpos(blob, $2) > 0
        ORDER BY timestamp ASC, event_id ASC
        LIMIT $3`,
      [opts.sessionId, marker, fetchLimit],
    );
    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;
    const occurrences: RedactionOccurrence[] = pageRows.map((r) => ({
      event_id: r.event_id,
      timestamp: r.timestamp.toISOString(),
      event_type: r.event_type,
      count: r.cnt,
      command: r.command ?? undefined,
      path: r.path ?? undefined,
    }));
    const total = occurrences.reduce((acc, o) => acc + o.count, 0);
    return {
      session_id: opts.sessionId,
      kind: opts.kind,
      total,
      occurrences,
      limit,
      has_more: hasMore,
    };
  }

  /**
   * **headline backfill 用の at-rest 再導出** (read-only)。session_state の running fold は feature
   * ロールアウト過渡 (sidecar が by_kind を出す前 / backend が by_kind projection を持つ前に取り込んだ
   * イベント) で**歴史的に過少計上**しうる (実データで fold scalar 10757 / by_kind 8964 に対し再導出
   * 16654 / 16598)。本メソッドは drill-down (redactionOccurrences) と**同一の走査ドメイン・同一の計数式**
   * (`to_jsonb(events.*)::text` 行全体 + `markerCountExpr`) で全マーカーを at-rest から数え直し、headline を
   * ground truth へ揃える backfill の入力を返す。本層は read 専用 (書込はしない・backfill スクリプトが
   * 行う)。
   *
   * - **scalar** = 全 `[REDACTED:<kind>]` マーカー数 (`ALL_MARKERS_REGEX` = canonical
   *   `REDACTION_MARKER_RE` と同一文字クラス・known∪unknown)。
   * - **byKind[k]** = known kind k (event-model `REDACTION_KINDS` を unnest・closed enum) の literal
   *   `[REDACTED:k]` 件数。0 は除外。`gateRedactionCountByKind` で値域 (正整数) と closed-enum を再ゲート。
   * - **不変条件**: known⊆all ゆえ `sum(byKind) <= scalar` が構造的に成立。`secret_detected` は scalar>0。
   *
   * **INV-AUDIT-EXPORT-NO-RAW**: 原文は返さない (件数 + closed-enum kind のみ)。
   *
   * @param opts.sessionId 指定時はその 1 session のみ再導出 (テスト/部分 backfill 用)。省略時は events を
   *   持つ全 session。
   */
  async rederiveRedactionCounts(opts?: {
    readonly sessionId?: string;
  }): Promise<RederivedRedactionCounts[]> {
    const sessionId = opts?.sessionId;
    // scalar (全マーカー): events 行全体 (to_jsonb) を session ごとに走査。$1=正規表現 / $2=session フィルタ。
    const { rows: scalarRows } = await this.pool.query<{ session_id: string; scalar: number }>(
      `WITH ev AS (
         SELECT session_id, to_jsonb(e.*)::text AS blob
           FROM events e
          WHERE ($2::text IS NULL OR session_id = $2)
       )
       SELECT session_id, COALESCE(SUM(regexp_count(blob, $1)), 0)::int AS scalar
         FROM ev
        GROUP BY session_id`,
      [ALL_MARKERS_REGEX, sessionId ?? null],
    );
    // by_kind (known kind 別): events 行全体を closed-enum kind と CROSS JOIN し literal 計数。
    // $1=known kinds 配列 / $2=session フィルタ。HAVING >0 で 0 件 kind を落とす。
    const { rows: kindRows } = await this.pool.query<{
      session_id: string;
      kind: string;
      cnt: number;
    }>(
      `WITH ev AS (
         SELECT session_id, to_jsonb(e.*)::text AS blob
           FROM events e
          WHERE ($2::text IS NULL OR session_id = $2)
       )
       SELECT ev.session_id,
              k.kind,
              SUM(${markerCountExpr("ev.blob", sqlMarkerExpr("k.kind"))})::int AS cnt
         FROM ev CROSS JOIN unnest($1::text[]) AS k(kind)
        GROUP BY ev.session_id, k.kind
       HAVING SUM(${markerCountExpr("ev.blob", sqlMarkerExpr("k.kind"))}) > 0`,
      [REDACTION_KINDS as readonly string[], sessionId ?? null],
    );
    const byKindBySession = new Map<string, Record<string, number>>();
    for (const r of kindRows) {
      let bag = byKindBySession.get(r.session_id);
      if (bag === undefined) {
        bag = {};
        byKindBySession.set(r.session_id, bag);
      }
      bag[r.kind] = r.cnt;
    }
    return scalarRows.map((r) => ({
      session_id: r.session_id,
      scalar: r.scalar,
      // 値域 (正整数) + closed-enum を read 側でも再ゲート (write gate 単一依存を二重防御化・SEC-1r)。
      // 集計面 gate は gateKindCounts 1 経由へ統一 (nullProto=true・projection merge と同一規律。
      // backfill-TDA-5: 同 class 内 helper を介し「集計 gate は helper 1 本」を完全一本化)。
      byKind: gateKindCounts(byKindBySession.get(r.session_id) ?? {}),
    }));
  }

  /**
   * 期間 [from, to] の複数セッション集計レポート。activity instant
   * (COALESCE(last_event_at, started_at, created_at)) で絞り、降順に limit+1 取得して has_more 判定。
   * 承認集計は対象 session 群の grouped query 1 往復で per-session + totals へ畳む (N+1 回避)。
   */
  async rangeReport(opts: {
    readonly from?: string;
    readonly to?: string;
    readonly limit?: number;
    /** レポート生成時刻 (ISO8601)。route は new Date()、テストは固定値を渡す。 */
    readonly now: string;
  }): Promise<AuditRangeReport> {
    const limit = Math.min(opts.limit ?? DEFAULT_AUDIT_LIMIT, MAX_AUDIT_LIMIT);
    const fetchLimit = limit + 1;
    // $1=from / $2=to / $3=limit。scope は $4/$5 (cwd allowlist; 空なら no-op で AND を付けない)。
    const scope = cwdScopeClause(this.projectScope, "s.cwd", 4);
    const scopeAnd = scope.clause.length > 0 ? `AND ${scope.clause}` : "";
    const { rows: metaRows } = await this.pool.query<SessionMetaRow>(
      `SELECT ${SESSION_META_COLUMNS},
              COALESCE(ss.last_event_at, s.started_at, s.created_at) AS activity_at
         FROM sessions s
         LEFT JOIN session_state ss ON ss.session_id = s.session_id
        WHERE ($1::timestamptz IS NULL
               OR COALESCE(ss.last_event_at, s.started_at, s.created_at) >= $1::timestamptz)
          AND ($2::timestamptz IS NULL
               OR COALESCE(ss.last_event_at, s.started_at, s.created_at) <= $2::timestamptz)
          ${scopeAnd}
        ORDER BY COALESCE(ss.last_event_at, s.started_at, s.created_at) DESC, s.session_id DESC
        LIMIT $3`,
      [opts.from ?? null, opts.to ?? null, fetchLimit, ...scope.params],
    );
    const hasMore = metaRows.length > limit;
    const pageRows = hasMore ? metaRows.slice(0, limit) : metaRows;
    const sessionIds = pageRows.map((r) => r.session_id);

    // 対象 session 群の承認集計を 1 往復で。
    const groupBySession = new Map<string, ApprovalGroupRow[]>();
    if (sessionIds.length > 0) {
      const { rows: groupRows } = await this.pool.query<ApprovalGroupRow>(
        `SELECT session_id,
                event_type,
                payload->>'decision' AS decision,
                payload->>'risk_level' AS risk_level,
                count(*)::int AS n
           FROM events
          WHERE session_id = ANY($1::text[]) AND event_type = ANY($2::text[])
          GROUP BY session_id, event_type, decision, risk_level`,
        [sessionIds, APPROVAL_EVENT_TYPES],
      );
      for (const r of groupRows) {
        const lane = groupBySession.get(r.session_id);
        if (lane) lane.push(r);
        else groupBySession.set(r.session_id, [r]);
      }
    }

    const sessions: AuditSessionSummary[] = [];
    // 集計は可変ローカルへ畳んで最後に readonly totals を構築する。
    let secretRedactionCount = 0;
    const byKind: Record<string, number> = Object.create(null) as Record<string, number>;
    const byDecision = emptyDecisionTally();
    let approvalTotal = 0;
    let highRiskOpCount = 0;
    let sessionsWithSecret = 0;
    for (const meta of pageRows) {
      const approvals = foldApprovals(groupBySession.get(meta.session_id) ?? []);
      const summary = metaToSummary(meta, approvals);
      sessions.push(summary);
      secretRedactionCount += summary.secret_redaction_count;
      for (const [k, v] of Object.entries(summary.secret_redaction_count_by_kind)) {
        byKind[k] = (byKind[k] ?? 0) + v;
      }
      for (const d of AUDIT_DECISIONS) {
        byDecision[d] += summary.approvals.by_decision[d];
      }
      approvalTotal += summary.approvals.total;
      highRiskOpCount += summary.high_risk_op_count;
      if (summary.secret_detected) sessionsWithSecret += 1;
    }
    const totals: AuditRangeTotals = {
      secret_redaction_count: secretRedactionCount,
      secret_redaction_count_by_kind: byKind,
      approvals_by_decision: byDecision,
      approval_total: approvalTotal,
      high_risk_op_count: highRiskOpCount,
      sessions_with_secret: sessionsWithSecret,
    };

    return {
      from: opts.from,
      to: opts.to,
      generated_at: opts.now,
      session_count: sessions.length,
      totals,
      sessions,
      limit,
      has_more: hasMore,
    };
  }
}
