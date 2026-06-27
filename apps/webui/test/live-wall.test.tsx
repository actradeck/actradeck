/**
 * LiveWall view / use-wall-feed の契約テスト — ADR 019ead7a 段階1。
 *
 *  - parseWallResponse: 寛容パース (session_id 無しレーン・event_id/timestamp 無し event のみ落とす)。
 *  - LiveWall: 静的描画で live-wall / 空状態 / ライブ追従窓コントロールを固定。
 *  - INV-WALL-SINGLE-SELECT-INTACT: Wall は pull (use-wall-feed) のみで供給し、単一選択購読
 *    (use-realtime の subscribe) を一切張らない。ソース走査で subscribe/use-realtime 非依存を固定。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { LiveWall, WallLaneRow, WallRuler } from "../src/ui/LiveWall.js";
import { parseWallResponse } from "../src/ui/use-wall-feed.js";

import type { LivenessState, ReplayEventDTO, WallLane } from "../src/realtime/contract.js";

const NOW = Date.parse("2026-06-05T00:00:10.000Z");

function ev(o: Partial<ReplayEventDTO> = {}): ReplayEventDTO {
  return {
    event_id: "e1",
    provider: "claude_code",
    source: "hooks",
    session_id: "s1",
    event_type: "command.started",
    kind: "command",
    timestamp: new Date(NOW - 5_000).toISOString(),
    state: undefined,
    cwd: undefined,
    summary: undefined,
    display_text: "running cmd",
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

function lane(livenessState: LivenessState, stalledSuspected: boolean): WallLane {
  return {
    session: {
      session_id: "sess-abcdef123456",
      provider: "claude_code",
      source: "hooks",
      agent_id: undefined,
      repo: undefined,
      branch: undefined,
      cwd: undefined,
      state: undefined,
      current_action: undefined,
      last_event_at: undefined,
      needs_attention: false,
      liveness_state: livenessState,
      stalled_suspected: stalledSuspected,
      connected: true,
    },
    // 完了未到来の started 1 件 → computeLaneBars が ongoing バーにする (レーン最新)。
    events: [ev({ event_id: "ongoing-1" })],
  };
}

describe("parseWallResponse (寛容パース)", () => {
  it("非 object / lanes 非配列は空", () => {
    expect(parseWallResponse(null)).toEqual([]);
    expect(parseWallResponse({})).toEqual([]);
    expect(parseWallResponse({ lanes: "x" })).toEqual([]);
  });

  it("session_id 無しレーンは落とす", () => {
    const out = parseWallResponse({ lanes: [{ session: {}, events: [] }] });
    expect(out).toEqual([]);
  });

  it("event_id/timestamp 無し event のみ落とし、有効 event は残す", () => {
    const out = parseWallResponse({
      lanes: [
        {
          session: { session_id: "s1", provider: "claude_code", connected: true },
          events: [
            { event_id: "ok", timestamp: "2026-06-05T00:00:00.000Z" },
            { event_id: "no-ts" },
            { timestamp: "2026-06-05T00:00:01.000Z" },
          ],
        },
      ],
    });
    expect(out).toHaveLength(1);
    expect(out[0]!.events.map((e) => e.event_id)).toEqual(["ok"]);
  });

  it("events 非配列のレーンは落とす", () => {
    const out = parseWallResponse({
      lanes: [{ session: { session_id: "s1" }, events: "nope" }],
    });
    expect(out).toEqual([]);
  });
});

describe("LiveWall 静的描画", () => {
  it("live-wall + 空状態 + ライブ追従窓コントロール (既定 2 分 pressed)", () => {
    const html = renderToStaticMarkup(<LiveWall active nowMs={NOW} onOpenSession={() => {}} />);
    expect(html).toContain('data-testid="live-wall"');
    // 静的描画 (effect 未実行) では lanes=[] → 空状態。
    expect(html).toContain('data-testid="wall-empty"');
    expect(html).toContain("起動中セッションのアクションはありません");
    // 窓コントロール 30s/2m/10m、既定 120000 が押下状態。
    expect(html).toContain('data-testid="wall-window-30000"');
    expect(html).toContain('data-testid="wall-window-600000"');
    expect(html).toMatch(/aria-pressed="true"[^>]*data-testid="wall-window-120000"/);
    expect(html).toContain('data-testid="wall-refresh"');
  });

  it("バー色の凡例 (legend) を表示する", () => {
    const html = renderToStaticMarkup(<LiveWall active nowMs={NOW} onOpenSession={() => {}} />);
    expect(html).toContain('data-testid="wall-legend"');
    expect(html).toContain("バーの色 = アクション種別");
    expect(html).toContain("コマンド");
    expect(html).toContain("ファイル / 差分");
    expect(html).toContain("承認 / エラー");
    expect(html).toContain("生存信号");
    expect(html).toContain("ツール / MCP / その他");
    // swatch は bar 色クラスを再利用 (色対応を pin)。
    expect(html).toContain("ad-wall__legend-swatch ad-wall__bar--command");
  });
});

describe("INV-WALL-SINGLE-SELECT-INTACT (Wall は pull のみ・subscribe を張らない)", () => {
  const liveWallSrc = readFileSync(
    fileURLToPath(new URL("../src/ui/LiveWall.tsx", import.meta.url)),
    "utf8",
  );
  const feedSrc = readFileSync(
    fileURLToPath(new URL("../src/ui/use-wall-feed.ts", import.meta.url)),
    "utf8",
  );

  it("LiveWall は use-wall-feed (pull) を使い、use-realtime を import せず subscribe を呼ばない", () => {
    expect(liveWallSrc).toContain("use-wall-feed");
    // use-realtime を import しない / subscribe を呼ばない (コメント言及ではなく実依存を pin)。
    expect(liveWallSrc).not.toMatch(/import[^;]*use-realtime/);
    expect(liveWallSrc).not.toMatch(/\.subscribe\(/);
    expect(feedSrc).not.toMatch(/import[^;]*use-realtime/);
    expect(feedSrc).not.toMatch(/\.subscribe\(/);
  });
});

describe("WallLaneRow 段階2 motion (INV-WALL-MOTION-LIVENESS-MAP / STALLED-STATIC)", () => {
  it("live-ongoing バーは脈動 (data-motion=pulse + ad-wall__bar--pulse) + 静的経過カウンタ", () => {
    const html = renderToStaticMarkup(
      <WallLaneRow lane={lane("live", false)} nowMs={NOW} windowMs={120_000} />,
    );
    expect(html).toContain('data-motion="pulse"');
    expect(html).toContain("ad-wall__bar--pulse");
    // reduced-motion 代替 (INV-WALL-REDUCED-MOTION-ALT): 脈動が無効でも伝わる静的カウンタが常在。
    expect(html).toContain('data-testid="wall-lane-elapsed"');
    expect(html).toContain("実行中");
    expect(html).toContain("5秒");
  });

  it("stalled レーンの ongoing バーは静止 (pulse 無し)・実行中カウンタ無し・STALLED? 表記維持", () => {
    const html = renderToStaticMarkup(
      <WallLaneRow lane={lane("stalled", true)} nowMs={NOW} windowMs={120_000} />,
    );
    expect(html).toContain('data-motion="static"');
    expect(html).not.toContain("ad-wall__bar--pulse");
    // alive 偽装しない: 実行中カウンタを出さない。
    expect(html).not.toContain('data-testid="wall-lane-elapsed"');
    // INV-STALLED 整合: 停止を断定せず "STALLED?" (suspected) を保つ。
    expect(html).toContain("STALLED?");
  });

  it("idle レーンの ongoing バーも静止 (live のみ脈動)", () => {
    const html = renderToStaticMarkup(
      <WallLaneRow lane={lane("idle", false)} nowMs={NOW} windowMs={120_000} />,
    );
    expect(html).toContain('data-motion="static"');
    expect(html).not.toContain("ad-wall__bar--pulse");
    expect(html).not.toContain('data-testid="wall-lane-elapsed"');
  });

  it("live + suspected は ongoing でも静止 (suspected が live に優先・QA-stage2-1)", () => {
    const html = renderToStaticMarkup(
      <WallLaneRow lane={lane("live", true)} nowMs={NOW} windowMs={120_000} />,
    );
    expect(html).toContain('data-motion="static"');
    expect(html).not.toContain("ad-wall__bar--pulse");
    expect(html).not.toContain('data-testid="wall-lane-elapsed"');
  });
});

describe("WallLaneRow の Replay 導線 (調査面から1クリック)", () => {
  it("onOpenReplay 指定でレーンに Replay ボタンを出す (renew アイコン + 共通ラベル)", () => {
    const html = renderToStaticMarkup(
      <WallLaneRow
        lane={lane("live", false)}
        nowMs={NOW}
        windowMs={120_000}
        onOpenSession={() => {}}
        onOpenReplay={() => {}}
      />,
    );
    expect(html).toContain('data-testid="wall-replay-sess-abcdef123456"');
    expect(html).toContain("再生");
    // 既存の詳細導線も併存する。
    expect(html).toContain('data-testid="wall-open-sess-abcdef123456"');
  });

  it("onOpenReplay 未指定なら Replay ボタンを出さない", () => {
    const html = renderToStaticMarkup(
      <WallLaneRow
        lane={lane("live", false)}
        nowMs={NOW}
        windowMs={120_000}
        onOpenSession={() => {}}
      />,
    );
    expect(html).not.toContain('data-testid="wall-replay-sess-abcdef123456"');
  });
});

describe("WallLaneRow が cwd (どのディレクトリ) を表示する", () => {
  it("cwd を ~ 短縮で出し、full path は title・repo@branch も併記", () => {
    const base = lane("live", false);
    const withLoc: WallLane = {
      ...base,
      session: {
        ...base.session,
        cwd: "/home/user/Files/ActraDeck",
        repo: "ActraDeck",
        branch: "main",
      },
    };
    const html = renderToStaticMarkup(
      <WallLaneRow lane={withLoc} nowMs={NOW} windowMs={120_000} />,
    );
    expect(html).toContain('data-testid="wall-lane-cwd"');
    expect(html).toContain("~/Files/ActraDeck");
    expect(html).toContain('title="/home/user/Files/ActraDeck"');
    expect(html).toContain('data-testid="wall-lane-repo"');
    expect(html).toContain("ActraDeck@main");
  });

  it("cwd 無しのレーンは cwd チップを出さない", () => {
    const html = renderToStaticMarkup(
      <WallLaneRow lane={lane("live", false)} nowMs={NOW} windowMs={120_000} />,
    );
    expect(html).not.toContain('data-testid="wall-lane-cwd"');
  });
});

describe("INV-WALL-REDUCED-MOTION-ALT (脈動の reduced-motion 無効化機構)", () => {
  const scss = readFileSync(fileURLToPath(new URL("../app/globals.scss", import.meta.url)), "utf8");

  it("globals.scss に脈動 keyframes と pulse クラス、global reduced-motion 無効化が在る", () => {
    expect(scss).toContain("@keyframes ad-wall-pulse");
    expect(scss).toMatch(/\.ad-wall__bar--pulse\s*\{[^}]*animation:\s*ad-wall-pulse/);
    // 脈動を止める機構 = global prefers-reduced-motion ブロック (全 animation を実質停止)。
    expect(scss).toContain("@media (prefers-reduced-motion: reduce)");
  });
});

/**
 * INV-WALL-LANE-REORDER-UI: レーン並べ替え UI (DnD ハンドル + キーボード代替 ↑/↓) の描画契約。
 * reorderable のときだけ出す・端でボタン disabled・id ごとに testid を持つ・a11y ラベルを伴う。
 */
