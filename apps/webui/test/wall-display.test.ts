/**
 * Live Wall 表示派生 (純関数) の不変条件 — ADR 019ead7a 段階1。
 *
 *  - INV-WALL-WINDOW-DETERMINISM: windowEvents は同入力同出力。窓 [now-window, now] 外を除外し
 *    境界は決定的。timestamp 解析不能は除外 (架空位置に置かない)。
 *  - INV-WALL-BAR-DURATION: barOf のフォールバックは elapsed→paired→ongoing→point の固定順。
 *    duration を捏造しない。computeLaneBars は started↔completed を対応付け、最新の未完了 start のみ
 *    ongoing、古い未対応 start は point。
 *  - INV-WALL-OBSERVED-ONLY: 観測 (ReplayEventDTO) 由来のみ。空入力は空 bar (捏造 bar なし)。
 */
import { describe, expect, it } from "vitest";

import {
  applyLaneOrder,
  attentionLaneIds,
  barGeometry,
  barMotion,
  barOf,
  computeLaneBars,
  formatElapsed,
  laneCollapsedDefault,
  laneLiveElapsedMs,
  moveByOffset,
  moveRelative,
  reconcileLaneOrder,
  reorderByPointerY,
  rulerDivisionsFor,
  rulerTicks,
  shortenCwd,
  shortSessionId,
  SHORT_SESSION_ID_LEN,
  windowEvents,
} from "../src/ui/wall-display.js";

import type { Bar } from "../src/ui/wall-display.js";
import type { ReplayEventDTO } from "../src/realtime/contract.js";

function ev(o: Partial<ReplayEventDTO> = {}): ReplayEventDTO {
  return {
    event_id: "e1",
    provider: "claude_code",
    source: "hooks",
    session_id: "s1",
    event_type: "command.started",
    kind: "command",
    timestamp: "2026-06-05T00:00:00.000Z",
    state: undefined,
    cwd: undefined,
    summary: undefined,
    display_text: "x",
    subject: undefined,
    request_id: undefined,
    tool_name: undefined,
    command: undefined,
    path: undefined,
    risk_level: undefined,
    decision: undefined,
    auto_allowed: undefined,
    exit_code: undefined,
    elapsed_ms: undefined,
    ...o,
  };
}

const T0 = Date.parse("2026-06-05T00:00:00.000Z");

describe("windowEvents (INV-WALL-WINDOW-DETERMINISM)", () => {
  const events = [
    ev({ event_id: "old", timestamp: new Date(T0 - 200_000).toISOString() }),
    ev({ event_id: "edge-start", timestamp: new Date(T0 - 120_000).toISOString() }),
    ev({ event_id: "mid", timestamp: new Date(T0 - 60_000).toISOString() }),
    ev({ event_id: "now", timestamp: new Date(T0).toISOString() }),
    ev({ event_id: "future", timestamp: new Date(T0 + 10_000).toISOString() }),
    ev({ event_id: "nan", timestamp: "not-a-date" }),
  ];

  it("窓 [now-window, now] 内のみ・境界含む・NaN/未来は除外", () => {
    const out = windowEvents(events, T0, 120_000).map((e) => e.event_id);
    expect(out).toEqual(["edge-start", "mid", "now"]);
  });

  it("決定論: 同入力で同出力", () => {
    const a = windowEvents(events, T0, 120_000);
    const b = windowEvents(events, T0, 120_000);
    expect(a.map((e) => e.event_id)).toEqual(b.map((e) => e.event_id));
  });

  it("空入力は空 (捏造しない)", () => {
    expect(windowEvents([], T0, 120_000)).toEqual([]);
  });
});

