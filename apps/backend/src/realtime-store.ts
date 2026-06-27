/**
 * Realtime 配信用の読み出し層 (Phase 3 ③).
 *
 * session_state (reducer projection + liveness jsonb) と sessions (provider/repo/branch 等) を
 * join し、UI へ push する DTO (SessionListItem / SessionDetail) を組み立てる。
 *
 * REAL DATA ONLY: 実 PostgreSQL の永続 projection からのみ DTO を作る。生 payload には触れず
 * (backend は再 redaction しない / 新規露出させない)、redaction 済の projection/liveness のみ写す。
 */
import { gateRedactionCountByKind, isActionKind } from "@actradeck/event-model";

import type { ActionKind } from "@actradeck/event-model";

import type {
  LivenessEvidence,
  LivenessState,
  ProcessEvidence,
  SignalEvidence,
} from "./liveness.js";
import { cwdScopeClause, parseProjectScope } from "./project-scope.js";
import { parsePendingApprovals } from "./reducer.js";
import type { SessionApprovals, SessionDetail, SessionListItem } from "./realtime-hub.js";
import type { Pool } from "pg";

/**
 * session_state.liveness jsonb の永続表現 (ingest-store.upsertProjection が書く形)。
 *
 * TDA-4: 同じ jsonb 列を ingest-store.ts (reconstructLiveness) でも別定義で読む。書き手は
 * ingest-store.upsertProjection 単一なので現状ドリフトは無いが、形が変わる場合は両所を
 * lock-step で更新すること (統一は追跡 issue。strict な toEvidence を基底に寄せる方針)。
 */
interface PersistedLiveness {
  state?: unknown;
  reason?: unknown;
  stalled_suspected?: unknown;
  evaluated_at_ms?: unknown;
  evidence?: unknown;
  invalid_transition_count?: unknown;
}

/** session_state ⋈ sessions の 1 行 (DTO の素材)。 */
interface JoinedRow {
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
}

const JOIN_SELECT = `
  SELECT ss.session_id, s.provider, s.source, s.agent_id, s.repo, s.branch, s.cwd,
         s.capture_mode, s.permission_mode,
         ss.state, ss.current_action, ss.current_action_kind, ss.current_action_subject,
         ss.last_event_id, ss.last_event_at,
         ss.needs_attention, ss.liveness, ss.pending_approvals,
         ss.secret_detected, ss.secret_redaction_count, ss.secret_redaction_count_by_kind
    FROM session_state ss
    JOIN sessions s ON s.session_id = ss.session_id`;

/** capture_mode を型安全に写す (未知/欠落は undefined = managed 既定扱い・projection key 非使用)。 */
function toCaptureMode(v: unknown): "managed" | "attach" | "codex_rollout" | undefined {
  return v === "managed" || v === "attach" || v === "codex_rollout" ? v : undefined;
}

/**
 * 表示時ローカライズ (ADR 019eeac6): DB text の current_action_kind を ActionKind へ写す。
 * read 層も `isActionKind` で gate し、未知値 / NULL は undefined (= DTO でキー落とし・forward-compat)。
 * kind は **closed-enum の分類軸**であり、この関数の責務はその閉性 (allowlist 帰属) の担保のみ。
 */
function toActionKind(v: string | null): ActionKind | undefined {
  return typeof v === "string" && isActionKind(v) ? v : undefined;
}

const VALID_LIVENESS_STATES = new Set<LivenessState>(["live", "idle", "stalled", "unknown"]);

function toLivenessState(v: unknown): LivenessState {
  return typeof v === "string" && VALID_LIVENESS_STATES.has(v as LivenessState)
    ? (v as LivenessState)
    : "unknown";
}