describe("WallLaneRow 並べ替え UI (DnD ハンドル + キーボード代替)", () => {
  const ID = "sess-abcdef123456";

  it("reorderable のとき行全体が draggable で、ハンドルと ↑/↓ ボタンを a11y ラベル付きで出す", () => {
    const html = renderToStaticMarkup(
      <WallLaneRow lane={lane("live", false)} nowMs={NOW} windowMs={120_000} reorderable />,
    );
    expect(html).toContain('draggable="true"'); // 行全体 (section) がドラッグ源。
    expect(html).toContain(`data-testid="wall-drag-${ID}"`); // 視覚アフォーダンスのハンドル。
    expect(html).toContain("ドラッグで並べ替え"); // ハンドル title。
    expect(html).toContain(`data-testid="wall-move-up-${ID}"`);
    expect(html).toContain(`data-testid="wall-move-down-${ID}"`);
    expect(html).toContain("を上へ移動"); // ↑ ボタンの aria-label
    expect(html).toContain("を下へ移動");
  });

  it("reorderable でない (既定) ときは並べ替え UI を出さず draggable も付かない", () => {
    const html = renderToStaticMarkup(
      <WallLaneRow lane={lane("live", false)} nowMs={NOW} windowMs={120_000} />,
    );
    expect(html).not.toContain(`data-testid="wall-drag-${ID}"`);
    expect(html).not.toContain(`data-testid="wall-move-up-${ID}"`);
    expect(html).not.toContain('draggable="true"');
  });

  it("dropPlace を渡すと data-drop インジケータ属性が出る (ドロップ位置の可視化)", () => {
    const before = renderToStaticMarkup(
      <WallLaneRow
        lane={lane("live", false)}
        nowMs={NOW}
        windowMs={120_000}
        reorderable
        dropPlace="before"
      />,
    );
    expect(before).toContain('data-drop="before"');
    const after = renderToStaticMarkup(
      <WallLaneRow
        lane={lane("live", false)}
        nowMs={NOW}
        windowMs={120_000}
        reorderable
        dropPlace="after"
      />,
    );
    expect(after).toContain('data-drop="after"');
  });

  it("先頭レーンは ↑ が disabled、末尾レーンは ↓ が disabled (端クランプの可視化)", () => {
    const first = renderToStaticMarkup(
      <WallLaneRow lane={lane("live", false)} nowMs={NOW} windowMs={120_000} reorderable isFirst />,
    );
    // 先頭: up disabled / down 非 disabled。
    expect(new RegExp(`data-testid="wall-move-up-${ID}"[^>]*disabled`).test(first)).toBe(true);
    expect(new RegExp(`data-testid="wall-move-down-${ID}"[^>]*disabled`).test(first)).toBe(false);

    const last = renderToStaticMarkup(
      <WallLaneRow lane={lane("live", false)} nowMs={NOW} windowMs={120_000} reorderable isLast />,
    );
    expect(new RegExp(`data-testid="wall-move-down-${ID}"[^>]*disabled`).test(last)).toBe(true);
    expect(new RegExp(`data-testid="wall-move-up-${ID}"[^>]*disabled`).test(last)).toBe(false);
  });
});

