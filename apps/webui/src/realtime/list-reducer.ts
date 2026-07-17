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
import { isPresentOrRecentlyActive } from "@actradeck/event-model";

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
    // ADR 019f474e: connected / live に加え、external adapter の直近 active(recency proxy)も
    // purge 免除に含める(表示されている external を容量管理で消さない・共有正準述語)。
    // coupling (QA-1/TDA-3・削除禁止): この免除は **display ⊆ ¬purge**(表示中 item を purge しない)を
    // 保つ防御ガード。既定窓では DEFAULT_PURGE_IDLE_MS(600s) > WALL_RECENT_MS(120s) ゆえ recency 免除は
    // 冗長だが、purge 窓を maxIdleMs < WALL_RECENT_MS へ狭めた瞬間に「表示中の external item を purge して
    // flicker」バグを防ぐため load-bearing になる(窓順序前提が変わると顕在化)。
    if (s.connected === true || s.liveness_state === "live" || isPresentOrRecentlyActive(s, now)) {
      items.set(id, s); // 接続在席 or live or external-recent は消さない。
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
  /**
   * 表示包含窓 (recency proxy) の判定基準時刻 (epoch ms)。ADR 019f474e:
   * external adapter の直近 active 判定に使う。既定 Date.now()。呼び元 (use-realtime) は
   * 既存 1s tick 相当の now を渡し毎秒再評価する (WALL_RECENT_MS 経過で自動的に history 側へ)。
   */
  readonly nowMs?: number;
}

/**
 * 表示用に決定論ソートした配列を返す (display 層が描くだけにする)。
 * 既定は connected=true か external-recent(ADR 019f474e recency proxy・共有正準述語)。
 * showHistory=true で全件。
 * 優先順位: needs_attention(true 上) → last_event_at(新しい上, 欠損は最下) → session_id(安定).
 */
export function toDisplayList(
  state: ListState,
  opts: DisplayOptions = {},
): readonly SessionListItem[] {
  const showHistory = opts.showHistory ?? false;
  const nowMs = opts.nowMs ?? Date.now();
  // 既定: 接続在席、または external adapter の直近 active(presence を構造的に持てない external を
  // recency 代理で包含)。managed/attach/codex_rollout の !connected は従来通り除外。
  // showHistory=true なら全件(この分岐は不変)。
  const arr = [...state.items.values()].filter(
    (s) => showHistory || isPresentOrRecentlyActive(s, nowMs),
  );
  arr.sort((a, b) => {
    if (a.needs_attention !== b.needs_attention) return a.needs_attention ? -1 : 1;
    const ta = a.last_event_at ? Date.parse(a.last_event_at) : Number.NEGATIVE_INFINITY;
    const tb = b.last_event_at ? Date.parse(b.last_event_at) : Number.NEGATIVE_INFINITY;
    if (ta !== tb) return tb - ta;
    return a.session_id < b.session_id ? -1 : a.session_id > b.session_id ? 1 : 0;
  });
  return arr;
}

/**
 * headline KPI の presence 母集合カウント (Live / Running) を **単一述語**で導出する。
 *
 * plan.md 最重要 KPI「観測された実際の作業状態のみを表示」。Live(接続在席) と Running は同じ presence
 * 述語 `connected !== false` の上に載せ、`toDisplayList` の表示集合(showHistory トグルで全件へ膨らむ)から
 * 切り離す。これにより両者は **トグル非依存の独立不変**になり、`running` は常に `live` の部分集合になる。
 *
 * - `connected === false`(履歴・非在席) は Live/Running 双方から除外する。終端イベント未達で
 *   `running.model_streaming`/`running.model_wait` 等に **固着した過去 session**(ADR 019ea2bf 実測:
 *   27/29 が 24h 無活動なのに running 固着) を「現在稼働(Running)」に数えない — これが本ヘルパの核心。
 *   **external adapter(gemini/opencode 等・source:"external")も `connected:false`** ゆえ Live/Running
 *   双方から外れる。recency proxy `isPresentOrRecentlyActive` で Wall/既定リストには *稼働中* 表示され
 *   得るが headline Running には数えない(QA-2)。過大計上の逆=過少方向・軽微で、Live も同様に external を
 *   数えない(ADR 019f474e)ため `running ⊆ live` として整合。意図は下の unit case で pin する。
 * - `connected === undefined` は在席寄りに扱う(LIVE-FOUND-3 寛容性: 証拠なしに消さない・connectedCount と同値)。
 *   edge(accepted): 非 external で `connected===undefined` の session は Live/Running に数えるが、表示リスト
 *   (isPresentOrRecentlyActive) には出ず liveness バッジは "offline"。commit 前から Live 側に在る既存寛容仕様
 *   を Running へ拡張しただけ(新規 leak/欠陥でない・T1 型 realtime-hub.ts は connected:boolean で undefined 非想定)。
 *
 * 純関数(listState.items を単一走査)。この presence 述語 `connected !== false` は **Live と Running が同一
 * 母集合を共有する**ことだけを一箇所に固定する(security-gate-reuse-canonical-parser の spirit・危険でない)。
 * `connected` の扱いは目的別に **意図的に 4 系統併存**する — 表示集合 `isPresentOrRecentlyActive`(非 external は
 * `connected===true` 必須)/ liveness ラベル `!connected`(undefined=非在席)/ purge `connected===true` とは別物で、
 * 本ヘルパを global 単一出所と誤読しないこと(各々目的が異なる)。以前 use-realtime 内 inline だった connectedCount と
 * CockpitBoard 内 inline だった runningCount(表示集合ベース=バグ)を、この 1 述語へ集約したのが本ヘルパ。
 */
export function presenceCounts(items: Iterable<SessionListItem>): {
  readonly live: number;
  readonly running: number;
} {
  let live = 0;
  let running = 0;
  for (const s of items) {
    if (s.connected === false) continue; // 履歴(非在席)は Live/Running 双方から除外
    live++;
    if (s.state?.startsWith("running.")) running++;
  }
  return { live, running };
}
