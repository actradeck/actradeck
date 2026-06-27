/**
 * Live Wall の表示用 **純関数** (ADR 019ead7a D2・状態と表示の分離)。
 *
 * 観測イベント (ReplayEventDTO の timestamp/elapsed_ms/kind) のみから、共通時間軸の窓・
 * ウォーターフォール bar の duration・描画位置を **決定論**で導出する (INV-WALL-WINDOW-DETERMINISM /
 * BAR-DURATION / OBSERVED-ONLY)。CoT/推測の状態は出さず、duration を捏造しない。
 *
 * SEC: ReplayEventDTO は backend が allow-list 投影した redaction 済み DTO。ここは値の見せ方へ
 * 落とすだけで、生 payload を独自取得しない (security.md)。
 */
import { t, type Locale } from "./i18n/messages";

import type { LivenessState, ReplayEventDTO, ReplayEventKind } from "../realtime/contract";

/** ライブ追従窓の既定幅 (2 分) と選択肢 (30s / 2m / 10m)。 */
export const DEFAULT_WALL_WINDOW_MS = 120_000;
export const WALL_WINDOW_PRESETS: readonly number[] = [30_000, 120_000, 600_000];

function clamp(n: number, lo: number, hi: number): number {
  return n < lo ? lo : n > hi ? hi : n;
}

/**
 * 窓 [nowMs - windowMs, nowMs] 内の events のみ返す (決定論・ASC 保持)。
 * timestamp が解析不能な event は除外 (架空の位置に置かない)。INV-WALL-WINDOW-DETERMINISM。
 */
export function windowEvents(
  events: readonly ReplayEventDTO[],
  nowMs: number,
  windowMs: number = DEFAULT_WALL_WINDOW_MS,
): ReplayEventDTO[] {
  const startMs = nowMs - windowMs;
  return events.filter((e) => {
    const t = Date.parse(e.timestamp);
    return !Number.isNaN(t) && t >= startMs && t <= nowMs;
  });
}

export type BarMode = "elapsed" | "paired" | "ongoing" | "point";

export interface Bar {
  readonly event_id: string;
  readonly kind: ReplayEventKind;
  readonly startMs: number;
  readonly endMs: number;
  readonly mode: BarMode;
  readonly label: string;
}

/**
 * 1 event の bar を **決定論**で構築する (INV-WALL-BAR-DURATION)。フォールバック順 (固定):
 *  (1) `elapsed_ms` 在 → start + elapsed_ms（"elapsed"）
 *  (2) `completionMs` 在 → max(completionMs, start)（"paired" = start↔completion timestamp 差）
 *  (3) `ongoing`（完了未到来の進行中）→ max(nowMs, start)（"ongoing" = 伸びるバー）
 *  (4) いずれも無 → start（"point" = 点/最小幅。duration を捏造しない）
 * timestamp 解析不能なら null（bar を作らない・観測時刻なきものは描かない）。
 */
export function barOf(
  event: ReplayEventDTO,
  completionMs: number | undefined,
  ongoing: boolean,
  nowMs: number,
): Bar | null {
  const startMs = Date.parse(event.timestamp);
  if (Number.isNaN(startMs)) return null;
  let endMs: number;
  let mode: BarMode;
  if (typeof event.elapsed_ms === "number" && event.elapsed_ms >= 0) {
    endMs = startMs + event.elapsed_ms;
    mode = "elapsed";
  } else if (completionMs !== undefined) {
    endMs = Math.max(completionMs, startMs);
    mode = "paired";
  } else if (ongoing) {
    endMs = Math.max(nowMs, startMs);
    mode = "ongoing";
  } else {
    endMs = startMs;
    mode = "point";
  }
  return {
    event_id: event.event_id,
    kind: event.kind,
    startMs,
    endMs,
    mode,
    label: event.display_text,
  };
}

const START_SUFFIXES = [".started", ".requested", ".opened"] as const;
const COMPLETION_SUFFIXES = [
  ".completed",
  ".failed",
  ".finished",
  ".exited",
  ".ended",
  ".resolved",
] as const;

function suffixPrefix(eventType: string, suffixes: readonly string[]): string | null {
  for (const s of suffixes) {
    if (eventType.endsWith(s)) return eventType.slice(0, eventType.length - s.length);
  }
  return null;
}

