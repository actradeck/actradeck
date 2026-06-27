/**
 * Server-side Liveness 合成判定 (Phase 3, plan.md §5 / §17 / §18 Stuck Detection).
 *
 * 「動いているか」を **単一のログ有無で判定しない**。process / event / stdout / file /
 * model-stream の複数 heartbeat を合成し、根拠 (各シグナルの age) を **分解保持**する。
 * 単一シグナルが古いだけでは停止 (stalled) を断定しない (INV-STALLED)。
 *
 * sidecar の synthesizeLiveness (process-monitor.ts) と同型の不変条件を満たすが、
 * こちらは backend がイベント列から各シグナルの「最終観測時刻」を導出する点が異なる:
 *  - process      : heartbeat イベントの payload.process_alive (生死) と観測時刻。
 *  - event        : 任意イベントの観測時刻 (= 何かしらイベントが流れているか)。
 *  - stdout       : command.output.delta / tool.output.delta の観測時刻。
 *  - file         : file.change.* / diff.updated の観測時刻。
 *  - model-stream : agent.message.delta / agent.reasoning_summary.delta の観測時刻。
 *
 * 内部データモデルは自前で安定化する (OTLP 等発展中仕様に依存させない)。
 */
import {
  FILE_EVENT_TYPES,
  HEARTBEAT_EVENT_TYPE,
  MODEL_STREAM_EVENT_TYPES,
  PROCESS_ALIVE_PAYLOAD_KEY,
  STDOUT_EVENT_TYPES,
  type NormalizedEvent,
} from "@actradeck/event-model";

/** liveness が扱うシグナル種別。 */
export type LivenessSignalKind = "process" | "event" | "stdout" | "file" | "modelStream";

/** 各シグナルの「最終観測時刻」(epoch ms)。process は生死も持つ。 */
export interface LivenessObservation {
  /** 最後に process_alive heartbeat を観測した時刻と、その時点の生死。 */
  readonly process?: { readonly alive: boolean; readonly atMs: number };
  readonly event?: { readonly atMs: number };
  readonly stdout?: { readonly atMs: number };
  readonly file?: { readonly atMs: number };
  readonly modelStream?: { readonly atMs: number };
}

export type LivenessState = "live" | "idle" | "stalled" | "unknown";

/** 1 シグナルの根拠 (age と新鮮判定)。UI/監査が「なぜ stalled か」を分解表示する。 */
export interface SignalEvidence {
  readonly ageMs: number;
  readonly fresh: boolean;
}
export interface ProcessEvidence extends SignalEvidence {
  readonly alive: boolean;
}

/** liveness 判定の根拠分解 (plan.md §17: process/stdout/event/model stream を分けて表示)。 */
export interface LivenessEvidence {
  readonly process?: ProcessEvidence;
  readonly event?: SignalEvidence;
  readonly stdout?: SignalEvidence;
  readonly file?: SignalEvidence;
  readonly modelStream?: SignalEvidence;
}

export interface LivenessResult {
  readonly state: LivenessState;
  readonly evidence: LivenessEvidence;
  /** 状態決定の人間可読な根拠。 */
  readonly reason: string;
  /** 判定基準時刻 (epoch ms)。再現性のため保持。 */
  readonly evaluatedAtMs: number;
  /** stalled 候補か (= state === "stalled")。projection の needs_attention 判断に使う。 */
  readonly stalledSuspected: boolean;
}

export interface SynthesizeOptions {
  /** これより新しい age は「生きている」とみなす閾値 (ms)。plan.md §17: 60s で stalled 候補。 */
  readonly staleMs?: number;
  /** 判定基準時刻 (省略時 Date.now())。テストで固定するために注入可能。 */
  readonly nowMs?: number;
}

/** plan.md §17: 60 秒以上イベントが無い running session は stalled suspected。 */
export const DEFAULT_STALE_MS = 60_000;

const SIGNAL_KEYS = ["event", "stdout", "file", "modelStream"] as const;