/** liveness jsonb の evidence を型安全に写す (未知形は落とす)。 */
function toEvidence(raw: unknown): LivenessEvidence {
  if (typeof raw !== "object" || raw === null) return {};
  const r = raw as Record<string, unknown>;
  const out: {
    process?: ProcessEvidence;
    event?: SignalEvidence;
    stdout?: SignalEvidence;
    file?: SignalEvidence;
    modelStream?: SignalEvidence;
  } = {};
  const sig = (v: unknown): SignalEvidence | undefined => {
    if (typeof v !== "object" || v === null) return undefined;
    const o = v as Record<string, unknown>;
    if (typeof o.ageMs !== "number" || typeof o.fresh !== "boolean") return undefined;
    return { ageMs: o.ageMs, fresh: o.fresh };
  };
  const proc = r.process;
  if (typeof proc === "object" && proc !== null) {
    const o = proc as Record<string, unknown>;
    if (
      typeof o.ageMs === "number" &&
      typeof o.fresh === "boolean" &&
      typeof o.alive === "boolean"
    ) {
      out.process = { ageMs: o.ageMs, fresh: o.fresh, alive: o.alive };
    }
  }
  const ev = sig(r.event);
  if (ev) out.event = ev;
  const so = sig(r.stdout);
  if (so) out.stdout = so;
  const fi = sig(r.file);
  if (fi) out.file = fi;
  const ms = sig(r.modelStream);
  if (ms) out.modelStream = ms;
  return out;
}

/**
 * presence 述語: session_id → 接続在席か。store は SidecarRegistry を知らない(純 DB)ため、
 * server 層が `(sid) => registry.isLive(sid)` を注入する(ADR 019ea2bf)。既定は全 false
 * (presence 不明時は在席させない=履歴扱い。delta 経路では server が必ず注入する)。
 */
export type IsLivePredicate = (sessionId: string) => boolean;
const PRESENCE_UNKNOWN: IsLivePredicate = () => false;

/** connected を除いた DTO 素材(store は presence を知らず connected は server が被せる)。 */
function rowToListItem(r: JoinedRow): Omit<SessionListItem, "connected"> {
  const lv = r.liveness ?? {};
  const captureMode = toCaptureMode(r.capture_mode);
  // 表示時ローカライズ (ADR 019eeac6): kind は closed-enum gate。
  const currentActionKind = toActionKind(r.current_action_kind);
  // subject は projection が redacted payload の allowlist (deriveActionSubject) から導出した値で、
  // session_state に at-rest 永続済。backend はそれを **写すのみ** で再 redaction しない
  // (INV-CURRENT-ACTION-NO-LEAK は sidecar の sink choke に帰着・redactor は sidecar 専有)。
  const currentActionSubject = r.current_action_subject ?? undefined;
  return {
    session_id: r.session_id,
    provider: r.provider,
    source: r.source,
    agent_id: r.agent_id ?? undefined,
    repo: r.repo ?? undefined,
    branch: r.branch ?? undefined,
    cwd: r.cwd ?? undefined,
    state: r.state ?? undefined,
    current_action: r.current_action ?? undefined,
    last_event_at: r.last_event_at ? r.last_event_at.toISOString() : undefined,
    needs_attention: r.needs_attention,
    liveness_state: toLivenessState(lv.state),
    stalled_suspected: lv.stalled_suspected === true || toLivenessState(lv.state) === "stalled",
    // capture_mode は欠落時キーごと落とす (optional・managed 既定; DTO の後方互換)。
    ...(captureMode !== undefined ? { capture_mode: captureMode } : {}),
    // current_action_kind/subject も欠落時キーごと落とす (optional・後方互換; 表示時ローカライズ)。
    ...(currentActionKind !== undefined ? { current_action_kind: currentActionKind } : {}),
    ...(currentActionSubject !== undefined ? { current_action_subject: currentActionSubject } : {}),
  };
}