describe("barOf (INV-WALL-BAR-DURATION: フォールバック順固定)", () => {
  it("(1) elapsed_ms 在 → elapsed (completion があっても優先)", () => {
    const bar = barOf(ev({ elapsed_ms: 5_000 }), T0 + 9_999, true, T0 + 50_000);
    expect(bar?.mode).toBe("elapsed");
    expect(bar?.endMs).toBe(T0 + 5_000);
  });

  it("(2) elapsed 無・completionMs 在 → paired (max(completion,start))", () => {
    const bar = barOf(ev(), T0 + 3_000, true, T0 + 50_000);
    expect(bar?.mode).toBe("paired");
    expect(bar?.endMs).toBe(T0 + 3_000);
  });

  it("(3) elapsed/completion 無・ongoing → ongoing (max(now,start) 伸びるバー)", () => {
    const bar = barOf(ev(), undefined, true, T0 + 40_000);
    expect(bar?.mode).toBe("ongoing");
    expect(bar?.endMs).toBe(T0 + 40_000);
  });

  it("(4) いずれも無 → point (endMs=start・duration を捏造しない)", () => {
    const bar = barOf(ev(), undefined, false, T0 + 40_000);
    expect(bar?.mode).toBe("point");
    expect(bar?.endMs).toBe(T0);
  });

  it("timestamp 解析不能 → null (観測時刻なきものは描かない)", () => {
    expect(barOf(ev({ timestamp: "nope" }), undefined, true, T0)).toBeNull();
  });

  it("completion が start より前でも endMs は start 以上にクランプ", () => {
    const bar = barOf(ev(), T0 - 5_000, false, T0);
    expect(bar?.endMs).toBe(T0);
  });
});