/**
 * 観測時刻群を合成して liveness 状態を返す (純関数・決定論)。
 *
 * 不変条件 (INV-STALLED / plan.md §5):
 *  1. **単一シグナルが古いだけでは stalled を断定しない**。process が古くても stdout 等が
 *     新しければ live (作業継続中)。
 *  2. stalled 候補は「観測できた全シグナルが古い」**かつ** process の消滅が確定 (alive=false)
 *     のときのみ。process 生死が未確定 (alive=true / 未観測) なら停止と言い切らず idle。
 *  3. 観測シグナルが 0 件なら unknown (証拠なしに停止断定しない)。
 *  4. 根拠 (各 age と fresh 判定) を evidence へ分解保持する。
 */
export function synthesizeLiveness(
  obs: LivenessObservation,
  opts: SynthesizeOptions = {},
): LivenessResult {
  const staleMs = opts.staleMs ?? DEFAULT_STALE_MS;
  const now = opts.nowMs ?? Date.now();

  const evidence: {
    process?: ProcessEvidence;
    event?: SignalEvidence;
    stdout?: SignalEvidence;
    file?: SignalEvidence;
    modelStream?: SignalEvidence;
  } = {};

  const freshFlags: boolean[] = [];
  let anyObserved = false;
  let processDead = false;

  if (obs.process) {
    anyObserved = true;
    const ageMs = Math.max(0, now - obs.process.atMs);
    const fresh = ageMs <= staleMs;
    evidence.process = { alive: obs.process.alive, ageMs, fresh };
    if (!obs.process.alive) processDead = true;
    // process は「生きていて新しい」ときのみ fresh シグナルとして数える。
    freshFlags.push(obs.process.alive && fresh);
  }

  for (const key of SIGNAL_KEYS) {
    const sig = obs[key];
    if (!sig) continue;
    anyObserved = true;
    const ageMs = Math.max(0, now - sig.atMs);
    const fresh = ageMs <= staleMs;
    evidence[key] = { ageMs, fresh };
    freshFlags.push(fresh);
  }

  if (!anyObserved) {
    return mk("unknown", evidence, "no heartbeat signals observed", now);
  }

  const anyFresh = freshFlags.some(Boolean);

  if (anyFresh) {
    // 1 つでも新しいシグナルがあれば live。単一の古いシグナルで停止断定しない。
    return mk(
      "live",
      evidence,
      "at least one fresh heartbeat — not stalled despite stale others",
      now,
    );
  }

  // ここから全シグナル stale。process の消滅が確定したときのみ stalled。
  if (processDead) {
    return mk(
      "stalled",
      evidence,
      "process not alive and no fresh event/stdout/file/model-stream signal",
      now,
    );
  }

  // 全シグナル古いが process 消滅は未確定 → 停止と言い切らず idle (over-assertion 回避)。
  return mk(
    "idle",
    evidence,
    "all observed signals stale but process not confirmed dead — not asserting stopped",
    now,
  );
}

function mk(
  state: LivenessState,
  evidence: LivenessEvidence,
  reason: string,
  evaluatedAtMs: number,
): LivenessResult {
  return { state, evidence, reason, evaluatedAtMs, stalledSuspected: state === "stalled" };
}

/**
 * イベント列から各シグナルの「最終観測時刻」を畳み込む (決定論)。
 *
 * - process: heartbeat イベントの payload.process_alive を生死として採用 (最新を優先)。
 *   process_alive を持たない heartbeat は event シグナルとしてのみ数える。
 * - event: **活動 (= 何かしら作業が流れている)** を表す汎用シグナル。
 *   ⚠️ QA-1 (死活誤判定) 対策: **process の消滅を確定させた heartbeat
 *   (process_alive:false)** は「活動」ではなく「死亡通知」であり、event 鮮度へ
 *   寄与させない。これを許すと、直近に死んだプロセスの heartbeat が event を fresh に
 *   保ち、synthesizeLiveness が processDead 判定の前に anyFresh で "live" と
 *   自己矛盾した断定をしてしまう (evidence.process.alive=false なのに live)。
 *   process_alive:true の heartbeat / 非 heartbeat イベントは従来どおり活動として数える。
 * - stdout: command.output.delta / tool.output.delta。
 * - file: file.change.* / diff.updated。
 * - modelStream: agent.message.delta / agent.reasoning_summary.delta。
 *
 * timestamp は ISO8601。out-of-order でも「最大 (最新) 時刻」を採用する (再送・順序揺れに頑健)。
 */