function rowToDetail(r: JoinedRow): Omit<SessionDetail, "connected"> {
  const base = rowToListItem(r);
  const lv = r.liveness ?? {};
  // 段階2: permission_mode は欠落時キーごと落とす (optional・後方互換; 表示専用)。
  const permissionMode =
    typeof r.permission_mode === "string" && r.permission_mode.length > 0
      ? r.permission_mode
      : undefined;
  // secret_detected: projection 由来の session 単位投影。欠落 (NULL = 旧行) はキーを落とす
  // (optional・後方互換; UI は未観測として表示を控える)。**秘匿値そのものは載らない** (件数/bool のみ)。
  const secretDetected = typeof r.secret_detected === "boolean" ? r.secret_detected : undefined;
  const secretRedactionCount =
    typeof r.secret_redaction_count === "number" && Number.isFinite(r.secret_redaction_count)
      ? r.secret_redaction_count
      : undefined;
  // 強み(a)③: kind 別件数。NULL (旧行) / 非 object はキーごと落とす (optional・後方互換)。
  //   件数 + kind 名のみで原文は載らない (非負有限数の値のみ採用)。
  const secretRedactionCountByKind = toRedactionCountByKind(r.secret_redaction_count_by_kind);
  return {
    ...base,
    last_event_id: r.last_event_id ?? undefined,
    liveness_evidence: toEvidence(lv.evidence),
    liveness_reason: typeof lv.reason === "string" ? lv.reason : "",
    liveness_evaluated_at_ms: typeof lv.evaluated_at_ms === "number" ? lv.evaluated_at_ms : 0,
    invalid_transition_count:
      typeof lv.invalid_transition_count === "number" ? lv.invalid_transition_count : 0,
    pending_approvals: parsePendingApprovals(r.pending_approvals),
    ...(permissionMode !== undefined ? { permission_mode: permissionMode } : {}),
    ...(secretDetected !== undefined ? { secret_detected: secretDetected } : {}),
    ...(secretRedactionCount !== undefined ? { secret_redaction_count: secretRedactionCount } : {}),
    ...(secretRedactionCountByKind !== undefined
      ? { secret_redaction_count_by_kind: secretRedactionCountByKind }
      : {}),
  };
}

/**
 * 強み(a)③: 永続 jsonb を型安全な `Record<string, number>` (件数のみ) へ写す。
 * NULL (旧行) / 非 object / 空 record は **undefined** (= DTO でキー落とし・後方互換)。
 * 値は非負有限数のみ採用 (件数のみ・kind 名は文字列キーで原文非依存)。
 */
