/**
 * Shared State Engine reducer.
 *
 * This package is the single runtime source for deterministic session projection. Backend ingestion
 * uses it to write `session_state`; WebUI replay uses the same reducer to reconstruct projection at
 * any event index without duplicating state semantics.
 */
import {
  eventTypeToActionKind,
  gateRedactionCountByKind,
  isKnownRedactionKind,
  isTerminalState,
  isValidTransition,
  type ActionKind,
  type NormalizedEvent,
  type State,
} from "@actradeck/event-model";

/**
 * 自動ガード (ADR 019ecc70 段階1・D3) の承認 pause **理由 (trigger)** 語彙。
 * event-model `ApprovalTrigger` (= z.enum(["destructive","secret","both"])) と同一の closed-enum。
 * projection はこの 3 値以外を **drop** する (raw / 未知文字列を投影に残さない・closed-enum 防御)。
 * 依存方向: projection は event-model schema を import できるが、ここでは値ゲートを純配列で持ち
 *   循環/重量級 schema を avoid する (allow-list と二重・小集合)。
 */
const APPROVAL_TRIGGERS: ReadonlySet<string> = new Set(["destructive", "secret", "both"]);

export interface PendingApproval {
  readonly request_id: string;
  readonly tool_name: string | undefined;
  readonly command: string | undefined;
  readonly path: string | undefined;
  readonly risk_level: string | undefined;
  readonly requested_at: string;
  readonly session_id: string;
  /**
   * 自動ガード (ADR 019ecc70 D3): なぜ pause したか ("destructive" | "secret" | "both")。
   * closed-enum 防御: APPROVAL_TRIGGERS 以外 (raw / 未知文字列) は drop = undefined。
   * **optional**(後方互換): destructive のみの旧経路 / resolved 由来は欠落 (= 理由情報なし)。
   */
  readonly trigger: string | undefined;
  /**
   * 自動ガード (ADR 019ecc70 D3): secret-trigger の **kind 名のみ** (REDACTION_KINDS 語彙)。
   * INV-AUTOGUARD-NO-RAW: 原文 (秘匿値そのもの) は一切載せない。closed-enum 防御として
   * `isKnownRedactionKind` を満たす要素のみ採用し、未知値 / raw 文字列 (例 "ghp_xxx") は drop する
   * (PR#29 の no-raw-display と同方針)。空 / 全 drop / 欠落は undefined (= secret 起因でない)。
   */
  readonly secret_kinds: readonly string[] | undefined;
  /**
   * ADR 019ee0c0: この承認が **再起動跨ぎ永続 allowlist 対象**か (medium-bash + 非 secret +
   * repo 解決可 + feature-ON のとき sidecar が true を載せる)。UI はこれが true のときのみ
   * 「再起動後も許可」を提示する。closed-enum boolean 防御: `true` のみ採用し、それ以外
   * (未指定 / 非 boolean / "true" 文字列等) は undefined (= 永続化不可 = 安全側)。
   */
  readonly persistable: boolean | undefined;
}

