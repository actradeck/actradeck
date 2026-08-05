/**
 * run lineage 表示派生の純関数契約 (ADR 0014 Phase 3c・decision 019fd250)。
 *
 *  - deriveContinuedFrom: session_id で解決・未観測は linked-unknown (orphan/エラー化しない)・
 *    self-loop 禁止 (rollout の forked_from_id == 安定会話 id で stable id 欠落時に成立)・
 *    エッジ欠落は undefined (何も主張しない)。carryover TDA-1 (裁定 019fc4c6) の消費者要件。
 *  - resolvedContinuationOf: stored-first (event-model resolveContinuation の唯一の UI 消費点)。
 *    TDA-4 実例 (stored=not_resumable vs derived("failed")=unknown) を fixture 化。
 *  - hasLineageChain: 2 run 以上のときのみ表示。
 */
import { describe, expect, it } from "vitest";

import {
  deriveContinuedFrom,
  hasLineageChain,
  resolvedContinuationOf,
} from "../src/ui/lineage-display.js";

describe("deriveContinuedFrom (TDA-1 消費者要件)", () => {
  it("観測済み参照 (resumed_from_observed=true) → resolved", () => {
    expect(
      deriveContinuedFrom({
        session_id: "sess_child",
        resumed_from_session_id: "sess_parent",
        resumed_from_observed: true,
      }),
    ).toEqual({ kind: "resolved", sessionId: "sess_parent" });
  });

  it("未観測の宣言参照 (observed=false / 欠落) → linked-unknown (エラー化しない)", () => {
    expect(
      deriveContinuedFrom({
        session_id: "sess_child",
        resumed_from_session_id: "sess_unseen",
        resumed_from_observed: false,
      }),
    ).toEqual({ kind: "linked-unknown", sessionId: "sess_unseen" });
    // observed フラグ欠落も観測済みと主張しない (安全側 linked-unknown)。
    expect(
      deriveContinuedFrom({ session_id: "sess_child", resumed_from_session_id: "sess_unseen" }),
    ).toEqual({ kind: "linked-unknown", sessionId: "sess_unseen" });
  });

  it("self-loop 禁止: resumed_from == 自 session_id はエッジ非表示 (undefined)", () => {
    expect(
      deriveContinuedFrom({
        session_id: "sess_same",
        resumed_from_session_id: "sess_same",
        resumed_from_observed: true,
      }),
    ).toBeUndefined();
  });

  it("エッジ欠落 / 空文字は undefined (attach 大半 = 何も主張しない)", () => {
    expect(deriveContinuedFrom({ session_id: "s1" })).toBeUndefined();
    expect(deriveContinuedFrom({ session_id: "s1", resumed_from_session_id: "" })).toBeUndefined();
  });
});

describe("resolvedContinuationOf (stored-first・decision 019fd250)", () => {
  it("TDA-4 実例: stored=not_resumable が derived('failed')=unknown に勝つ", () => {
    expect(resolvedContinuationOf({ state: "failed", recoverability: "not_resumable" })).toBe(
      "not_resumable",
    );
  });

  it("stored 不在は derived 既定へ fallback (suspended→resumable / failed→unknown)", () => {
    expect(resolvedContinuationOf({ state: "suspended", recoverability: undefined })).toBe(
      "resumable",
    );
    expect(resolvedContinuationOf({ state: "failed", recoverability: undefined })).toBe("unknown");
  });

  it("非 terminal / state 欠落 + stored 不在は undefined (非表示)", () => {
    expect(
      resolvedContinuationOf({ state: "running.command_executing", recoverability: undefined }),
    ).toBeUndefined();
    expect(resolvedContinuationOf({ state: undefined, recoverability: undefined })).toBeUndefined();
  });
});

describe("hasLineageChain", () => {
  it("2 run 以上のときのみ true", () => {
    expect(hasLineageChain({ lineage_runs: undefined })).toBe(false);
    expect(hasLineageChain({ lineage_runs: [{ session_id: "a" }] })).toBe(false);
    expect(hasLineageChain({ lineage_runs: [{ session_id: "a" }, { session_id: "b" }] })).toBe(
      true,
    );
  });
});