/**
 * start event の index → 対応する completion event の index を返す Map を構築する。
 * 対応付けは 2 パス (ADR 019ead7a D2「request 相関」)。**同一 session で並行する tool** でも
 * 正しい start↔completion を結ぶため、prefix の先頭一致だけに頼らず request_id を優先する:
 *  - Pass1 (request 相関): start.request_id === completion.request_id かつ同 prefix の後続 completion を
 *    優先対応。reqId を持つペアを先に確定・消費する。
 *  - Pass2 (隣接 FIFO fallback): 相関できなかった start を、残った同 prefix completion へ前方 FIFO で対応。
 * `consumed` で completion を二重対応しない (Pass1 で確定したペアを Pass2 が横取りしない)。
 * elapsed_ms を持つ start は対応付け対象外 (barOf が elapsed を優先するため)。
 * 計算量は per_session 上限 N (≤ MAX_WALL_PER_SESSION=200) に有界な O(N^2) で、実用上無視できる。
 */
function matchCompletions(events: readonly ReplayEventDTO[]): Map<number, number> {
  const result = new Map<number, number>();
  const consumed = new Set<number>();
  const starts: Array<{ idx: number; sp: string }> = [];
  for (let i = 0; i < events.length; i++) {
    const e = events[i]!;
    const hasElapsed = typeof e.elapsed_ms === "number" && e.elapsed_ms >= 0;
    if (hasElapsed) continue;
    const sp = suffixPrefix(e.event_type, START_SUFFIXES);
    if (sp !== null) starts.push({ idx: i, sp });
  }
  // Pass1: request_id 相関 (並行 tool を正しく分離)。
  for (const { idx, sp } of starts) {
    const reqId = events[idx]!.request_id;
    if (reqId === undefined) continue;
    for (let j = idx + 1; j < events.length; j++) {
      if (consumed.has(j)) continue;
      const c = events[j]!;
      if (c.request_id === reqId && suffixPrefix(c.event_type, COMPLETION_SUFFIXES) === sp) {
        result.set(idx, j);
        consumed.add(j);
        break;
      }
    }
  }
  // Pass2: 残った start を同 prefix completion へ FIFO 隣接対応。
  for (const { idx, sp } of starts) {
    if (result.has(idx)) continue;
    for (let j = idx + 1; j < events.length; j++) {
      if (consumed.has(j)) continue;
      if (suffixPrefix(events[j]!.event_type, COMPLETION_SUFFIXES) === sp) {
        result.set(idx, j);
        consumed.add(j);
        break;
      }
    }
  }
  return result;
}

/**
 * 1 レーン (1 session) の events から bar 列を決定論で構築する。
 * - `*.started`/`*.requested`/`*.opened` を、同 prefix の後続 `*.completed`/`*.failed`/… と対応付け
 *   (paired)。対応は request_id 優先・二重対応なし (matchCompletions)。
 * - 完了未到来かつレーン最新 event の start のみ ongoing (伸びるバー)。古い未対応 start は point に
 *   倒す (進行中扱いで全て nowMs まで伸ばさない = 誤った生存表現を避ける)。
 * - elapsed_ms を持つ event は対応付けより優先 (barOf の順序)。
 * events は ASC 前提 (REPLAY_ORDER)。
 */
export function computeLaneBars(events: readonly ReplayEventDTO[], nowMs: number): Bar[] {
  const bars: Bar[] = [];
  const lastIndex = events.length - 1;
  const completionFor = matchCompletions(events);
  for (let i = 0; i < events.length; i++) {
    const e = events[i]!;
    let completionMs: number | undefined;
    let ongoing = false;
    const hasElapsed = typeof e.elapsed_ms === "number" && e.elapsed_ms >= 0;
    if (!hasElapsed) {
      const sp = suffixPrefix(e.event_type, START_SUFFIXES);
      if (sp !== null) {
        const matchIdx = completionFor.get(i);
        if (matchIdx !== undefined) {
          const c = Date.parse(events[matchIdx]!.timestamp);
          // TDA-8: matched completion の timestamp が NaN なら completionMs 未設定のまま
          //   (paired→point/ongoing へ fail-safe 降格)。duration を捏造しない (backend は timestamp
          //   正規化済ゆえ通常到達しないが、観測時刻なき値で誤った幅を描かない)。
          if (!Number.isNaN(c)) completionMs = c;
        } else if (i === lastIndex) {
          ongoing = true;
        }
      }
    }
    const bar = barOf(e, completionMs, ongoing, nowMs);
    if (bar) bars.push(bar);
  }
  return bars;
}