/**
 * INV-WALL-ATTENTION-VISIBLE: 要対応 (needs_attention) レーンは data-attention 属性 +
 * 「要対応」chip で強制可視化する。並び順は変えない (視覚のみで浮かせる)。
 */
describe("WallLaneRow 要対応の強制可視化", () => {
  const attentionLane = (): WallLane => {
    const base = lane("idle", false);
    return { ...base, session: { ...base.session, needs_attention: true } };
  };

  it("needs_attention レーンは data-attention + 要対応 chip", () => {
    const html = renderToStaticMarkup(
      <WallLaneRow lane={attentionLane()} nowMs={NOW} windowMs={120_000} />,
    );
    expect(html).toContain("data-attention");
    expect(html).toContain('data-testid="wall-lane-attention"');
    expect(html).toContain("要対応");
  });

  it("非要対応レーンには出さない", () => {
    const html = renderToStaticMarkup(
      <WallLaneRow lane={lane("live", false)} nowMs={NOW} windowMs={120_000} />,
    );
    expect(html).not.toContain("data-attention");
    expect(html).not.toContain('data-testid="wall-lane-attention"');
  });
});

/**
 * INV-WALL-LANE-COLLAPSE (UI 面): collapsed レーンは track を描かずヘッダのみ。
 * トグルは aria-expanded で状態を公開し、onToggleCollapse 無指定なら出さない。
 */