describe("computeLaneBars (started↔completed 対応付け・ongoing は最新のみ)", () => {
  it("started→completed を paired にする", () => {
    const bars = computeLaneBars(
      [
        ev({ event_id: "a", event_type: "command.started", timestamp: new Date(T0).toISOString() }),
        ev({
          event_id: "b",
          event_type: "command.completed",
          kind: "command",
          timestamp: new Date(T0 + 2_000).toISOString(),
        }),
      ],
      T0 + 99_000,
    );
    const a = bars.find((x) => x.event_id === "a")!;
    expect(a.mode).toBe("paired");
    expect(a.endMs).toBe(T0 + 2_000);
  });

  it("最新の未完了 start は ongoing、古い未対応 start は point", () => {
    const bars = computeLaneBars(
      [
        ev({
          event_id: "old",
          event_type: "command.started",
          timestamp: new Date(T0).toISOString(),
        }),
        ev({
          event_id: "live",
          event_type: "command.started",
          timestamp: new Date(T0 + 1_000).toISOString(),
        }),
      ],
      T0 + 50_000,
    );
    expect(bars.find((x) => x.event_id === "old")!.mode).toBe("point");
    expect(bars.find((x) => x.event_id === "live")!.mode).toBe("ongoing");
  });

  it("並行 tool は request_id で相関し completion を二重対応しない (TDA-1)", () => {
    // 同一 session で 2 つの command が並行し、**後発の B が先に完了**する (ASC: b-done@+2s,
    // a-done@+5s)。隣接 FIFO だけだと a-start が b-done(+2s) を掴む誤対応になるが、request_id
    // 相関で a-start→a-done(+5s) / b-start→b-done(+2s) に正しく分離する (これが TDA-1 の核心)。
    const bars = computeLaneBars(
      [
        ev({
          event_id: "a-start",
          event_type: "command.started",
          request_id: "req-A",
          timestamp: new Date(T0).toISOString(),
        }),
        ev({
          event_id: "b-start",
          event_type: "command.started",
          request_id: "req-B",
          timestamp: new Date(T0 + 1_000).toISOString(),
        }),
        ev({
          event_id: "b-done",
          event_type: "command.completed",
          kind: "command",
          request_id: "req-B",
          timestamp: new Date(T0 + 2_000).toISOString(),
        }),
        ev({
          event_id: "a-done",
          event_type: "command.completed",
          kind: "command",
          request_id: "req-A",
          timestamp: new Date(T0 + 5_000).toISOString(),
        }),
      ],
      T0 + 99_000,
    );
    const a = bars.find((x) => x.event_id === "a-start")!;
    const b = bars.find((x) => x.event_id === "b-start")!;
    expect(a.mode).toBe("paired");
    expect(a.endMs).toBe(T0 + 5_000);
    expect(b.mode).toBe("paired");
    expect(b.endMs).toBe(T0 + 2_000);
  });

  it("request_id 無しの並行 start は FIFO で別 completion に対応 (二重対応しない)", () => {
    // 相関キー無し → Pass2 FIFO。c1 を消費後 s2 は c2 へ。先頭一致のみ(消費なし)だと両者 c1。
    const bars = computeLaneBars(
      [
        ev({
          event_id: "s1",
          event_type: "command.started",
          timestamp: new Date(T0).toISOString(),
        }),
        ev({
          event_id: "s2",
          event_type: "command.started",
          timestamp: new Date(T0 + 1_000).toISOString(),
        }),
        ev({
          event_id: "c1",
          event_type: "command.completed",
          kind: "command",
          timestamp: new Date(T0 + 3_000).toISOString(),
        }),
        ev({
          event_id: "c2",
          event_type: "command.completed",
          kind: "command",
          timestamp: new Date(T0 + 4_000).toISOString(),
        }),
      ],
      T0 + 99_000,
    );
    expect(bars.find((x) => x.event_id === "s1")!.endMs).toBe(T0 + 3_000);
    expect(bars.find((x) => x.event_id === "s2")!.endMs).toBe(T0 + 4_000);
  });

  it("started に elapsed_ms 在 → 後続 completed があっても elapsed 優先 (QA-2)", () => {
    const bars = computeLaneBars(
      [
        ev({
          event_id: "a",
          event_type: "command.started",
          elapsed_ms: 1_500,
          timestamp: new Date(T0).toISOString(),
        }),
        ev({
          event_id: "b",
          event_type: "command.completed",
          kind: "command",
          timestamp: new Date(T0 + 9_000).toISOString(),
        }),
      ],
      T0 + 99_000,
    );
    const a = bars.find((x) => x.event_id === "a")!;
    expect(a.mode).toBe("elapsed");
    expect(a.endMs).toBe(T0 + 1_500);
  });

  it("Pass1 で確定した completion を Pass2 が横取りしない (TDA-7 consumed-integrity)", () => {
    // s-req(req=R) は Pass1 で c-req(req=R) に相関・消費。早い index の s-noreq は Pass2 でそれを
    // 奪えず point に倒れる。consumed.add を外すと s-noreq が paired(c-req) を横取りし赤になる。
    const bars = computeLaneBars(
      [
        ev({
          event_id: "s-noreq",
          event_type: "command.started",
          timestamp: new Date(T0).toISOString(),
        }),
        ev({
          event_id: "s-req",
          event_type: "command.started",
          request_id: "R",
          timestamp: new Date(T0 + 1_000).toISOString(),
        }),
        ev({
          event_id: "c-req",
          event_type: "command.completed",
          kind: "command",
          request_id: "R",
          timestamp: new Date(T0 + 2_000).toISOString(),
        }),
      ],
      T0 + 99_000,
    );
    const sReq = bars.find((x) => x.event_id === "s-req")!;
    expect(sReq.mode).toBe("paired");
    expect(sReq.endMs).toBe(T0 + 2_000);
    expect(bars.find((x) => x.event_id === "s-noreq")!.mode).toBe("point");
  });

  it("空入力は空 bar (INV-WALL-OBSERVED-ONLY)", () => {
    expect(computeLaneBars([], T0)).toEqual([]);
  });
});