export interface BarGeometry {
  readonly leftPct: number;
  readonly widthPct: number;
}

/**
 * bar を窓 [windowStartMs, windowStartMs+windowMs] 上の left/width(%) に決定論で写す。
 * 窓外は clamp し、負値・100 超を出さない (描画の安定)。点 bar は width 0 (CSS min-width で可視)。
 */
export function barGeometry(bar: Bar, windowStartMs: number, windowMs: number): BarGeometry {
  if (windowMs <= 0) return { leftPct: 0, widthPct: 0 };
  // QA-3 (defense-in-depth): barOf が NaN start を null にするため通常到達しないが、NaN 座標が
  //   来ても clamp は素通しする (NaN<lo/NaN>hi が共に false)。明示的に {0,0} へ倒し left:NaN% を防ぐ。
  if (Number.isNaN(bar.startMs) || Number.isNaN(bar.endMs)) return { leftPct: 0, widthPct: 0 };
  const windowEndMs = windowStartMs + windowMs;
  const start = clamp(bar.startMs, windowStartMs, windowEndMs);
  const end = clamp(bar.endMs, windowStartMs, windowEndMs);
  const leftPct = clamp(((start - windowStartMs) / windowMs) * 100, 0, 100);
  const widthPct = clamp(((end - start) / windowMs) * 100, 0, 100);
  return { leftPct, widthPct };
}

// ── 段階2 (ADR 019ead7a D2 motion/gap・INV-WALL-MOTION-LIVENESS-MAP / STALLED-STATIC /
//    REDUCED-MOTION-ALT) ─────────────────────────────────────────────────────────
export type BarMotion = "pulse" | "static";

/**
 * bar の motion を **liveness の決定論関数**として写す (INV-WALL-MOTION-LIVENESS-MAP /
 * INV-WALL-STALLED-STATIC)。脈動 (alive 表現) を許すのは:
 *   mode==="ongoing" (完了未到来=進行中) ∧ liveness_state==="live" ∧ stalled_suspected でない
 * これ以外 — stalled/idle/unknown・stalled_suspected・完了済み (paired/elapsed/point) — は **静止**。
 * 停止疑いのレーンに「動いている」motion を絶対に付けない (INV-STALLED 整合: 断定もしないが
 * alive も偽装しない)。mutation: stalled で "pulse" を返すと INV が赤になる。
 */
export function barMotion(
  mode: BarMode,
  livenessState: LivenessState,
  stalledSuspected: boolean,
): BarMotion {
  if (mode !== "ongoing") return "static";
  if (stalledSuspected) return "static";
  return livenessState === "live" ? "pulse" : "static";
}

/**
 * レーン内で **脈動する (live-ongoing) バー**の最大経過 ms を返す (無ければ null)。
 * `prefers-reduced-motion` 時に脈動アニメの代わりに見せる**静的経過カウンタ**の値源
 * (INV-WALL-REDUCED-MOTION-ALT)。stalled/idle は barMotion が "static" を返すため null =
 * 「実行中」カウンタを出さない (alive 断定回避・INV-WALL-STALLED-STATIC)。
 */
export function laneLiveElapsedMs(
  bars: readonly Bar[],
  livenessState: LivenessState,
  stalledSuspected: boolean,
): number | null {
  let max: number | null = null;
  for (const b of bars) {
    if (barMotion(b.mode, livenessState, stalledSuspected) === "pulse") {
      const el = Math.max(0, b.endMs - b.startMs);
      if (max === null || el > max) max = el;
    }
  }
  return max;
}

/** 経過 ms を短いラベルへ (決定論)。秒未満は切り捨て。ja: "45秒"/"1分23秒"・en: "45s"/"1m 23s"。既定 ja。 */
export function formatElapsed(ms: number, locale: Locale = "ja"): string {
  const totalSec = Math.floor(Math.max(0, ms) / 1000);
  if (totalSec < 60) return t(locale, "time.elapsed.seconds", { seconds: totalSec });
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return t(locale, "time.elapsed.minutes", { minutes: m, seconds: s });
}