export interface SessionProjection {
  readonly session_id: string;
  readonly state: State | undefined;
  /**
   * legacy summary (normalizer が焼き込んだ日本語固定文字列)。**fallback 専用**。
   * 表示時ローカライズ (ADR 019eeac6) では UI は current_action_kind + current_action_subject を
   * 優先し、これは webui が両者を解釈できない旧 DTO / 旧行向けの後方互換に留める。
   */
  readonly current_action: string | undefined;
  /**
   * 最新イベントの event_type を写した ActionKind (closed-enum・表示時ローカライズの分類軸)。
   * 出所は最新 event の `event_type` (純写像 eventTypeToActionKind)。未確定は undefined。
   * webui がこの kind + subject を locale 別述語テンプレートへ流し込む (日本語述語の焼付けを断つ)。
   */
  readonly current_action_kind: ActionKind | undefined;
  /**
   * 最新イベントの「対象」構造値 (command / path / server/tool / query / tool_name / reason)。
   * **出所は redacted payload の kind 別 allowlist フィールドのみ** (ADR 019eeac6 絶対契約):
   * sink choke (redactDeepWithCount) を通った後の payload からのみ引き、normalizer 生入力や
   * 未 redaction 中間値からは決して引かない。`summary` は subject にしない (日本語が焼き付いて
   * いるため)。subject に出来る構造値が無い kind は undefined。
   */
  readonly current_action_subject: string | undefined;
  readonly last_event_id: string | undefined;
  readonly last_event_at: string | undefined;
  readonly needs_attention: boolean;
  readonly pending_approvals: readonly PendingApproval[];
  readonly invalid_transition_count: number;
  /**
   * session 内で redaction が一度でも秘匿を検出したか (bool OR 畳み込み)。
   * ADR 019ea4ba 段階2 / 右ペイン secret_detected の session 単位投影。**秘匿値そのものは持たない**
   * (NormalizedEvent.redaction_count = redacted な件数のみ由来)。
   */
  readonly secret_detected: boolean;
  /**
   * session 内の `[REDACTED:*]` マーカー累積件数 (合算畳み込み)。bool の補助 (検出の濃度)。
   * **冪等**: 同一 event_id の再適用で増えない (INV-SECRET-DETECTED-FOLD)。
   */
  readonly secret_redaction_count: number;
  /**
   * session 内の redaction を **kind 別**に累積した件数 (強み(a)③ redaction 可視化)。
   * 各 kind を合算で畳み込む (`{github-token: 5, aws-access-key-id: 2}` 等)。**秘匿値そのものは
   * 持たない** (kind 名 = 公開 enum + 件数のみ)。出所は NormalizedEvent.redaction_count_by_kind。
   *
   * 正直な不変条件 (QA-1/TDA-2): `sum(secret_redaction_count_by_kind の値) <= secret_redaction_count`。
   *   by_kind は **既知 kind に帰属した件数の部分集合**、secret_redaction_count は全 `[REDACTED:*]`
   *   マーカー数。等号は「全 event が by_kind を持ち、全マーカーが既知 kind」のときのみ成立する。
   *   legacy/混在 event (redaction_count あり・redaction_count_by_kind 欠落) を畳むと scalar は加算・
   *   by-kind は no-op となり `sum(by_kind) < secret_redaction_count` になる (`===` の旧主張は誇張)。
   * **冪等**: secret_redaction_count と同じ last_event_id ゲートに相乗りし、同一 event_id の再適用で
   * 二重加算しない (INV-SECRET-DETECTED-FOLD kind 別版)。
   */
  readonly secret_redaction_count_by_kind: Record<string, number>;
}

export function initialProjection(sessionId: string): SessionProjection {
  return {
    session_id: sessionId,
    state: undefined,
    current_action: undefined,
    current_action_kind: undefined,
    current_action_subject: undefined,
    last_event_id: undefined,
    last_event_at: undefined,
    needs_attention: false,
    pending_approvals: [],
    invalid_transition_count: 0,
    secret_detected: false,
    secret_redaction_count: 0,
    secret_redaction_count_by_kind: {},
  };
}

export interface ReduceResult {
  readonly projection: SessionProjection;
  readonly invalidTransition: boolean;
  readonly ignoredAfterTerminal: boolean;
}

export const MAX_PENDING_APPROVALS = 64;

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

/**
 * 自動ガード (ADR 019ecc70 D3) closed-enum 防御: trigger を APPROVAL_TRIGGERS の 3 値に閉じる。
 * 未知文字列 / 非文字列 / raw は **drop** (= undefined)。raw / 任意文字列を投影に残さない。
 */
function normalizeTrigger(v: unknown): string | undefined {
  return typeof v === "string" && APPROVAL_TRIGGERS.has(v) ? v : undefined;
}

/**
 * 自動ガード (ADR 019ecc70 D3) closed-enum 防御 (INV-AUTOGUARD-NO-RAW):
 * secret_kinds の要素のうち `isKnownRedactionKind` を満たす **公開 enum のみ**採用し、未知値 / raw
 * 文字列 (例 "ghp_xxx") / 非文字列を drop する。空 / 非配列 / 全 drop は **undefined**
 *   (投影にキーを残さない・後方互換)。これが network 受信イベント (loose schema) の closed-enum
 *   enforcement choke で、crafted event の任意 kind 名 / 秘匿値素通しを遮断する。
 */