describe("barGeometry (窓上の left/width% を clamp)", () => {
  const winStart = T0 - 120_000;
  it("窓内 bar の left/width を算出", () => {
    const geo = barGeometry(
      {
        event_id: "a",
        kind: "command",
        startMs: T0 - 60_000,
        endMs: T0 - 30_000,
        mode: "paired",
        label: "x",
      },
      winStart,
      120_000,
    );
    expect(geo.leftPct).toBeCloseTo(50, 5);
    expect(geo.widthPct).toBeCloseTo(25, 5);
  });

  it("窓外へはみ出す bar は 0..100 にクランプ", () => {
    const geo = barGeometry(
      {
        event_id: "a",
        kind: "command",
        startMs: winStart - 999_999,
        endMs: T0 + 999_999,
        mode: "ongoing",
        label: "x",
      },
      winStart,
      120_000,
    );
    expect(geo.leftPct).toBe(0);
    expect(geo.widthPct).toBe(100);
  });

  it("windowMs<=0 は {0,0} (ゼロ除算回避)", () => {
    const geo = barGeometry(
      { event_id: "a", kind: "command", startMs: T0, endMs: T0, mode: "point", label: "x" },
      winStart,
      0,
    );
    expect(geo).toEqual({ leftPct: 0, widthPct: 0 });
  });

  it("NaN 座標は {0,0} (QA-3 defense-in-depth・left:NaN% を出さない)", () => {
    expect(
      barGeometry(
        { event_id: "a", kind: "command", startMs: NaN, endMs: T0, mode: "ongoing", label: "x" },
        winStart,
        120_000,
      ),
    ).toEqual({ leftPct: 0, widthPct: 0 });
    expect(
      barGeometry(
        { event_id: "a", kind: "command", startMs: T0, endMs: NaN, mode: "ongoing", label: "x" },
        winStart,
        120_000,
      ),
    ).toEqual({ leftPct: 0, widthPct: 0 });
  });
});

// ── 段階2 (ADR 019ead7a D2 motion/gap) ────────────────────────────────────────
function bar(mode: Bar["mode"], startMs: number, endMs: number, event_id = "b"): Bar {
  return { event_id, kind: "command", startMs, endMs, mode, label: "x" };
}

describe("barMotion (INV-WALL-MOTION-LIVENESS-MAP / STALLED-STATIC)", () => {
  it("ongoing ∧ live ∧ 非 suspected のみ pulse", () => {
    expect(barMotion("ongoing", "live", false)).toBe("pulse");
  });

  it("stalled_suspected は ongoing/live でも静止 (alive 偽装しない)", () => {
    expect(barMotion("ongoing", "live", true)).toBe("static");
  });

  it("liveness が live 以外 (idle/stalled/unknown) は ongoing でも静止", () => {
    expect(barMotion("ongoing", "idle", false)).toBe("static");
    expect(barMotion("ongoing", "stalled", false)).toBe("static");
    expect(barMotion("ongoing", "unknown", false)).toBe("static");
  });

  it("完了済みバー (paired/elapsed/point) は live でも静止 (進行中のみ脈動)", () => {
    expect(barMotion("paired", "live", false)).toBe("static");
    expect(barMotion("elapsed", "live", false)).toBe("static");
    expect(barMotion("point", "live", false)).toBe("static");
  });
});

describe("laneLiveElapsedMs (reduced-motion 静的カウンタの値源)", () => {
  it("live-ongoing バーの最大経過 ms を返す", () => {
    const bars = [
      bar("ongoing", T0, T0 + 3_000, "o1"),
      bar("ongoing", T0, T0 + 8_000, "o2"),
      bar("paired", T0, T0 + 99_000, "p1"),
    ];
    expect(laneLiveElapsedMs(bars, "live", false)).toBe(8_000);
  });

  it("stalled/suspected は null (実行中カウンタを出さない・INV-WALL-STALLED-STATIC)", () => {
    const bars = [bar("ongoing", T0, T0 + 5_000)];
    expect(laneLiveElapsedMs(bars, "stalled", false)).toBeNull();
    expect(laneLiveElapsedMs(bars, "live", true)).toBeNull();
  });

  it("ongoing バーが無ければ null (完了のみ)", () => {
    const bars = [bar("paired", T0, T0 + 2_000), bar("point", T0, T0)];
    expect(laneLiveElapsedMs(bars, "live", false)).toBeNull();
  });
});