// ── 使い勝手改善 (要対応可視化 / 時間軸ルーラー / レーン密度) の純関数 ─────────────────

export interface RulerTick {
  readonly leftPct: number;
  readonly label: string;
}

/**
 * 共通時間軸のルーラー目盛りを決定論で導出する (INV-WALL-RULER-DETERMINISM)。
 * 窓 [now - windowMs, now] を divisions 等分し、左端=「windowMs 前」… 右端=「now」。
 * ラベルは formatElapsed ベースの「N分N秒前」。非正の入力は空 (架空の目盛りを描かない)。
 */
export function rulerTicks(windowMs: number, divisions = 4, locale: Locale = "ja"): RulerTick[] {
  if (windowMs <= 0 || divisions <= 0) return [];
  const out: RulerTick[] = [];
  for (let i = 0; i <= divisions; i++) {
    const leftPct = (i / divisions) * 100;
    const agoMs = windowMs - (windowMs * i) / divisions;
    const label =
      agoMs === 0
        ? t(locale, "time.now")
        : t(locale, "time.ago", { elapsed: formatElapsed(agoMs, locale) });
    out.push({ leftPct, label });
  }
  return out;
}

/** 窓幅ごとの分割数 (ラベルが切りの良い値になるよう選ぶ)。30s=3 (10s刻み)、他=4。 */
export function rulerDivisionsFor(windowMs: number): number {
  return windowMs === 30_000 ? 3 : 4;
}

/**
 * レーンの既定折りたたみ判定 (決定論・純関数)。**介入関連を絶対に隠さない**:
 * 畳むのは idle / unknown かつ needs_attention でも stalled_suspected でもないレーンのみ。
 * live (作業中) と stalled (停止疑い・要監視) は常に展開既定。ユーザートグルが常に優先 (呼び出し側)。
 */
export function laneCollapsedDefault(s: {
  readonly liveness_state: LivenessState;
  readonly needs_attention: boolean;
  readonly stalled_suspected: boolean;
}): boolean {
  return (
    (s.liveness_state === "idle" || s.liveness_state === "unknown") &&
    !s.needs_attention &&
    !s.stalled_suspected
  );
}

/**
 * 要対応 (needs_attention) レーンの session_id を表示順のまま返す (決定論)。
 * ヘッダの「要対応 N」カウンタと巡回ジャンプの値源。並び順は変えない (DnD のユーザー並びを尊重)。
 */
export function attentionLaneIds<
  T extends { session: { session_id: string; needs_attention: boolean } },
>(lanes: readonly T[]): string[] {
  return lanes.filter((l) => l.session.needs_attention).map((l) => l.session.session_id);
}

/**
 * cwd を短い表示ラベルへ畳む (決定論)。各レーンが「どのディレクトリで動いているか」を一目で示すため、
 * ホーム配下 `/home/<user>/` ・`/Users/<user>/` ・`/root/` を `~/` に置換する (full path は title 属性で出す)。
 * cwd 無しは null (表示しない)。SessionListItem.cwd は backend allow-list 済 (新 redaction 面なし)。
 */
export function shortenCwd(cwd: string | undefined): string | null {
  if (!cwd) return null;
  return cwd.replace(/^\/(?:home|Users)\/[^/]+(\/|$)/, "~$1").replace(/^\/root(\/|$)/, "~$1");
}

/** session_id 表示短縮の標準桁数 (一覧/Inbox/Wall/通知で共通)。 */
export const SHORT_SESSION_ID_LEN = 12;

/**
 * session_id を一覧行ラベル等の短縮表示へ畳む (決定論・単一出所)。`slice(0, 12)` の散在を集約する
 * (TDA-1)。session_id は機微でない識別子 (command/secret ではない) なので表示・通知本文に載せてよい。
 */
export function shortSessionId(id: string): string {
  return id.slice(0, SHORT_SESSION_ID_LEN);
}

/**
 * 永続化したユーザー並び順を、現存セッションへ突き合わせて正規化する (決定論・純関数)。
 *
 * Wall は pull で定期再取得され lane 集合が変動する。ユーザーが DnD で決めた順序を、
 *  - 既知 (保存順にある) かつ現存する id は **保存順のまま先頭側に保つ**、
 *  - 保存順に無い新規セッションは **現在の取得順で末尾に付す**、
 *  - 消えたセッションは落とす、
 * という規則で安定させる。これで再取得や新規参入でユーザー並びが崩れない。
 */
