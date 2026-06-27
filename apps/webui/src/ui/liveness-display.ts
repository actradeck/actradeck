/**
 * liveness の **表示用** 派生 (純関数・状態と表示の分離).
 *
 * frontend.md: 「観測されている作業状態」を表示し、停止を断定しない。
 * 一覧 1 行で「動いているか / 介入要否」が分かるよう、liveness_state と
 * needs_attention / waiting 系を短いラベルに落とす。意味づけ (live/stalled の判定) は
 * backend liveness が正典。ここは見せ方だけ。
 */
import type { LivenessState, SessionListItem, SessionDetail } from "../realtime/contract";

export type LivenessTone = "ok" | "idle" | "warn" | "muted";

/**
 * 表示専用の liveness 値。backend 契約 `LivenessState` (live/idle/stalled/unknown) に、
 * **接続が観測できない事実**を表す表示専用値 `offline` を足したもの。
 * `offline` は「sidecar との live 接続が無い」という観測事実であり、「プロセス停止/dead」の
 * 断定ではない (INV-STALLED-UI)。backend には書き戻さない・表示層でのみ使う。
 */
export type LivenessDisplay = LivenessState | "offline";

export interface LivenessBadge {
  readonly label: string;
  readonly tone: LivenessTone;
  /** スクリーンリーダ/ツールチップ用の補足。 */
  readonly title: string;
}

/**
 * "LIVE" とみなす鮮度窓。backend の `DEFAULT_STALE_MS`(60s)と一致させる
 * (ageMs ≤ staleMs を fresh とし anyFresh→live とする backend 合成と同じ境界)。
 */
export const LIVE_FRESH_MS = 60_000;

/**
 * 保存済み `liveness_state` を **表示時の鮮度** で補正する (純関数)。
 *
 * `liveness_state` は ingest 時に算出され session_state に保存される **凍結スナップショット**で、
 * 無活動 / 履歴(切断済み)セッションでは古い "live" が残る (再 ingest が無い限り decay しない)。
 * 鮮度は now に対する相対量なので、age 列と同じく **クライアントが毎秒評価**して補正する。
 *
 * 規則 (優先順):
 *  1. 切断 (`!connected`) → `offline`。sidecar との live 接続が無いという**観測事実**を出す。
 *     凍結された古い `liveness_state` (履歴に残る "live" 等) より接続の有無を優先する。
 *     「停止/dead」とは断定しない (INV-STALLED-UI): "offline"=接続が観測できないだけ。
 *  2. 接続中で保存が "live" のとき、最終イベントが鮮度窓内 (≤60s) なら `live`、外なら `idle`。
 *  3. 接続中で "live" 以外 (idle/stalled/unknown) は据え置く (既に非断定)。
 * last_event_at にはハートビート event も反映されるため、その age が全シグナルの鮮度の代理に
 * なる (backend anyFresh と整合)。
 */
export function effectiveLivenessState(
  item: Pick<SessionListItem, "liveness_state" | "connected" | "last_event_at">,
  nowMs: number,
): LivenessDisplay {
  if (!item.connected) return "offline";
  if (item.liveness_state !== "live") return item.liveness_state;
  const t = item.last_event_at ? Date.parse(item.last_event_at) : NaN;
  const fresh = Number.isFinite(t) && nowMs - t <= LIVE_FRESH_MS;
  return fresh ? "live" : "idle";
}

/** liveness_state を 1 語ラベル + トーンへ。停止は「suspected」で断定を避ける。 */
export function livenessBadge(state: LivenessDisplay, stalledSuspected: boolean): LivenessBadge {
  switch (state) {
    case "live":
      return { label: "LIVE", tone: "ok", title: "fresh heartbeat observed" };
    case "idle":
      return {
        label: "IDLE",
        tone: "idle",
        title: "signals stale but process not confirmed dead — not asserting stopped",
      };
    case "stalled":
      // INV-STALLED (UI 層): UI は停止を **断定しない**。liveness_state==="stalled" は backend が
      // 「stalled_suspected」として合成した結果であり (realtime-store が常に suspected を立てる)、
      // UI 側で断定形 "STALLED" を足さない。bool に関わらず suspected 表記を保つ。
      return {
        label: "STALLED?",
        tone: "warn",
        title: stalledSuspected
          ? "process not alive and no fresh signal — stalled suspected"
          : "stalled reported by backend — shown as suspected (UI never asserts stopped)",
      };
    case "offline":
      // 接続が観測できない (履歴/sidecar 不在)。停止の断定ではなく「接続が無い」事実。
      return {
        label: "OFFLINE",
        tone: "muted",
        title: "no live sidecar connection — session not attached (not asserting stopped)",
      };
    case "unknown":
    default:
      return { label: "UNKNOWN", tone: "muted", title: "no heartbeat signals observed" };
  }
}

/** waiting/承認待ち系を state 文字列から検出 (強調表示用)。停止断定はしない。 */
export function waitingKind(state: string | undefined): "approval" | "input" | "auth" | null {
  if (!state) return null;
  if (state.includes("approval")) return "approval";
  if (state.includes("auth")) return "auth";
  if (state.includes("input") || state.includes("waiting")) return "input";
  return null;
}

/** 一覧行が「自分が対応すべき」かを 1 つの bool に集約 (KPI: 1 行で介入要否)。 */
export function needsOperator(item: SessionListItem): boolean {
  return item.needs_attention || waitingKind(item.state) !== null;
}

/** detail の heartbeat 分解を表示順に並べる (process/event/stdout/file/model-stream)。 */
export interface HeartbeatRow {
  readonly kind: string;
  readonly observed: boolean;
  readonly ageMs: number | null;
  readonly fresh: boolean | null;
  readonly extra: string | null;
}

export function heartbeatRows(detail: SessionDetail): readonly HeartbeatRow[] {
  const e = detail.liveness_evidence;
  const rows: HeartbeatRow[] = [
    {
      kind: "process",
      observed: e.process !== undefined,
      ageMs: e.process?.ageMs ?? null,
      fresh: e.process?.fresh ?? null,
      extra: e.process ? (e.process.alive ? "alive" : "not alive") : null,
    },
    {
      kind: "event",
      observed: e.event !== undefined,
      ageMs: e.event?.ageMs ?? null,
      fresh: e.event?.fresh ?? null,
      extra: null,
    },
    {
      kind: "stdout",
      observed: e.stdout !== undefined,
      ageMs: e.stdout?.ageMs ?? null,
      fresh: e.stdout?.fresh ?? null,
      extra: null,
    },
    {
      kind: "file",
      observed: e.file !== undefined,
      ageMs: e.file?.ageMs ?? null,
      fresh: e.file?.fresh ?? null,
      extra: null,
    },
    {
      kind: "model-stream",
      observed: e.modelStream !== undefined,
      ageMs: e.modelStream?.ageMs ?? null,
      fresh: e.modelStream?.fresh ?? null,
      extra: null,
    },
  ];
  return rows;
}