describe("formatElapsed (決定論ラベル)", () => {
  it("60 秒未満は 秒", () => {
    expect(formatElapsed(0)).toBe("0秒");
    expect(formatElapsed(45_000)).toBe("45秒");
    expect(formatElapsed(59_999)).toBe("59秒");
  });

  it("60 秒以上は 分秒", () => {
    expect(formatElapsed(60_000)).toBe("1分0秒");
    expect(formatElapsed(83_000)).toBe("1分23秒");
  });

  it("負値は 0秒 (clamp)", () => {
    expect(formatElapsed(-5_000)).toBe("0秒");
  });
});

describe("shortenCwd (どのディレクトリで動いているか)", () => {
  it("ホーム配下を ~/ に畳む", () => {
    expect(shortenCwd("/home/user/Files/ActraDeck")).toBe("~/Files/ActraDeck");
    expect(shortenCwd("/Users/alice/dev/x")).toBe("~/dev/x");
    expect(shortenCwd("/root/work")).toBe("~/work");
  });

  it("ホーム直下/ホームそのものも畳む", () => {
    expect(shortenCwd("/home/user")).toBe("~");
    expect(shortenCwd("/home/user/")).toBe("~/");
  });

  it("ホーム外はそのまま", () => {
    expect(shortenCwd("/tmp/scratch")).toBe("/tmp/scratch");
    expect(shortenCwd("/srv/app")).toBe("/srv/app");
  });

  it("cwd 無しは null (表示しない)", () => {
    expect(shortenCwd(undefined)).toBeNull();
    expect(shortenCwd("")).toBeNull();
  });
});

describe("shortSessionId (TDA-1: slice(0,12) 集約・単一出所)", () => {
  it("先頭 SHORT_SESSION_ID_LEN 文字へ畳む", () => {
    expect(SHORT_SESSION_ID_LEN).toBe(12);
    expect(shortSessionId("0123456789abcdef-uuid")).toBe("0123456789ab");
    expect(shortSessionId("0123456789abcdef-uuid").length).toBe(12);
  });

  it("長さ未満はそのまま (短い id を壊さない)", () => {
    expect(shortSessionId("short")).toBe("short");
    expect(shortSessionId("")).toBe("");
  });
});

/**
 * INV-WALL-LANE-ORDER: ユーザー並び替えの純ロジック (reconcile/apply/move) を固定する。
 * 永続順は再取得や新規参入で崩れず、移動は決定論で端クランプする。
 */
