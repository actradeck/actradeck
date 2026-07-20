/**
 * presence — LiveWall / Board 既定一覧の「表示包含」正準述語 (T1・単一出所).
 *
 * 背景 (ADR 019f474e): LiveWall(`realtime-server.ts` の wall route)と Board 既定一覧
 * (`list-reducer.ts` の toDisplayList)は **presence(接続在席=connected=SidecarRegistry.isLive)**
 * のみで表示可否を決める(ADR 019ea2bf 二層モデルの membership 軸)。
 *
 * ところが外部 adapter(gemini / opencode、`source==="external"`)は HTTP `POST /ingest` で
 * イベントを送るだけで sidecar egress WS(`/ingest/ws`)を張らないため **claim されず
 * `connected=false`** となり、connected のみでフィルタする LiveWall / 既定一覧から**構造的に除外**
 * される(履歴・監査・replay には出る)。external adapter は presence チャネルを構造的に持てない。
 *
 * 対応: external に限り **recency(last_event_at の鮮度)を presence の代理**として扱い、
 * WALL_RECENT_MS 窓内に直近イベントがあれば「直近 active」として表示に含める。
 * managed / attach / codex_rollout は presence を持てる経路ゆえ `connected` 据え置き
 * (disconnect→offline を壊さない・ADR 019efa02 と矛盾させない)。
 *
 * terminal 除外 (ADR 019f4c19 wall-ended-badge): recency proxy の存在意義は「WS を持てないが **まだ活動中**
 * の external を出す」ことに尽きる。session.ended を発火し正規化状態が terminal(completed/failed/
 * interrupted/suspended・`TERMINAL_STATES` 正典。suspended=provider unload・ADR 0014)へ落ちた external は
 * **もう活動中でない** ゆえ、last_event_at が
 * WALL_RECENT_MS 窓内でも「直近 active」に該当させない(LiveWall=動いているものの壁から落とす)。
 * これがないと「終了直後の external」が緑の ✓LIVE で残り、plan.md 最重要 KPI(表示は観測された実際の
 * 作業状態=completed は live な作業状態でない)に反する。connected=true(managed/attach)は本除外の
 * 手前で短絡するため影響なし(本修正は external-recent 経路のみに効く)。session 一覧/replay には残る。
 *
 * この述語は backend(wall)と webui(toDisplayList / purgeStale / wallRefreshKey / liveness)が
 * **共有 import** し、境界跨ぎの分類ロジックの drift を構造排除する
 * (security-gate-reuse-canonical-parser / consolidation-invariant-sweep-all-copies)。
 * 純関数・決定的・fs/依存ゼロ。
 */
import { isTerminalStateValue } from "./state.js";

/**
 * LiveWall / Board 既定の**表示包含窓**。external adapter は presence(WS 接続)を構造的に
 * 持てないため、この鮮度窓内なら「直近 active」として presence の代理で表示する。
 *
 * ⚠️ liveness(liveness-display.ts `LIVE_FRESH_MS`=60s)の「LIVE とみなす鮮度窓」とは
 * **別概念**。こちらは「一覧に出すか(membership 包含窓)」を決める閾値であり、
 * バッジ(live/idle)の判定窓ではない。両者は直交する(二層モデルの freshness を
 * external の membership 軸へ適用する拡張)。
 */
export const WALL_RECENT_MS = 120_000;

/** isPresentOrRecentlyActive が判定に用いる最小フィールド(SessionListItem の部分集合)。 */
export interface PresenceRecencyInput {
  /** 接続在席(presence): 所有 sidecar の egress WS が開いているか。 */
  readonly connected: boolean;
  /** 取り込み経路 (HOW・closed enum)。external adapter は "external"。 */
  readonly source: string;
  /** 最終イベント時刻 (ISO8601)。未確定は undefined。 */
  readonly last_event_at: string | undefined;
  /**
   * 正規化状態 (`session_state.state`・State enum 値)。terminal(`TERMINAL_STATES`=completed/failed/
   * interrupted/suspended)なら external の recency proxy 対象外(終了済み/休止は「直近 active」でない)。
   * 未提供(undefined)は非 terminal 扱い(従来挙動を保つ・後方互換)。
   */
  readonly state?: string | undefined;
}

// terminal 判定は state.ts の正準 `isTerminalStateValue` (string 緩包含版・TERMINAL_STATES 帰着) を
// 共有する (旧: 本ファイルの private 実装。wall-ended-badge TDA-1 で昇格 export し、webui
// approval-display の手書き列挙コピーと単一出所化)。

/**
 * connected(接続在席)** または** external の直近 active(last_event_at が WALL_RECENT_MS 内)。
 *
 * 規則(優先順・決定的):
 *  1. `connected === true` → true(source 無関係。presence があれば無条件で表示)。
 *  2. `source !== "external"` → false(recency proxy は **external 限定**。
 *     managed/attach/codex_rollout の !connected は presence を持てる経路ゆえ offline 扱い)。
 *  2.5 external かつ `state` が terminal(completed/failed/interrupted/suspended) → false(session.ended を
 *     発火した終了済み/休止 external は「直近 active」でない・LiveWall から落とす・ADR 019f4c19 wall-ended-badge)。
 *  3. external で last_event_at が有効な ISO 文字列かつ age(=nowMs - Date.parse(last_event_at))が
 *     **両側有界** `0 <= age <= WALL_RECENT_MS` → true(境界 age==0 / age==WALL_RECENT_MS は含む)。
 *     それ以外 → false。下限 age>=0 は未来日時(age<0)が WALL_RECENT_MS 窓を超えて居座るのを防ぐ
 *     クランプ。adapter と backend は same-machine / loopback / single-operator 信頼境界=クロック
 *     共有ゆえ正当 event は常に age>=0 で clock-skew 許容は不要(未来日時は異常入力として除外)。
 *
 * 純関数・同入力同出力。nowMs は呼び元が注入(テスト決定性)。
 */
export function isPresentOrRecentlyActive(s: PresenceRecencyInput, nowMs: number): boolean {
  if (s.connected === true) return true;
  if (s.source !== "external") return false;
  // terminal な external(session.ended→completed 等)は活動中でない → recency proxy 対象外。
  if (isTerminalStateValue(s.state)) return false;
  if (typeof s.last_event_at !== "string") return false;
  const t = Date.parse(s.last_event_at);
  const age = nowMs - t;
  return Number.isFinite(t) && age >= 0 && age <= WALL_RECENT_MS;
}