describe("WallLaneRow 折りたたみ (密度制御)", () => {
  const ID = "sess-abcdef123456";

  it("collapsed は track を描かず data-collapsed が付く", () => {
    const html = renderToStaticMarkup(
      <WallLaneRow
        lane={lane("idle", false)}
        nowMs={NOW}
        windowMs={120_000}
        collapsed
        onToggleCollapse={() => {}}
      />,
    );
    expect(html).toContain("data-collapsed");
    expect(html).not.toContain(`data-testid="wall-track-${ID}"`);
    expect(html).toMatch(new RegExp(`data-testid="wall-collapse-${ID}"[^>]*aria-expanded="false"`));
    // ヘッダ情報 (cwd 等のメタ行・状態) は折りたたみ中も保つ (隠すのは track のみ)。
    expect(html).toContain('data-testid="wall-lane-id"');
  });

  it("展開時は track を描き aria-expanded=true", () => {
    const html = renderToStaticMarkup(
      <WallLaneRow
        lane={lane("live", false)}
        nowMs={NOW}
        windowMs={120_000}
        onToggleCollapse={() => {}}
      />,
    );
    expect(html).toContain(`data-testid="wall-track-${ID}"`);
    expect(html).toMatch(new RegExp(`data-testid="wall-collapse-${ID}"[^>]*aria-expanded="true"`));
  });

  it("onToggleCollapse 無指定 (単体描画/ゴースト) ではトグルを出さない", () => {
    const html = renderToStaticMarkup(
      <WallLaneRow lane={lane("live", false)} nowMs={NOW} windowMs={120_000} />,
    );
    expect(html).not.toContain(`data-testid="wall-collapse-${ID}"`);
  });
});