describe("wall lane reorder (reconcileLaneOrder / applyLaneOrder / moveInOrder / moveByOffset)", () => {
  const laneOf = (id: string) => ({ session: { session_id: id } });

  it("reconcileLaneOrder: 既知は保存順保持・新規は末尾・消滅は除去", () => {
    // 保存順 [b,a]、現存 [a,b,c] → 既知 b,a を保持し新規 c を末尾へ。
    expect(reconcileLaneOrder(["b", "a"], ["a", "b", "c"])).toEqual(["b", "a", "c"]);
    // 消滅 (保存順 a が現存に無い) は落とす。
    expect(reconcileLaneOrder(["a", "b"], ["b", "c"])).toEqual(["b", "c"]);
    // 空保存順は取得順そのまま。
    expect(reconcileLaneOrder([], ["x", "y"])).toEqual(["x", "y"]);
  });

  it("applyLaneOrder: order に従い安定ソート、order 外は末尾で元順保持", () => {
    const lanes = [laneOf("a"), laneOf("b"), laneOf("c")];
    expect(applyLaneOrder(lanes, ["c", "a"]).map((l) => l.session.session_id)).toEqual([
      "c",
      "a",
      "b", // order 外は末尾・元順。
    ]);
    // 元配列を破壊しない (非破壊ソート)。
    expect(lanes.map((l) => l.session.session_id)).toEqual(["a", "b", "c"]);
  });

  it("moveRelative: ドロップ位置 (before/after) で両方向に動く", () => {
    // before: toId の直前へ。
    expect(moveRelative(["a", "b", "c", "d"], "d", "b", "before")).toEqual(["a", "d", "b", "c"]);
    // after: toId の直後へ。これが無いと「上を下へ」隣接ドロップが no-op になる回帰の核心。
    expect(moveRelative(["a", "b"], "a", "b", "after")).toEqual(["b", "a"]);
    expect(moveRelative(["a", "b"], "a", "b", "before")).toEqual(["a", "b"]); // before は元のまま。
    expect(moveRelative(["a", "b", "c"], "c", "a", "before")).toEqual(["c", "a", "b"]);
    // 同一・不在は no-op (コピー)。
    expect(moveRelative(["a", "b"], "a", "a", "after")).toEqual(["a", "b"]);
    expect(moveRelative(["a", "b"], "z", "a", "after")).toEqual(["a", "b"]);
  });

  it("moveByOffset: ±delta 移動で端クランプ (キーボード代替)", () => {
    expect(moveByOffset(["a", "b", "c"], "c", -1)).toEqual(["a", "c", "b"]);
    expect(moveByOffset(["a", "b", "c"], "a", 1)).toEqual(["b", "a", "c"]);
    // 端を越える移動はクランプ (先頭をさらに上 / 末尾をさらに下 = no-op)。
    expect(moveByOffset(["a", "b", "c"], "a", -1)).toEqual(["a", "b", "c"]);
    expect(moveByOffset(["a", "b", "c"], "c", 1)).toEqual(["a", "b", "c"]);
    // 不在 id は no-op。
    expect(moveByOffset(["a", "b"], "z", 1)).toEqual(["a", "b"]);
  });
});

/**
 * INV-WALL-LANE-POINTER-REORDER: ライブ追従 DnD のプレビュー順ロジックを固定する。
 * 各レーン中心 Y とポインタ Y から挿入位置が決定論で決まり、現順序を入力にした不動点で安定する。
 */
describe("reorderByPointerY (ライブ追従プレビュー順)", () => {
  // 3 レーン a,b,c が中心 Y=10,30,50 に並ぶ想定。
  const order = ["a", "b", "c"];
  const centers = [10, 30, 50];

  it("ポインタが全レーンより上 → 先頭へ", () => {
    expect(reorderByPointerY(order, "c", centers, 0)).toEqual(["c", "a", "b"]);
  });

  it("ポインタが全レーンより下 → 末尾へ", () => {
    expect(reorderByPointerY(order, "a", centers, 999)).toEqual(["b", "c", "a"]);
  });

  it("ポインタが b の中心をまたぐと a と b が入れ替わる (a を下へ)", () => {
    // a(自身) を無視し、b(30) より下 c(50) は上に無い → idx=1 (b の後ろ)。
    expect(reorderByPointerY(order, "a", centers, 31)).toEqual(["b", "a", "c"]);
    // まだ b の中心(30) を越えていない → 元の先頭のまま。
    expect(reorderByPointerY(order, "a", centers, 29)).toEqual(["a", "b", "c"]);
  });

  it("ドラッグ中レーン自身の中心は無視する (位置据え置きで不動点)", () => {
    // b をその場 (中心30 付近) に置く → 元順序のまま安定 (ちらつかない)。
    expect(reorderByPointerY(order, "b", centers, 30)).toEqual(["a", "b", "c"]);
  });

  it("不在 id / 長さ不一致は no-op (コピー)", () => {
    expect(reorderByPointerY(order, "z", centers, 5)).toEqual(["a", "b", "c"]);
    expect(reorderByPointerY(order, "a", [10, 30], 5)).toEqual(["a", "b", "c"]);
  });
});