export function reconcileLaneOrder(
  savedOrder: readonly string[],
  presentIds: readonly string[],
): string[] {
  const present = new Set(presentIds);
  const kept = savedOrder.filter((id) => present.has(id));
  const keptSet = new Set(kept);
  const appended = presentIds.filter((id) => !keptSet.has(id));
  return [...kept, ...appended];
}

/**
 * order(session_id 列) に従って lanes を安定ソートする (order に無い lane は末尾・元順保持)。
 */
export function applyLaneOrder<T extends { session: { session_id: string } }>(
  lanes: readonly T[],
  order: readonly string[],
): T[] {
  const idx = new Map(order.map((id, i) => [id, i] as const));
  return lanes
    .map((lane, i) => ({ lane, i }))
    .sort((a, b) => {
      const ai = idx.get(a.lane.session.session_id) ?? Number.MAX_SAFE_INTEGER;
      const bi = idx.get(b.lane.session.session_id) ?? Number.MAX_SAFE_INTEGER;
      return ai - bi || a.i - b.i; // 同順位は元の取得順で安定。
    })
    .map((x) => x.lane);
}

export type DropPlace = "before" | "after";

/**
 * DnD: fromId を toId の **前 / 後** へ移動した新しい順序を返す。
 *
 * `place` はドロップ時のカーソル位置 (対象レーンの上半分=before / 下半分=after) で決まる。
 * これにより「上のレーンを下へ」「下のレーンを上へ」の両方向が必ず移動する
 * (旧 moveInOrder の "常に前へ挿入" は隣接同方向で no-op になり「動かない」と感じる原因だった)。
 * 同一・不在は元配列のコピーを返す (no-op)。
 */
export function moveRelative(
  order: readonly string[],
  fromId: string,
  toId: string,
  place: DropPlace,
): string[] {
  if (fromId === toId) return [...order];
  const arr = [...order];
  const from = arr.indexOf(fromId);
  if (from < 0 || arr.indexOf(toId) < 0) return arr;
  arr.splice(from, 1);
  const at = arr.indexOf(toId);
  arr.splice(place === "after" ? at + 1 : at, 0, fromId);
  return arr;
}

/**
 * ライブ追従 DnD のプレビュー順を **決定論**で導く純関数 (INV-WALL-LANE-POINTER-REORDER)。
 *
 * ドラッグ中の `draggingId` を、各レーンの中心 Y (`centers`, 表示 `order` と同並び) と現在の
 * ポインタ Y から挿入位置を決め直して並べ替えた順序を返す。挿入 index =「ドラッグ中レーン以外で
 * 中心 Y がポインタより上にあるレーン数」。これで指で他レーンの中心をまたぐと相手が反対側へ
 * ずれる「ライブプレビュー」が安定して決まる (現順序を入力にした不動点でちらつかない)。
 * `draggingId` 不在・order 長と centers 長の不一致時は元配列のコピーを返す (no-op)。
 */
export function reorderByPointerY(
  order: readonly string[],
  draggingId: string,
  centers: readonly number[],
  pointerY: number,
): string[] {
  if (order.indexOf(draggingId) < 0 || centers.length !== order.length) return [...order];
  const without = order.filter((id) => id !== draggingId);
  let idx = 0;
  for (let i = 0; i < order.length; i++) {
    if (order[i] === draggingId) continue;
    const c = centers[i];
    if (c !== undefined && !Number.isNaN(c) && c < pointerY) idx++;
  }
  without.splice(idx, 0, draggingId);
  return without;
}

/**
 * キーボード代替: id を delta(±n) だけ移動した新しい順序を返す (端でクランプ)。不在は no-op。
 */
export function moveByOffset(order: readonly string[], id: string, delta: number): string[] {
  const arr = [...order];
  const i = arr.indexOf(id);
  if (i < 0) return arr;
  const j = Math.max(0, Math.min(arr.length - 1, i + delta));
  if (i === j) return arr;
  arr.splice(i, 1);
  arr.splice(j, 0, id);
  return arr;
}