/**
 * INV-WALL-RULER-DETERMINISM (UI 面): ルーラーは rulerTicks と同一値源で「N分前 … now」を描き、
 * track には ticks 指定時のみグリッド線 + now 線を重ねる (bar より背面・DOM 順)。
 */
describe("WallRuler / track グリッド線", () => {
  it("2分窓のルーラーは 2分0秒前 … now を描く", () => {
    const html = renderToStaticMarkup(<WallRuler windowMs={120_000} />);
    expect(html).toContain('data-testid="wall-ruler"');
    expect(html).toContain("2分0秒前");
    expect(html).toContain("1分0秒前");
    expect(html).toContain("30秒前");
    expect(html).toContain(">now<");
  });

  it("ticks を渡した track はグリッド線 (内側目盛りのみ) + now 線を描く", () => {
    const ticks = [
      { leftPct: 0, label: "2分0秒前" },
      { leftPct: 50, label: "1分0秒前" },
      { leftPct: 100, label: "now" },
    ];
    const html = renderToStaticMarkup(
      <WallLaneRow lane={lane("live", false)} nowMs={NOW} windowMs={120_000} ticks={ticks} />,
    );
    // 内側 (0<pct<100) の 1 本のみ線になる (端はルーラーラベルと track 枠が兼ねる)。
    expect(html.match(/data-testid="wall-gridline"/g)?.length).toBe(1);
    expect(html).toContain('data-testid="wall-nowline"');
  });

  it("ticks 無指定なら線を描かない (単体描画の既定・非退行)", () => {
    const html = renderToStaticMarkup(
      <WallLaneRow lane={lane("live", false)} nowMs={NOW} windowMs={120_000} />,
    );
    expect(html).not.toContain('data-testid="wall-gridline"');
    expect(html).not.toContain('data-testid="wall-nowline"');
  });
});

/**
 * INV-WALL-INLINE-APPROVAL: Wall インライン承認は単一出所 ApprovalCard を再利用し、
 * 高リスク確認ゲート (INV-INBOX-HIGHRISK-DENY-DEFAULT) を構造ごと継承する。
 * 折りたたみ中でも承認カードを隠さない。決定は lane の session_id へ束縛して送る。
 */