/**
 * INV-WALL-RULER-DETERMINISM: 共通時間軸ルーラーの目盛りは窓幅から決定論で導出される。
 * 左端=「windowMs 前」… 右端=「now」。架空の目盛りを描かない (非正入力は空)。
 */
describe("rulerTicks / rulerDivisionsFor (INV-WALL-RULER-DETERMINISM)", () => {
  it("2分窓 ÷4: 2分前 / 1分30秒前 / 1分前 / 30秒前 / now", () => {
    expect(rulerTicks(120_000, 4)).toEqual([
      { leftPct: 0, label: "2分0秒前" },
      { leftPct: 25, label: "1分30秒前" },
      { leftPct: 50, label: "1分0秒前" },
      { leftPct: 75, label: "30秒前" },
      { leftPct: 100, label: "now" },
    ]);
  });

  it("30秒窓は 3 分割 (10 秒刻み)、他は 4 分割", () => {
    expect(rulerDivisionsFor(30_000)).toBe(3);
    expect(rulerDivisionsFor(120_000)).toBe(4);
    expect(rulerDivisionsFor(600_000)).toBe(4);
    expect(rulerTicks(30_000, 3).map((t) => t.label)).toEqual([
      "30秒前",
      "20秒前",
      "10秒前",
      "now",
    ]);
  });

  it("決定論: 同入力で同出力", () => {
    expect(rulerTicks(600_000, 4)).toEqual(rulerTicks(600_000, 4));
  });

  it("非正の窓/分割は空 (架空の目盛りを描かない)", () => {
    expect(rulerTicks(0, 4)).toEqual([]);
    expect(rulerTicks(-1, 4)).toEqual([]);
    expect(rulerTicks(120_000, 0)).toEqual([]);
  });
});

/**
 * INV-WALL-LANE-COLLAPSE: 既定折りたたみは idle/unknown かつ非要対応のみ。
 * **介入関連 (live / 要対応 / 停止疑い / stalled) を絶対に既定で隠さない**。
 */
describe("laneCollapsedDefault (介入関連を隠さない)", () => {
  const s = (
    liveness: "live" | "idle" | "stalled" | "unknown",
    attention = false,
    suspected = false,
  ) => ({
    liveness_state: liveness,
    needs_attention: attention,
    stalled_suspected: suspected,
  });

  it("idle / unknown の非要対応のみ既定で畳む", () => {
    expect(laneCollapsedDefault(s("idle"))).toBe(true);
    expect(laneCollapsedDefault(s("unknown"))).toBe(true);
  });

  it("live は畳まない (作業中を隠さない)", () => {
    expect(laneCollapsedDefault(s("live"))).toBe(false);
  });

  it("要対応 / 停止疑い / stalled は liveness に関わらず畳まない", () => {
    expect(laneCollapsedDefault(s("idle", true))).toBe(false);
    expect(laneCollapsedDefault(s("idle", false, true))).toBe(false);
    expect(laneCollapsedDefault(s("stalled"))).toBe(false);
    expect(laneCollapsedDefault(s("stalled", false, true))).toBe(false);
  });
});

/**
 * INV-WALL-ATTENTION-VISIBLE (純ロジック面): 要対応レーンの id 抽出は表示順を保つ
 * (DnD のユーザー並びを尊重し、ジャンプ巡回はその順で回る)。
 */
describe("attentionLaneIds (表示順保持)", () => {
  const laneOf = (id: string, attention: boolean) => ({
    session: { session_id: id, needs_attention: attention },
  });

  it("needs_attention のみを表示順のまま返す", () => {
    expect(attentionLaneIds([laneOf("a", false), laneOf("b", true), laneOf("c", true)])).toEqual([
      "b",
      "c",
    ]);
  });

  it("該当なしは空", () => {
    expect(attentionLaneIds([laneOf("a", false)])).toEqual([]);
  });
});
