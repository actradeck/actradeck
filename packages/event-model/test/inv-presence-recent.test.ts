/**
 * INV-PRESENCE-OR-RECENT-DETERMINISM (ADR 019f474e): LiveWall/Board 既定の表示包含述語
 * `isPresentOrRecentlyActive` の純関数性・境界・external 限定 recency proxy を falsifiable に固定する。
 *
 * 縛る不変条件 (mutation で赤):
 *  - connected===true は source 無関係に true。
 *  - source!==external は connected 単独 (recency proxy は external 限定)。
 *  - external は 0<=age<=WALL_RECENT_MS のとき true・両境界含む・超過/欠落/不正 ts は false。
 *  - external の未来日時 (age<0) は下限クランプで false (SEC-1: 120s 窓超えの居座り防止)。
 *  - INV-WALL-ENDED-EXTERNAL (ADR 019f4c19 wall-ended-badge): external ∧ terminal state
 *    (completed/failed/interrupted) は age が窓内でも false(session.ended 済みは「直近 active」でない・
 *    ✓LIVE で残さない)。terminal 除外を撤去する mutation で赤。
 *  - 同入力同出力 (決定的)。
 */
import { describe, expect, it } from "vitest";

import {
  WALL_RECENT_MS,
  isPresentOrRecentlyActive,
  type PresenceRecencyInput,
} from "../src/presence.js";

const NOW = Date.parse("2026-07-09T00:10:00.000Z");
const isoAgo = (msAgo: number): string => new Date(NOW - msAgo).toISOString();

function inp(o: Partial<PresenceRecencyInput> = {}): PresenceRecencyInput {
  return { connected: false, source: "hooks", last_event_at: undefined, ...o };
}