export function observeFromEvents(events: readonly NormalizedEvent[]): LivenessObservation {
  let event: number | undefined;
  let stdout: number | undefined;
  let file: number | undefined;
  let modelStream: number | undefined;
  let process: { alive: boolean; atMs: number } | undefined;
  // TDA-1 tie-break 正典: 勝者 heartbeat の event_id を保持する。同一 timestamp の typed
  // heartbeat が複数あるとき、SQL 集約 (aggregateObservationSql の hb CTE) は
  // `ORDER BY timestamp DESC, event_id DESC` で **event_id 最大**を採用する。PK id は TS から
  // 不可視・配列順は SQL から不可視のため、両側が共有できる唯一の安定キー event_id (UUIDv7) で
  // 揃える。配列後勝ち (t >= atMs) では同一 ms 内で id 非単調になり SQL と乖離しうるため不可。
  let processEventId: string | undefined;

  const max = (a: number | undefined, b: number): number => (a === undefined ? b : Math.max(a, b));

  for (const ev of events) {
    const t = Date.parse(ev.timestamp);
    if (!Number.isFinite(t)) continue;

    // QA-1: process 死亡を確定させた heartbeat は「活動」ではないので event 鮮度から除外する。
    // それ以外 (process_alive:true / process_alive 無しの naked heartbeat / 非 heartbeat
    // イベント) は活動として数える。除外条件は **真の JSON boolean false のときだけ**
    // (TDA-2: SQL の FILTER `payload->'process_alive' = 'false'::jsonb` と厳密一致させる正典。
    // 文字列 "false" / 数値 0 は boolean でないため活動として数える)。
    let countsAsActivity = true;
    let heartbeatAlive: boolean | undefined;
    if (ev.event_type === HEARTBEAT_EVENT_TYPE) {
      const alive = (ev.payload as Record<string, unknown>)[PROCESS_ALIVE_PAYLOAD_KEY];
      if (typeof alive === "boolean") {
        heartbeatAlive = alive;
        // process_alive:false の heartbeat のみ死亡通知。event(=活動) に寄与させない。
        // naked heartbeat (process_alive 無し) は alive 不明 → 活動として数える。
        if (alive === false) countsAsActivity = false;
      }
    }

    if (countsAsActivity) event = max(event, t);

    if (STDOUT_EVENT_TYPES.includes(ev.event_type as (typeof STDOUT_EVENT_TYPES)[number])) {
      stdout = max(stdout, t);
    } else if (FILE_EVENT_TYPES.includes(ev.event_type as (typeof FILE_EVENT_TYPES)[number])) {
      file = max(file, t);
    } else if (
      MODEL_STREAM_EVENT_TYPES.includes(ev.event_type as (typeof MODEL_STREAM_EVENT_TYPES)[number])
    ) {
      modelStream = max(modelStream, t);
    } else if (ev.event_type === HEARTBEAT_EVENT_TYPE && heartbeatAlive !== undefined) {
      // 最新の heartbeat の生死を採用。tie-break は SQL 正典 (timestamp 最新 → event_id 最大)。
      // 配列順ではなく event_id で勝者を決めることで aggregateObservationSql と決定論的に一致。
      const wins =
        process === undefined ||
        t > process.atMs ||
        (t === process.atMs && ev.event_id > (processEventId ?? ""));
      if (wins) {
        process = { alive: heartbeatAlive, atMs: t };
        processEventId = ev.event_id;
      }
    }
  }

  const out: {
    process?: { alive: boolean; atMs: number };
    event?: { atMs: number };
    stdout?: { atMs: number };
    file?: { atMs: number };
    modelStream?: { atMs: number };
  } = {};
  if (process !== undefined) out.process = process;
  if (event !== undefined) out.event = { atMs: event };
  if (stdout !== undefined) out.stdout = { atMs: stdout };
  if (file !== undefined) out.file = { atMs: file };
  if (modelStream !== undefined) out.modelStream = { atMs: modelStream };
  return out;
}