function normalizeSecretKinds(v: unknown): readonly string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: string[] = [];
  for (const k of v) {
    if (typeof k === "string" && isKnownRedactionKind(k)) out.push(k);
  }
  return out.length > 0 ? out : undefined;
}

/**
 * ADR 019ee0c0 closed-enum boolean 防御: persistable は **リテラル true のみ**採用する。
 * 非 boolean / "true" 文字列 / 1 / 欠落は **undefined** (= 永続化不可 = 安全側)。crafted event が
 * 文字列 "true" 等で UI の「再起動後も許可」を誤提示させるのを遮断する (sidecar が最終 eligibility 判定だが
 * 表示段でも安全側に倒す多層防御)。
 */
function normalizePersistable(v: unknown): boolean | undefined {
  return v === true ? true : undefined;
}

export function parsePendingApprovals(raw: unknown): readonly PendingApproval[] {
  if (!Array.isArray(raw)) return [];
  const out: PendingApproval[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const o = item as Record<string, unknown>;
    if (typeof o.request_id !== "string") continue;
    out.push({
      request_id: o.request_id,
      tool_name: str(o.tool_name),
      command: str(o.command),
      path: str(o.path),
      risk_level: str(o.risk_level),
      requested_at: str(o.requested_at) ?? "",
      session_id: str(o.session_id) ?? "",
      // closed-enum 防御を read 層にも対称適用 (jsonb at-rest → DTO の透過点でも未知を drop)。
      trigger: normalizeTrigger(o.trigger),
      secret_kinds: normalizeSecretKinds(o.secret_kinds),
      persistable: normalizePersistable(o.persistable),
    });
  }
  return out;
}

function payloadString(payload: unknown, key: string): string | undefined {
  if (typeof payload !== "object" || payload === null) return undefined;
  const v = (payload as Record<string, unknown>)[key];
  return typeof v === "string" ? v : undefined;
}

function payloadValue(payload: unknown, key: string): unknown {
  if (typeof payload !== "object" || payload === null) return undefined;
  return (payload as Record<string, unknown>)[key];
}

/**
 * action subject 導出の **単一の正典写像** (event_type → redacted payload allowlist field・ADR 019eeac6).
 *
 * projection (`deriveCurrentActionSubject`) と replay-store (ReplayEventDTO.subject) の **両方**が
 * この純関数を共有し、kind→field 写像の二重実装 (ドリフト源) を断つ (TDA 最重要)。projection は
 * NormalizedEvent.payload を、replay-store は EventRow の payload->> 列から組んだ payload-like を渡す。
 *
 * event_type 別 allowlist フィールドのみを **redacted payload** から引く。出所は sink choke
 * (redactDeepWithCount) を通った後の payload (= at-rest redacted な `payload->>` 列) に限定し、
 * `summary` は決して使わない (日本語が焼き付いているため)。subject に出来る構造値が無い
 * event_type は undefined。
 *
 * ## INV-CURRENT-ACTION-NO-LEAK / INV-REPLAY-SUBJECT-NO-LEAK (load-bearing)
 * 引く値はすべて payload の allowlist フィールド。これらは sink で redactDeepWithCount により
 * payload 全体 (nested string + key 名) が再帰 redaction された後の値なので、raw secret は既に
 * `[REDACTED:<kind>]` マーカーへ置換済 (= subject に raw secret は載らない)。projection / replay-store
 * は再 redaction しない (redactor は sidecar 専有・新 redaction 面ゼロ)。
 *
 * 値の出所 (event_type → field・payload.ts kind-discriminated union 準拠):
 *  - command.started / command.completed / tool.failed → payload.command
 *  - file.change.* → payload.path / tool.permission.requested → payload.command ?? payload.path
 *  - mcp.call.* → payload.server (+ "/" + payload.tool) を組み立て
 *  - web.search.started → payload.query
 *  - tool.started / tool.completed → payload.tool_name
 *  - session.ended → payload.reason / turn.failed → payload.error ?? payload.reason
 *  (diff.updated / heartbeat / turn.completed 等 構造的 subject 無し → undefined)
 */
