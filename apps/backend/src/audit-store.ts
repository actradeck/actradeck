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
  buildCoverageReport,
  gateRedactionCountByKind,
  REDACTION_KINDS,
  REDACTION_MARKER_PATTERN,
  REDACTION_MARKER_PREFIX,
  REDACTION_MARKER_SUFFIX,
  redactionMarker,
  TERMINAL_STATES,
} from "@actradeck/event-model";
import type { AuditCoverageReport } from "@actradeck/event-model";

import {
  asResolutionOrigin,
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
  /** TDA-1 (Phase 4 R2): relay_lost 合成 retire を operator gate と分離集計するための出所。 */
  resolution_origin: string | null;
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

/**
 * approval グループ行 (1 session 分) を summary へ畳む。
 * TDA-1 (Phase 4 R2): resolution_origin=relay_lost の resolved は backend 合成の retire
 * (誰も決定していない・agent へ何も届いていない) ゆえ by_decision (→ hard/soft gate) へ**含めず**
 * syntheticRetired へ別立て計上する — 実施していないゲートを実施したと数えない。
 */
function foldApprovals(rows: readonly ApprovalGroupRow[]): {
  total: number;
  byDecision: AuditDecisionTally;
  highRisk: number;
  syntheticRetired: number;
} {
  const byDecision = emptyDecisionTally();
  let total = 0;
  let highRisk = 0;
  let syntheticRetired = 0;
  for (const r of rows) {
    if (r.event_type === "tool.permission.requested") {
      total += r.n;
      if (r.risk_level !== null && HIGH_RISK_LEVELS.has(r.risk_level)) highRisk += r.n;
    } else if (r.event_type === "tool.permission.resolved") {
      if (r.resolution_origin === "relay_lost") {
        syntheticRetired += r.n;
        continue;
      }
      const d = asDecision(r.decision);
      if (d !== undefined) byDecision[d] += r.n;
    }
  }
  return { total, byDecision, highRisk, syntheticRetired };
}

function metaToSummary(
  r: SessionMetaRow,
  approvals: {
    total: number;
    byDecision: AuditDecisionTally;
    highRisk: number;
    syntheticRetired: number;
  },
  autoAllowedCount: number,
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
      synthetic_retired: approvals.syntheticRetired,
      // TDA-1 (R2): 合成 retire 済みは「未解決」でも「gate 済み」でもない — pending から除く。
      pending: Math.max(0, approvals.total - decidedTotal - approvals.syntheticRetired),
    },
    high_risk_op_count: approvals.highRisk,
    auto_allowed_count: autoAllowedCount,
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

  /**
   * 対象 session 群の無プロンプト自動許可 (auto_allowed=true) の **full-session** 件数を 1 往復で数える。
   * events の auto_allowed マーカーは start イベント (command.started 等) に 1 操作 1 回付く (normalize.ts)
   * ため、件数 = auto-allowed 操作数。sessionSummary(単一) と rangeReport(複数) が共有 (単一出所・TDA-1)。
   * report route の 10000-event 打ち切りに依存しない (by_decision / high_risk と同じ full 集計)。
   */
  private async autoAllowedCounts(sessionIds: readonly string[]): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    if (sessionIds.length === 0) return out;
    const { rows } = await this.pool.query<{ session_id: string; n: number }>(
      `SELECT session_id, count(*)::int AS n
         FROM events
        WHERE session_id = ANY($1::text[])
          AND jsonb_typeof(payload->'auto_allowed') = 'boolean'
          AND (payload->>'auto_allowed')::boolean = true
        GROUP BY session_id`,
      [sessionIds],
    );
    for (const r of rows) out.set(r.session_id, r.n);
    return out;
  }

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
              payload->>'resolution_origin' AS resolution_origin,
              payload->>'risk_level' AS risk_level,
              count(*)::int AS n
         FROM events
        WHERE session_id = $1 AND event_type = ANY($2::text[])
        GROUP BY session_id, event_type, decision, resolution_origin, risk_level`,
      [sessionId, APPROVAL_EVENT_TYPES],
    );
    const approvals = foldApprovals(groupRows);
    const autoCounts = await this.autoAllowedCounts([sessionId]);

    let entries: AuditApprovalEntry[] | undefined;
    if (opts?.detail) entries = await this.approvalEntries(sessionId);

    return metaToSummary(meta, approvals, autoCounts.get(sessionId) ?? 0, entries);
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
      resolution_origin: string | null;
    }>(
      `SELECT payload->>'request_id' AS request_id,
              payload->>'decision' AS decision,
              payload->>'resolution_origin' AS resolution_origin
         FROM events
        WHERE session_id = $1 AND event_type = 'tool.permission.resolved'
        ORDER BY timestamp ASC, event_id ASC`,
      [sessionId],
    );
    // TDA-1 (R2): decision と併せて resolution_origin (closed gate 済み) を持ち回り、packet の
    // what-to-review が relay_lost 合成 retire を operator の denied と別 reason で表示できるようにする。
    const decisionByRequest = new Map<
      string,
      { decision: AuditDecision; origin: ReturnType<typeof asResolutionOrigin> }
    >();
    for (const r of resRows) {
      const d = asDecision(r.decision);
      if (r.request_id !== null && d !== undefined) {
        decisionByRequest.set(r.request_id, {
          decision: d,
          origin: asResolutionOrigin(r.resolution_origin),
        });
      }
    }
    return reqRows.map((r) => {
      const resolved = r.request_id !== null ? decisionByRequest.get(r.request_id) : undefined;
      return {
        event_id: r.event_id,
        timestamp: r.timestamp.toISOString(),
        tool_name: r.tool_name ?? undefined,
        risk_level: r.risk_level ?? undefined,
        command: r.command ?? undefined,
        path: r.path ?? undefined,
        decision: resolved?.decision,
        resolution_origin: resolved?.origin,
        auto_allowed: r.auto_allowed ?? undefined,
      };
    });
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
   * 監査欠落の検知 (audit-gap visibility・ADR 019f4cdb Phase 1): per-provider の「最終受信サーバ時刻」と
   * 「監査できていない時間 (gap 候補)」を集約する read-only 導出。
   *
   * ## ingested_at 権威 (ADR §6-5)
   * 最終受信は **`MAX(events.ingested_at)` (サーバ受信 clock)** から導く。adapter 申告 `timestamp`
   * (session_state.last_event_at 由来) は clock skew で gap を隠すため gap の権威にしない — `MAX(timestamp)`
   * は表示補助 (`last_event_timestamp`) としてのみ返す。gap 述語は event-model の正準
   * `computeProviderCoverage` に閉じ (backend/webui が共有・drift 禁止)。
   *
   * ## 非稼働 ≠ gap (ADR §6-6)
   * per-provider の active_session_count = **非 terminal (稼働中) session 数**を数える。terminal 判定は
   * `sessions.ended_at IS NOT NULL OR session_state.state ∈ TERMINAL_STATES` (T1 正典 TERMINAL_STATES を
   * SQL へ再定義せず bind)。稼働 session が 0 の provider は `gap_candidate_ms=null` (誤警報しない)。
   *
   * ## seq-drop 下限 (ADR 019f4cdb Phase2)
   * client 申告 `seq` (per-session 連続カウンタ) を持つ session について provider 別に欠落下限を総和する
   * (`seqagg` CTE)。`seq` は非負整数カウンタ (原文非依存) ゆえ集計のみで NO-RAW を保つ。seq-bearing
   * session ゼロの provider は null (検知対象外)。密性前提違反 (区間の過半が穴) の session は **suppress**
   * (寄与 0・`seq_suppressed_session_count` で可観測) して非密 seq (global カウンタ誤用等) の偽警報 + overflow を
   * 抑える。この CTE は event-model の正準 `evaluateSeqMissing` (抑制込み) の **鏡写し**で、real-PG parity
   * テスト (INV-SEQ-DROP-PARITY) が両者の一致を縛る。**鏡写しは schema/CHECK の保証域上でのみ成立する**:
   * `NormalizedEvent.seq` = 非負 safe-integer + migration の `CHECK (seq IS NULL OR seq >= 0)` により、
   * SQL の `max/min/count(DISTINCT)` は非負・safe-integer 域の値を扱う (負値混入は CHECK が構造遮断)。
   *
   * ## NO-RAW (INV-AUDIT-COVERAGE-NO-RAW)
   * **SELECT 投影**は provider slug + 時刻 + 件数 (seq 集計含む・原文非依存) のみで、cwd/path/secret
   * を一切読まない (SEC-R3-5: WHERE 句は `payload->>'resolution_origin'` を固定リテラル比較で参照
   * するが、payload 由来の値が投影・応答へ到達する経路は無い)。行は `buildCoverageReport` →
   * `projectProviderCoverageRow` で provider を `PROVIDER_SLUG_RE` 再ゲートし余剰 field を構造的に
   * 落とす (生パス混入 row は drop)。
   *
   * events を provider で GROUP BY 集約する (ingested_at と timestamp の MAX を同スキャンで併算)。planner は
   * これを **seq-scan** で実行する — `(provider, ingested_at)` 索引を足しても MAX(timestamp) の heap 参照が
   * 必須で index-only にならず、少数 provider の全集約では seq-scan がコスト最小 (EXPLAIN 実測・TDA-1)。監査面の
   * 低頻度 read-only 集約ゆえ許容し、専用索引は `WHERE provider=X AND ingested_at > since` の範囲フィルタを
   * 導入する後続スライス (heartbeat/observation_gaps) へ defer する (無益な書込増幅を hot な events 表に課さない)。
   */
  async providerCoverage(opts: { readonly now: Date }): Promise<AuditCoverageReport> {
    const { rows } = await this.pool.query<{
      provider: string;
      total_session_count: number;
      active_session_count: number;
      max_ingested_ms: number | null;
      max_ts_ms: number | null;
      seq_missing_lower_bound: string | number | null;
      seq_tracked_session_count: number | null;
      seq_suppressed_session_count: number | null;
    }>(
      // $1 = TERMINAL_STATES (T1 正典・SQL へ再定義しない)。
      `WITH sess AS (
         SELECT s.provider,
                (s.ended_at IS NOT NULL OR ss.state = ANY($1::text[])) AS terminal
           FROM sessions s
           LEFT JOIN session_state ss ON ss.session_id = s.session_id
       ),
       prov AS (
         SELECT provider,
                count(*)::int AS total_session_count,
                count(*) FILTER (WHERE NOT COALESCE(terminal, false))::int AS active_session_count
           FROM sess
          GROUP BY provider
       ),
       ev AS (
         -- 権威クロック: サーバ受信時刻 ingested_at の provider 別 MAX。timestamp(adapter 申告)は表示補助。
         -- SEC-R2-2 (Phase 4 R3): relay_lost retire は「provider からの受信」ではないため除外する
         -- (合成 ingest が当該 provider の受信 gap を覆い隠さない)。判定は producer 申告の
         -- resolution_origin (正当な産出者は backend reconciler のみ・SEC-R3-4: in-boundary の詐称は
         -- 自分を stale に見せる安全方向のみ)。liveness 側 (aggregateObservationSql /
         -- observeFromEvents) の除外と同一の申告 field。
         SELECT provider,
                max(extract(epoch from ingested_at) * 1000) AS max_ingested_ms,
                max(extract(epoch from timestamp) * 1000) AS max_ts_ms
           FROM events
          WHERE NOT (event_type = 'tool.permission.resolved'
                     AND COALESCE(payload->>'resolution_origin' = 'relay_lost', false))
          GROUP BY provider
       ),
       seqagg AS (
         -- seq-drop 下限 (ADR 019f4cdb Phase2): per-session の欠落下限を provider へ総和する。
         -- 正準式 (event-model **evaluateSeqMissing** の鏡写し・密性抑制込み): 各 seq-bearing session につき
         --   raw_missing = (max(seq) − min(seq) + 1) − count(DISTINCT seq)  = 受信区間内の穴、
         --   distinct    = count(DISTINCT seq)。
         --   密性前提違反 (raw_missing > distinct = 区間の過半が穴) の session は **suppress**（寄与 0）し
         --   信号不能として seq_suppressed_session_count に計上する (SEC-1≡QA-4・非密/global カウンタ暴走を抑制)。
         --   抑制後 missing ≤ distinct ゆえ SUM ≤ Σdistinct ≤ 総イベント数へ有界化 (bigint overflow の芽を摘む)。
         -- 重複 seq は count(DISTINCT) が collapse (retry 冪等・二重挿入を欠落と誤認しない)。
         -- 対象は seq が **schema/CHECK 保証域** (非負・safe-integer) の非 NULL 行のみ (seq 非送出 adapter /
         --   旧行 NULL は検知対象外)。**「下限」の限界**: 末尾 (max より後) / 先頭 (min より前) の drop は検知不能。
         -- INV-SEQ-DROP-PARITY が実 PG で evaluateSeqMissing (抑制込み) と本 SQL の一致を縛る。
         SELECT provider,
                SUM(CASE WHEN raw_missing > distinct_seq THEN 0 ELSE raw_missing END)::bigint
                  AS seq_missing_lower_bound,
                count(*)::int AS seq_tracked_session_count,
                count(*) FILTER (WHERE raw_missing > distinct_seq)::int
                  AS seq_suppressed_session_count
           FROM (
             SELECT provider,
                    session_id,
                    (max(seq) - min(seq) + 1) - count(DISTINCT seq) AS raw_missing,
                    count(DISTINCT seq) AS distinct_seq
               FROM events
              WHERE seq IS NOT NULL
              GROUP BY provider, session_id
           ) per_session
          GROUP BY provider
       )
       SELECT prov.provider,
              prov.total_session_count,
              prov.active_session_count,
              ev.max_ingested_ms,
              ev.max_ts_ms,
              seqagg.seq_missing_lower_bound,
              seqagg.seq_tracked_session_count,
              seqagg.seq_suppressed_session_count
         FROM prov
         LEFT JOIN ev ON ev.provider = prov.provider
         LEFT JOIN seqagg ON seqagg.provider = prov.provider
        ORDER BY prov.provider`,
      [TERMINAL_STATES as readonly string[]],
    );
    // camelCase 集約入力へ写し、正準 builder (NO-RAW 射影 + gap 述語 + seq-drop 下限 + 密性抑制) へ委譲する。
    // seq_missing_lower_bound は bigint SUM ゆえ pg から文字列で届く (projectProviderCoverageRow が
    //   asNonNegSafeIntOrNull で safe-integer or null へ縮退)。seq-bearing session ゼロの provider は
    //   seqagg 非該当で NULL。
    const inputRows = rows.map((r) => ({
      provider: r.provider,
      maxIngestedAtMs: r.max_ingested_ms,
      maxEventTimestampMs: r.max_ts_ms,
      activeSessionCount: r.active_session_count,
      totalSessionCount: r.total_session_count,
      seqMissingLowerBoundSum: r.seq_missing_lower_bound,
      seqTrackedSessionCount: r.seq_tracked_session_count ?? 0,
      seqSuppressedSessionCount: r.seq_suppressed_session_count ?? 0,
    }));
    return buildCoverageReport(inputRows, opts.now);
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
                payload->>'resolution_origin' AS resolution_origin,
                payload->>'risk_level' AS risk_level,
                count(*)::int AS n
           FROM events
          WHERE session_id = ANY($1::text[]) AND event_type = ANY($2::text[])
          GROUP BY session_id, event_type, decision, resolution_origin, risk_level`,
        [sessionIds, APPROVAL_EVENT_TYPES],
      );
      for (const r of groupRows) {
        const lane = groupBySession.get(r.session_id);
        if (lane) lane.push(r);
        else groupBySession.set(r.session_id, [r]);
      }
    }
    // full-session auto-allowed 件数を 1 往復で (by_decision と対称・TDA-1)。
    const autoCounts = await this.autoAllowedCounts(sessionIds);

    const sessions: AuditSessionSummary[] = [];
    // 集計は可変ローカルへ畳んで最後に readonly totals を構築する。
    let secretRedactionCount = 0;
    const byKind: Record<string, number> = Object.create(null) as Record<string, number>;
    const byDecision = emptyDecisionTally();
    let syntheticRetired = 0;
    let approvalTotal = 0;
    let highRiskOpCount = 0;
    let autoAllowedCount = 0;
    let sessionsWithSecret = 0;
    for (const meta of pageRows) {
      const approvals = foldApprovals(groupBySession.get(meta.session_id) ?? []);
      const summary = metaToSummary(meta, approvals, autoCounts.get(meta.session_id) ?? 0);
      sessions.push(summary);
      secretRedactionCount += summary.secret_redaction_count;
      for (const [k, v] of Object.entries(summary.secret_redaction_count_by_kind)) {
        byKind[k] = (byKind[k] ?? 0) + v;
      }
      for (const d of AUDIT_DECISIONS) {
        byDecision[d] += summary.approvals.by_decision[d];
      }
      syntheticRetired += summary.approvals.synthetic_retired;
      approvalTotal += summary.approvals.total;
      highRiskOpCount += summary.high_risk_op_count;
      autoAllowedCount += summary.auto_allowed_count;
      if (summary.secret_detected) sessionsWithSecret += 1;
    }
    const totals: AuditRangeTotals = {
      secret_redaction_count: secretRedactionCount,
      secret_redaction_count_by_kind: byKind,
      approvals_by_decision: byDecision,
      synthetic_retired: syntheticRetired,
      approval_total: approvalTotal,
      high_risk_op_count: highRiskOpCount,
      auto_allowed_count: autoAllowedCount,
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