function toRedactionCountByKind(raw: unknown): Record<string, number> | undefined {
  // SEC-1r/TDA-2: session_state jsonb → SessionDetail DTO → WS 配信の最終 read 面。write/merge/
  //   audit と同一 helper で gate (closed-enum key allowlist + 正整数値域) し、phantom が「秘匿の
  //   種類」として security 可視化 DTO/WS へ恒久 launder されるのを防ぐ。空は undefined (後方互換)。
  const out = gateRedactionCountByKind(raw);
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Realtime 読み出し。接続時の list snapshot / subscribe 時の detail snapshot を組み立てる。
 * delta 用の単一 session DTO も提供する (ingest 直後の push 整形)。
 */
export class RealtimeStore {
  /**
   * @param projectScope cwd 前方一致 allowlist (省略時は env ACTRADECK_PROJECT_SCOPE)。空=全件 (既定)。
   *   list 系 (listSnapshot / approvalsSnapshot) を一致セッションのみへ絞る (narrows only)。
   *   **display hygiene であって authz 境界ではない** (SEC-1 / ADR 019e92ae): by-id 詳細 (detail /
   *   listItem) は scope を適用しない — token 保持者が任意 session_id を渡せば scope 外も引ける。
   *   単一信頼オペレータ前提では leak ではない (詳細は project-scope.ts の「境界」)。
   */
  constructor(
    private readonly pool: Pool,
    private readonly projectScope: readonly string[] = parseProjectScope(
      process.env.ACTRADECK_PROJECT_SCOPE,
    ),
  ) {}

  /**
   * 全 session の一覧 DTO (接続直後の snapshot)。最近活動順。
   * `isLive` で各行の `connected`(接続在席)を被せる(server が registry.isLive を注入)。
   * projectScope が設定されていれば cwd 前方一致で絞る (concierge デモ等の他プロジェクト秘匿)。
   */
  async listSnapshot(
    limit = 500,
    isLive: IsLivePredicate = PRESENCE_UNKNOWN,
  ): Promise<SessionListItem[]> {
    // $1 = limit。scope は $2/$3 (cwd allowlist; 空なら no-op で WHERE を付けない)。
    const scope = cwdScopeClause(this.projectScope, "s.cwd", 2);
    const where = scope.clause.length > 0 ? `WHERE ${scope.clause}` : "";
    const { rows } = await this.pool.query(
      `${JOIN_SELECT}
        ${where}
        ORDER BY ss.last_event_at DESC NULLS LAST
        LIMIT $1`,
      [limit, ...scope.params],
    );
    return (rows as JoinedRow[]).map((r) => ({
      ...rowToListItem(r),
      connected: isLive(r.session_id),
    }));
  }

  /** 単一 session の一覧行 DTO (delta.list 用)。未存在なら undefined。 */
  async listItem(
    sessionId: string,
    isLive: IsLivePredicate = PRESENCE_UNKNOWN,
  ): Promise<SessionListItem | undefined> {
    const { rows } = await this.pool.query(`${JOIN_SELECT} WHERE ss.session_id = $1`, [sessionId]);
    const r = (rows as JoinedRow[])[0];
    return r ? { ...rowToListItem(r), connected: isLive(r.session_id) } : undefined;
  }

  /** 単一 session の詳細 DTO (snapshot.detail / delta.detail 用)。未存在なら undefined。 */
  async detail(
    sessionId: string,
    isLive: IsLivePredicate = PRESENCE_UNKNOWN,
  ): Promise<SessionDetail | undefined> {
    const { rows } = await this.pool.query(`${JOIN_SELECT} WHERE ss.session_id = $1`, [sessionId]);
    const r = (rows as JoinedRow[])[0];
    return r ? { ...rowToDetail(r), connected: isLive(r.session_id) } : undefined;
  }

  /**
   * Approval Inbox 集約 (ADR 019ead14 D1): **connected(接続在席)かつ pending_approvals 非空**の
   * 全 session の承認待ちを横断で返す。session_state.pending_approvals(sidecar redaction 済 jsonb)を
   * **再利用**するため新 SQL 列も新 redaction 面も作らない (backend は再 redaction しない)。
   * - SQL 段で `jsonb_array_length(ss.pending_approvals) > 0` で非空に絞る (列は jsonb NOT NULL default '[]')。
   * - connected フィルタは server 注入の `isLive`(SidecarRegistry.isLive)で適用 (切断/履歴は出さない)。
   *   → bypassPermissions セッションは pending を生成しない(approval-bridge 早期 defer)ため自動的に対象外。
   * 並びは最近活動順 (一覧と同方針)。各行内の pending は reducer の追加順 (= requested_at 昇順) を保つ。
   */
  async approvalsSnapshot(isLive: IsLivePredicate = PRESENCE_UNKNOWN): Promise<SessionApprovals[]> {
    // 既存 WHERE に AND で scope を足す (cwd allowlist; 空なら no-op)。params は $1/$2。
    const scope = cwdScopeClause(this.projectScope, "s.cwd", 1);
    const and = scope.clause.length > 0 ? `AND ${scope.clause}` : "";
    const { rows } = await this.pool.query(
      `${JOIN_SELECT}
        WHERE jsonb_array_length(ss.pending_approvals) > 0
        ${and}
        ORDER BY ss.last_event_at DESC NULLS LAST`,
      scope.params,
    );
    const out: SessionApprovals[] = [];
    for (const r of rows as JoinedRow[]) {
      if (!isLive(r.session_id)) continue; // presence: 接続在席のみ (履歴/切断は出さない)。
      const pending = parsePendingApprovals(r.pending_approvals);
      if (pending.length === 0) continue; // parse 後も非空であること (防御; 不正 jsonb 行を除外)。
      out.push({
        session_id: r.session_id,
        provider: r.provider,
        cwd: r.cwd ?? undefined,
        pending_approvals: pending,
      });
    }
    return out;
  }
}