export function deriveActionSubject(eventType: string, payload: unknown): string | undefined {
  const p = payload;
  switch (eventType) {
    case "command.started":
    case "command.completed":
    case "tool.failed":
      return payloadString(p, "command");
    case "file.change.proposed":
    case "file.change.approved":
    case "file.change.applied":
      return payloadString(p, "path");
    case "tool.permission.requested":
      // 承認対象は command (Bash 等) を最優先、無ければ path (ファイル承認)。
      return payloadString(p, "command") ?? payloadString(p, "path");
    case "mcp.call.started":
    case "mcp.call.completed": {
      const server = payloadString(p, "server");
      const tool = payloadString(p, "tool");
      if (server !== undefined && tool !== undefined) return `${server}/${tool}`;
      return server ?? tool;
    }
    case "web.search.started":
      return payloadString(p, "query");
    case "tool.started":
    case "tool.completed":
      return payloadString(p, "tool_name");
    case "session.ended":
      // session.ended payload は reason 専有 (T1 SessionEnded・payload.ts:57-59)。
      return payloadString(p, "reason");
    case "turn.failed":
      // turn.failed は T1 で error が正典フィールド (payload.ts TurnFailed)。codex rollout は
      // error と reason を両載せする (normalize-codex-rollout.ts turn_aborted: error=reason ?? "turn
      // aborted", reason=p.reason) ため、error を優先しつつ reason を後方互換 fallback として引く
      // (TDA-2: T1 を真実源に・payload.ts TurnFailed に reason を additive 明示済)。
      return payloadString(p, "error") ?? payloadString(p, "reason");
    default:
      // diff.updated / heartbeat / turn.completed / agent.* 等は構造的 subject 無し → undefined。
      return undefined;
  }
}

/**
 * projection 用ラッパ: NormalizedEvent から共有 `deriveActionSubject` を呼ぶ。
 * 写像本体は単一 (replay-store と共有) であり、ここは event→(event_type,payload) の橋渡しのみ。
 */
function deriveCurrentActionSubject(ev: NormalizedEvent): string | undefined {
  return deriveActionSubject(ev.event_type, ev.payload);
}

function foldPendingApprovals(
  prev: readonly PendingApproval[],
  ev: NormalizedEvent,
): readonly PendingApproval[] {
  if (ev.event_type === "tool.permission.requested") {
    const requestId = payloadString(ev.payload, "request_id");
    if (requestId === undefined) return prev;
    const entry: PendingApproval = {
      request_id: requestId,
      tool_name: payloadString(ev.payload, "tool_name"),
      command: payloadString(ev.payload, "command"),
      path: payloadString(ev.payload, "path"),
      risk_level: payloadString(ev.payload, "risk_level"),
      requested_at: ev.timestamp,
      session_id: ev.session_id,
      // 自動ガード (ADR 019ecc70 D3): tool.permission.requested の guard 理由を pending へ畳む。
      // closed-enum 防御を fold (書込点) にも適用し、未知 trigger / 未知 kind を投影に残さない。
      trigger: normalizeTrigger(payloadValue(ev.payload, "trigger")),
      secret_kinds: normalizeSecretKinds(payloadValue(ev.payload, "secret_kinds")),
      // ADR 019ee0c0: 永続化可否を pending へ畳む (closed-enum boolean・true のみ)。
      persistable: normalizePersistable(payloadValue(ev.payload, "persistable")),
    };
    const withoutDup = prev.filter((p) => p.request_id !== requestId);
    const next = [...withoutDup, entry];
    return next.length > MAX_PENDING_APPROVALS
      ? next.slice(next.length - MAX_PENDING_APPROVALS)
      : next;
  }
  if (ev.event_type === "tool.permission.resolved") {
    const requestId = payloadString(ev.payload, "request_id");
    if (requestId === undefined) return [];
    return prev.filter((p) => p.request_id !== requestId);
  }
  return prev;
}