describe("WallLaneRow インライン承認 (INV-WALL-INLINE-APPROVAL)", () => {
  const ID = "sess-abcdef123456";
  const approvalOf = (rid: string, risk: string | undefined) => ({
    request_id: rid,
    tool_name: "Bash",
    command: "rm -rf build",
    path: undefined,
    risk_level: risk,
    requested_at: new Date(NOW - 1_000).toISOString(),
    session_id: ID,
    trigger: undefined,
    secret_kinds: undefined,
    persistable: undefined,
  });

  it("approvals を渡すと ApprovalCard (許可/拒否/取消) をレーン直下に描く", () => {
    const html = renderToStaticMarkup(
      <WallLaneRow
        lane={lane("live", false)}
        nowMs={NOW}
        windowMs={120_000}
        approvals={[approvalOf("req-1", "medium")]}
        onApproveDecision={() => {}}
      />,
    );
    expect(html).toContain(`data-testid="wall-approvals-${ID}"`);
    expect(html).toContain('data-testid="approval-card-req-1"');
    expect(html).toContain('data-testid="approval-allow"');
    expect(html).toContain('data-testid="approval-deny"');
    expect(html).toContain('data-testid="approval-cancel"');
  });

  it("高リスク承認は確認ゲート (チェックまで allow disabled) を継承する", () => {
    const html = renderToStaticMarkup(
      <WallLaneRow
        lane={lane("live", false)}
        nowMs={NOW}
        windowMs={120_000}
        approvals={[approvalOf("req-hi", "high")]}
        onApproveDecision={() => {}}
      />,
    );
    expect(html).toContain('data-highrisk="true"');
    expect(html).toContain('data-testid="approval-highrisk-ack"');
    // 未確認のため allow は disabled (deny は常に操作可能=安全側既定)。
    expect(html).toMatch(
      /data-testid="approval-allow"[^>]*disabled|disabled[^>]*data-testid="approval-allow"/,
    );
    expect(html).not.toMatch(
      /data-testid="approval-deny"[^>]*disabled|disabled[^>]*data-testid="approval-deny"/,
    );
  });

  it("折りたたみ中でも承認カードを隠さない (介入要素は常時可視)", () => {
    const html = renderToStaticMarkup(
      <WallLaneRow
        lane={lane("idle", false)}
        nowMs={NOW}
        windowMs={120_000}
        collapsed
        onToggleCollapse={() => {}}
        approvals={[approvalOf("req-2", "medium")]}
        onApproveDecision={() => {}}
      />,
    );
    expect(html).not.toContain(`data-testid="wall-track-${ID}"`); // track は畳まれている。
    expect(html).toContain('data-testid="approval-card-req-2"'); // 承認は出ている。
  });

  it("approvals 無指定 (既定/ゴースト) では承認 UI を一切出さない", () => {
    const html = renderToStaticMarkup(
      <WallLaneRow lane={lane("live", false)} nowMs={NOW} windowMs={120_000} />,
    );
    expect(html).not.toContain("wall-approvals-");
    expect(html).not.toContain("approval-card-");
  });
});

describe("INV-WALL-INLINE-APPROVAL (配線・ソース走査)", () => {
  const liveWallSrc = readFileSync(
    fileURLToPath(new URL("../src/ui/LiveWall.tsx", import.meta.url)),
    "utf8",
  );

  it("決定は lane の session_id へ束縛して onApprove へ渡す (誤 session への送信を構造で防ぐ)", () => {
    expect(liveWallSrc).toMatch(
      /onApprove\(lane\.session\.session_id,\s*requestId,\s*decision,\s*undefined,\s*persist\)/,
    );
  });

  it("承認 pull は onApprove 配線時のみ (enabled gating)・供給は use-approval-inbox を再利用", () => {
    expect(liveWallSrc).toContain("useApprovalInbox");
    expect(liveWallSrc).toMatch(/enabled:\s*active\s*&&\s*inlineApproval/);
    // 独自 fetch で承認を取得しない (供給は use-approval-inbox の single choke のみ)。
    expect(liveWallSrc).not.toMatch(/fetch\([^)]*approvals/);
  });

  it("カードは単一出所 ApprovalCard を import する (独自承認カードの再発明禁止)", () => {
    expect(liveWallSrc).toMatch(/import \{ ApprovalCard \} from "\.\/ApprovalCard"/);
  });
});
