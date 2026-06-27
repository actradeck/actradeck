/**
 * ライブ session 一覧の状態 reducer (純関数・決定論).
 *
 * 責務 (状態と表示の分離 — ここは「状態」だけ):
 *  - `snapshot.list`: 一覧を **置き換える** (接続/再接続直後の完全同期)。
 *  - `delta.list`: 1 session を upsert (既存は差し替え、新規は追加)。
 *  - purge: イベントが途絶えて久しい session を一覧から落とす (バックプレッシャ/古いイベント対策)。
 *    ⚠️ purge は「停止の断定」ではない (停止判定は backend liveness が担う)。
 *    purge は **UI の表示容量管理**であり、live/stalled の意味づけはしない。
 *
 * 表示順は決定論的に: needs_attention を最優先で上 (介入要否が 1 行で分かる KPI)、
 * 次いで last_event_at 新しい順。表示コンポーネントはこの順序付き配列を描くだけ。
 */
import type { SessionListItem } from "./contract";

export interface ListState {
  /** session_id → 最新の行 DTO。挿入順は持たない (display で sort する)。 */
  readonly items: ReadonlyMap<string, SessionListItem>;
}

export const emptyListState: ListState = { items: new Map() };

/** snapshot で一覧を総入れ替え (再接続後の取りこぼし防止: 古い項は消える)。 */
export function applySnapshotList(sessions: readonly SessionListItem[]): ListState {
  const items = new Map<string, SessionListItem>();
  for (const s of sessions) items.set(s.session_id, s);
  return { items };
}

/** delta で 1 session を upsert。 */
export function applyListDelta(state: ListState, session: SessionListItem): ListState {
  const items = new Map(state.items);
  items.set(session.session_id, session);
  return { items };
}

export interface PurgeOptions {
  /** 判定基準時刻 (epoch ms)。テスト注入用。既定 Date.now()。 */
  readonly nowMs?: number;
  /** これより古い last_event_at の **stalled/idle 系** は一覧から落とす。既定 10 分。 */
  readonly maxIdleMs?: number;
}

/** purge 既定: 10 分イベントが無く live でない session は UI 一覧から外す。 */
const DEFAULT_PURGE_IDLE_MS = 600_000;

/**
 * バックプレッシャ/古いイベントの purge。
 * **接続在席(connected) または live は決して purge しない** (起動中・動いているものは消さない)。
 * ADR 019ea2bf: connected(presence) は無活動でも一覧に残す KPI(起動中の CC は消さない)に直結
 * するため、`connected === true` を purge 免除に加える(liveness_state==="idle" でも保持)。
 * last_event_at が無い (= unknown) ものも残す (証拠なしに消さない)。落とすのは「connected でなく、
 * かつ last_event_at が maxIdleMs より古く、かつ liveness_state が live でない」もののみ。
 */
export function purgeStale(state: ListState, opts: PurgeOptions = {}): ListState {
  const now = opts.nowMs ?? Date.now();
  const maxIdleMs = opts.maxIdleMs ?? DEFAULT_PURGE_IDLE_MS;
  let changed = false;
  const items = new Map<string, SessionListItem>();
  for (const [id, s] of state.items) {
    if (s.connected === true || s.liveness_state === "live") {
      items.set(id, s); // 接続在席 or live は消さない。
      continue;
    }
    if (s.last_event_at === undefined) {
      items.set(id, s); // 証拠なし → 残す。
      continue;
    }
    const t = Date.parse(s.last_event_at);
    if (!Number.isFinite(t) || now - t <= maxIdleMs) {
      items.set(id, s);
    } else {
      changed = true; // 落とす。
    }
  }
  return changed ? { items } : state;
}

export interface DisplayOptions {
  /**
   * 履歴(connected=false の完了/切断済み session)も含めるか。ADR 019ea2bf:
   * 既定 false = **接続在席(connected=true)のみ**表示(「いま起動中の CC だけ」KPI)。
   * true = 全件(履歴含む)。トグルで切替え、絞りは client 側(server 契約不変・即時)。
   */
  readonly showHistory?: boolean;
}

/**
 * 表示用に決定論ソートした配列を返す (display 層が描くだけにする)。
 * 既定は connected=true のみ(presence membership フィルタ)。showHistory=true で全件。
 * 優先順位: needs_attention(true 上) → last_event_at(新しい上, 欠損は最下) → session_id(安定).
 */
export function toDisplayList(
  state: ListState,
  opts: DisplayOptions = {},
): readonly SessionListItem[] {
  const showHistory = opts.showHistory ?? false;
  // 既定: 接続在席のみ。connected !== false で「欠落(不明)→表示寄り」も拾う(parse 正規化後は
  // 常に boolean だが防御的に)。showHistory=true なら全件。
  const arr = [...state.items.values()].filter((s) => showHistory || s.connected !== false);
  arr.sort((a, b) => {
    if (a.needs_attention !== b.needs_attention) return a.needs_attention ? -1 : 1;
    const ta = a.last_event_at ? Date.parse(a.last_event_at) : Number.NEGATIVE_INFINITY;
    const tb = b.last_event_at ? Date.parse(b.last_event_at) : Number.NEGATIVE_INFINITY;
    if (ta !== tb) return tb - ta;
    return a.session_id < b.session_id ? -1 : a.session_id > b.session_id ? 1 : 0;
  });
  return arr;
}