/**
 * 強み(a)③: 既存の kind 別累積に 1 event の kind 別件数を合算した **新しい** record を返す
 * (prev は変更しない・純関数)。負値 / 非整数 / 非数値は安全側に無視する (件数は正整数のみ)。
 * 入力イベントが kind 別件数を持たない (欠落) 場合は prev をそのまま返す (no-op)。
 *
 * ## load-bearing な防御 (この関数は session_state jsonb / DTO / WS への唯一の書込点)
 * - **SEC-3 / SEC-1r (closed-enum gate・read/carry 対称)**: prev (DB jsonb 由来) と incoming
 *   (network 受信) の**両方**を単一 helper `gateRedactionCountByKind` で gate する。kind 名が
 *   event-model の正典語彙 `REDACTION_KINDS_SET` に無いものは **graceful に捨てる** (phantom / 任意
 *   kind 名 / secret 形文字列の key 注入を遮断)。network 受信イベント (`/ingest`) は loose schema
 *   `z.record(z.string(), …)` を通るため crafted event が任意 kind 名を載せうるが、本 gate が enforcement
 *   choke となる。prev も同 gate を通すことで、第二 writer / ops backfill / restore 経由の phantom が
 *   合算で read 層へ launder されない (read/carry を write と同一語彙で対称化)。
 * - **SEC-1 (prototype 防御・値域統一・TDA-1/TDA-2)**: helper は `Object.create(null)` (nullProto) で
 *   constructor / __proto__ 等の kind が継承プロパティへ解決されるのを防ぎ、値域を全消費面と同一の
 *   **正整数のみ** (`Number.isInteger && > 0`) に統一する (旧 >=0/>0/isFinite ドリフトを解消)。
 */
function mergeRedactionCountByKind(
  prev: Record<string, number>,
  incoming: Record<string, number> | undefined,
): Record<string, number> {
  if (incoming === undefined) return prev;
  // SEC-1r/SEC-3/TDA-1/TDA-2 (read/carry 対称化 + 単一 gate): prev (DB jsonb 由来) と incoming
  //   (network 受信) を**同一 helper `gateRedactionCountByKind`** で gate (closed-enum key
  //   allowlist + 正整数値域 + null-proto) してから畳む。prev を無条件コピーしない。第二 writer /
  //   ops backfill / restore / gate デプロイ前の既存行 経由で phantom kind が jsonb に紛れても、
  //   合算で read 層へ launder されない。値域・key gate は全消費面 (parse/DTO/audit/webui) と一致。
  const inc = gateRedactionCountByKind(incoming, true);
  const incKeys = Object.keys(inc);
  if (incKeys.length === 0) return prev; // 有効な incoming kind なし → no-op (prev 維持)。
  const out = gateRedactionCountByKind(prev, true);
  for (const k of incKeys) {
    out[k] = (out[k] ?? 0) + inc[k]!;
  }
  return out;
}

function deriveNeedsAttention(resultState: State | undefined, pendingCount: number): boolean {
  if (pendingCount > 0) return true;
  if (resultState !== undefined && resultState.startsWith("waiting.")) return true;
  return false;
}