describe("isPresentOrRecentlyActive (INV-PRESENCE-OR-RECENT-DETERMINISM)", () => {
  it("connected===true は source 無関係に true (presence があれば無条件で表示)", () => {
    for (const source of ["hooks", "app_server", "rollout", "sdk", "external"]) {
      // last_event_at が欠落/古くても connected なら true。
      expect(isPresentOrRecentlyActive(inp({ connected: true, source }), NOW)).toBe(true);
      expect(
        isPresentOrRecentlyActive(
          inp({ connected: true, source, last_event_at: isoAgo(99 * 3600_000) }),
          NOW,
        ),
      ).toBe(true);
    }
  });

  it("非 external ∧ !connected は false (recency proxy は external 限定)", () => {
    // managed/attach/codex_rollout 相当: presence を持てる経路ゆえ recency で救わない。
    for (const source of ["hooks", "app_server", "rollout", "sdk"]) {
      // たとえ直近イベントがあっても false (external でないと proxy が効かない)。
      expect(isPresentOrRecentlyActive(inp({ source, last_event_at: isoAgo(1_000) }), NOW)).toBe(
        false,
      );
    }
  });

  it("external ∧ !connected ∧ age<=WALL_RECENT_MS は true (直近 active を presence 代理で包含)", () => {
    expect(
      isPresentOrRecentlyActive(inp({ source: "external", last_event_at: isoAgo(1_000) }), NOW),
    ).toBe(true);
  });

  it("external 境界: age==WALL_RECENT_MS は含む / age>WALL_RECENT_MS は含まない (決定的境界)", () => {
    // 境界ちょうど (<=) は包含。
    expect(
      isPresentOrRecentlyActive(
        inp({ source: "external", last_event_at: isoAgo(WALL_RECENT_MS) }),
        NOW,
      ),
    ).toBe(true);
    // 1ms 超過は除外 (stale external は出さない)。
    expect(
      isPresentOrRecentlyActive(
        inp({ source: "external", last_event_at: isoAgo(WALL_RECENT_MS + 1) }),
        NOW,
      ),
    ).toBe(false);
  });

  it("external 下限クランプ: age==0 (last_event_at===now) は含む / 未来日時 age<0 は含まない (SEC-1)", () => {
    // 境界 age==0 (last_event_at === nowMs) は包含 (両側有界の下端)。
    expect(
      isPresentOrRecentlyActive(inp({ source: "external", last_event_at: isoAgo(0) }), NOW),
    ).toBe(true);
    // 未来日時 (age<0) は異常入力として除外。下限クランプ (age>=0) が無いと WALL_RECENT_MS 窓を
    // 超えて membership が居座る (未来 1ms でも connected でもないのに表示され続ける)。
    expect(
      isPresentOrRecentlyActive(inp({ source: "external", last_event_at: isoAgo(-1) }), NOW),
    ).toBe(false);
    // 遠い未来 (WALL_RECENT_MS を大きく超える未来) も上限だけなら通ってしまうため明示固定。
    expect(
      isPresentOrRecentlyActive(
        inp({ source: "external", last_event_at: isoAgo(-(WALL_RECENT_MS * 10)) }),
        NOW,
      ),
    ).toBe(false);
  });

  it("INV-WALL-ENDED-EXTERNAL: external ∧ terminal state (completed/failed/interrupted) は age 窓内でも false", () => {
    // recency 窓内 (直近 active に見える) でも、正規化状態が terminal なら「終了済み=活動中でない」
    // ゆえ LiveWall から落とす。session.ended→completed を発火した external の ✓LIVE 誤表示を塞ぐ。
    for (const terminal of ["completed", "failed", "interrupted"]) {
      expect(
        isPresentOrRecentlyActive(
          inp({ source: "external", state: terminal, last_event_at: isoAgo(1_000) }),
          NOW,
        ),
        `terminal external (${terminal}) must be excluded from recency proxy`,
      ).toBe(false);
      // age==0 (last_event_at===now) の「たった今 ended」も含めない。
      expect(
        isPresentOrRecentlyActive(
          inp({ source: "external", state: terminal, last_event_at: isoAgo(0) }),
          NOW,
        ),
      ).toBe(false);
    }
  });

  it("external ∧ 非 terminal state (running.* / waiting.* / undefined) は従来通り recency proxy 対象", () => {
    // まだ活動中の external は terminal 除外に該当せず、age 窓内なら true を維持 (非退行)。
    for (const active of ["running.model_wait", "running.command_executing", "waiting.approval"]) {
      expect(
        isPresentOrRecentlyActive(
          inp({ source: "external", state: active, last_event_at: isoAgo(1_000) }),
          NOW,
        ),
      ).toBe(true);
    }
    // state 未提供 (undefined) は非 terminal 扱い (後方互換・従来挙動)。
    expect(
      isPresentOrRecentlyActive(
        inp({ source: "external", state: undefined, last_event_at: isoAgo(1_000) }),
        NOW,
      ),
    ).toBe(true);
  });

  it("terminal state は external 限定に効く: connected===true な terminal は据え置き true (managed/attach 不変)", () => {
    // connected 短絡が terminal 除外より手前ゆえ、presence を持つ (managed/attach) セッションは
    // terminal でも従来通り表示に残る (本修正は external-recent 経路のみに効く)。
    expect(
      isPresentOrRecentlyActive(
        inp({
          connected: true,
          source: "external",
          state: "completed",
          last_event_at: isoAgo(1_000),
        }),
        NOW,
      ),
    ).toBe(true);
  });

  it("external ∧ last_event_at 欠落 or 不正 ISO は false (証拠なしに包含しない)", () => {
    expect(
      isPresentOrRecentlyActive(inp({ source: "external", last_event_at: undefined }), NOW),
    ).toBe(false);
    expect(
      isPresentOrRecentlyActive(inp({ source: "external", last_event_at: "not-a-date" }), NOW),
    ).toBe(false);
  });

  it("純関数: 同入力同出力 (決定的)", () => {
    const s = inp({ source: "external", last_event_at: isoAgo(5_000) });
    const a = isPresentOrRecentlyActive(s, NOW);
    const b = isPresentOrRecentlyActive(s, NOW);
    expect(a).toBe(b);
    expect(a).toBe(true);
  });
});