export function applyEvent(prev: SessionProjection, ev: NormalizedEvent): ReduceResult {
  const current = prev.state;
  const incoming = ev.state;
  const pending = foldPendingApprovals(prev.pending_approvals, ev);

  // secret_detected の畳み込み (INV-SECRET-DETECTED-FOLD)。
  //   - bool OR: 一度でも検出されたら true を維持。
  //   - count 合算: redaction_count を累積。
  //   - 冪等 (QA-3, スコープ明示): fold が自前で防ぐのは **直前に適用したイベントと同一 event_id**
  //     (= prev.last_event_id) の**隣接**再適用のみ。任意の event_id 全域の重複排除は fold の責務
  //     ではなく、backend の `INSERT ... ON CONFLICT (event_id) DO NOTHING` + `inserted` ゲート
  //     (= 新規行のみ applyEvent) が担保する正準経路である (INV-IDEMPOTENCY / inv-ingest-store)。
  //     replay も append-only store の distinct event を順に流すため隣接以外の重複は来ない。
  //
  //   TDA-2 (Replay 契約・過大主張の降格): **redaction_count は events 列に永続しない**。よって
  //     events からの完全 rebuild では count は再現できず 0 になる。secret_redaction_count /
  //     secret_detected の唯一の権威は **session_state (増分投影) 列**であり、本 fold はその
  //     増分更新器にすぎない。「events から決定的に同値を rebuild」する性質は count には**適用
  //     されない** (events に count を載せない設計判断・migration/ingest-store コメント参照)。
  const isReapply = prev.last_event_id !== undefined && prev.last_event_id === ev.event_id;
  const evRedactionCount =
    typeof ev.redaction_count === "number" && Number.isFinite(ev.redaction_count)
      ? ev.redaction_count
      : 0;
  const secretRedactionCount = isReapply
    ? prev.secret_redaction_count
    : prev.secret_redaction_count + evRedactionCount;
  const secretDetected = isReapply
    ? prev.secret_detected
    : prev.secret_detected || evRedactionCount > 0;

  // 強み(a)③: kind 別件数を merge fold する (各 kind を合算)。冪等は上記 isReapply に相乗り
  //   (同一 event_id の隣接再適用では prev をそのまま維持し二重加算しない)。
  //   正直な不変条件 (QA-1/TDA-2): sum(secret_redaction_count_by_kind) <= secret_redaction_count。
  //   by_kind は既知 kind の部分集合・redaction_count は全マーカー数。legacy/混在 event
  //   (count あり・by_kind 欠落) では by-kind が no-op となり sum < count になりうる。
  const secretRedactionCountByKind = isReapply
    ? prev.secret_redaction_count_by_kind
    : mergeRedactionCountByKind(prev.secret_redaction_count_by_kind, ev.redaction_count_by_kind);

  // 表示時ローカライズ (ADR 019eeac6): kind は event_type の純写像、subject は redacted payload の
  //   allowlist フィールドのみ。**summary は subject にしない** (日本語が焼き付いているため)。
  //   subject が無いイベントは undefined を**書き込む** (prev を引き継がない): current_action_kind は
  //   常に最新イベント由来で更新されるため、kind と subject の世代を揃える (古い subject の残留を防ぐ)。
  const currentActionKind = eventTypeToActionKind(ev.event_type);
  const currentActionSubject = deriveCurrentActionSubject(ev);

  const baseNext: SessionProjection = {
    ...prev,
    last_event_id: ev.event_id,
    last_event_at: ev.timestamp,
    current_action: ev.summary ?? prev.current_action,
    current_action_kind: currentActionKind,
    current_action_subject: currentActionSubject,
    pending_approvals: pending,
    secret_detected: secretDetected,
    secret_redaction_count: secretRedactionCount,
    secret_redaction_count_by_kind: secretRedactionCountByKind,
  };

  const finalize = (resultState: State | undefined): SessionProjection => {
    const terminal = resultState !== undefined && isTerminalState(resultState);
    const effectivePending = terminal ? [] : pending;
    return {
      ...baseNext,
      pending_approvals: effectivePending,
      ...(resultState !== undefined ? { state: resultState } : {}),
      needs_attention: deriveNeedsAttention(resultState, effectivePending.length),
    };
  };

  if (incoming === undefined) {
    return {
      projection: finalize(current),
      invalidTransition: false,
      ignoredAfterTerminal: false,
    };
  }

  if (current !== undefined && isTerminalState(current)) {
    return {
      projection: finalize(current),
      invalidTransition: false,
      ignoredAfterTerminal: true,
    };
  }

  if (current === undefined) {
    return {
      projection: finalize(incoming),
      invalidTransition: false,
      ignoredAfterTerminal: false,
    };
  }

  if (!isValidTransition(current, incoming)) {
    return {
      projection: {
        ...finalize(current),
        invalid_transition_count: prev.invalid_transition_count + 1,
      },
      invalidTransition: true,
      ignoredAfterTerminal: false,
    };
  }

  return {
    projection: finalize(incoming),
    invalidTransition: false,
    ignoredAfterTerminal: false,
  };
}

export function reduceEvents(
  sessionId: string,
  events: readonly NormalizedEvent[],
): SessionProjection {
  let proj = initialProjection(sessionId);
  for (const ev of events) {
    proj = applyEvent(proj, ev).projection;
  }
  return proj;
}
