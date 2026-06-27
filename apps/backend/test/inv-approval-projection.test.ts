/**
 * INV-APPROVAL projection (ADR 019e9999): reducer が承認要求/解決を pending_approvals へ
 * 決定論的に畳み込むことを固定する純関数テスト (DB 不要)。
 *
 * outbound 承認経路の核: `tool.permission.requested` の request_id を projection に保持し
 * (UI が approve frame で突合)、`tool.permission.resolved` (同 request_id) で除去する。
 */
import { describe, expect, it } from "vitest";

import {
  applyEvent,
  initialProjection,
  MAX_PENDING_APPROVALS,
  reduceEvents,
} from "../src/reducer.js";
import { iso, makeEvent } from "./helpers.js";

const SID = "sess_appr";

function requested(reqId: string, extra: Record<string, unknown> = {}, atMs = 1000) {
  return makeEvent({
    session_id: SID,
    event_type: "tool.permission.requested",
    state: "waiting.approval",
    timestamp: iso(atMs),
    payload: { request_id: reqId, tool_name: "Bash", ...extra },
  });
}

function resolved(reqId: string | undefined, atMs = 2000) {
  return makeEvent({
    session_id: SID,
    event_type: "tool.permission.resolved",
    state: "running.tool_preparing",
    timestamp: iso(atMs),
    payload: {
      ...(reqId !== undefined ? { request_id: reqId } : {}),
      decision: "allow",
    },
  });
}

describe("INV-APPROVAL projection: pending_approvals fold", () => {
  it("requested adds a pending entry carrying request_id + tool/command/risk + needs_attention", () => {
    const proj = applyEvent(
      initialProjection(SID),
      requested("s1:apr-a", { command: "rm -rf /tmp/x", risk_level: "high", path: undefined }),
    ).projection;
    expect(proj.pending_approvals).toHaveLength(1);
    const p = proj.pending_approvals[0]!;
    expect(p.request_id).toBe("s1:apr-a");
    expect(p.tool_name).toBe("Bash");
    expect(p.command).toBe("rm -rf /tmp/x");
    expect(p.risk_level).toBe("high");
    expect(p.requested_at).toBe(iso(1000));
    expect(p.session_id).toBe(SID);
    expect(proj.needs_attention).toBe(true);
  });

  it("resolved with matching request_id removes the pending entry and clears attention", () => {
    let proj = applyEvent(initialProjection(SID), requested("s1:apr-a")).projection;
    proj = applyEvent(proj, resolved("s1:apr-a")).projection;
    expect(proj.pending_approvals).toHaveLength(0);
    expect(proj.needs_attention).toBe(false);
  });

  it("multiple pending: resolving one keeps the other and keeps needs_attention true", () => {
    let proj = applyEvent(initialProjection(SID), requested("s1:apr-a", {}, 1000)).projection;
    proj = applyEvent(proj, requested("s1:apr-b", {}, 1100)).projection;
    expect(proj.pending_approvals).toHaveLength(2);
    proj = applyEvent(proj, resolved("s1:apr-a", 1200)).projection;
    expect(proj.pending_approvals.map((p) => p.request_id)).toEqual(["s1:apr-b"]);
    expect(proj.needs_attention).toBe(true); // 1 件残るので注意は継続。
  });

  it("requested without request_id is not added (no un-matchable orphan)", () => {
    const ev = makeEvent({
      session_id: SID,
      event_type: "tool.permission.requested",
      state: "waiting.approval",
      payload: { tool_name: "Bash" },
    });
    const proj = applyEvent(initialProjection(SID), ev).projection;
    expect(proj.pending_approvals).toHaveLength(0);
    // request_id が無くても waiting.approval state により注意は立つ (state 由来)。
    expect(proj.needs_attention).toBe(true);
  });

  it("resolved without request_id clears all pending (backward-compat safe side)", () => {
    let proj = applyEvent(initialProjection(SID), requested("s1:apr-a")).projection;
    proj = applyEvent(proj, requested("s1:apr-b", {}, 1100)).projection;
    proj = applyEvent(proj, resolved(undefined, 1200)).projection;
    expect(proj.pending_approvals).toHaveLength(0);
    expect(proj.needs_attention).toBe(false);
  });

  it("re-applying the same requested event is idempotent (dedup by request_id)", () => {
    const ev = requested("s1:apr-a");
    let proj = applyEvent(initialProjection(SID), ev).projection;
    proj = applyEvent(proj, ev).projection;
    expect(proj.pending_approvals).toHaveLength(1);
    expect(proj.pending_approvals[0]!.request_id).toBe("s1:apr-a");
  });

  it("deterministic over an event sequence (reduceEvents)", () => {
    const seq = [
      requested("s1:apr-a", {}, 1000),
      requested("s1:apr-b", {}, 1100),
      resolved("s1:apr-a", 1200),
    ];
    const a = reduceEvents(SID, seq);
    const b = reduceEvents(SID, seq);
    expect(a.pending_approvals).toEqual(b.pending_approvals);
    expect(a.pending_approvals.map((p) => p.request_id)).toEqual(["s1:apr-b"]);
  });
});

/**
 * INV-AUTOGUARD-PROJECTION (ADR 019ecc70 D3 段階1 下流): backend reducer 再 export 経由で
 * pending_approvals が guard 理由 (trigger / secret_kinds) を closed-enum 防御つきで運ぶ。
 * backend は projection の parse/fold を共有する (reducer.ts 再 export = 単一出所)。
 */
describe("INV-AUTOGUARD-PROJECTION: trigger/secret_kinds carry + closed-enum drop (backend 共有)", () => {
  it("trigger=secret / secret_kinds=[github-token] を pending に保持する", () => {
    const proj = applyEvent(
      initialProjection(SID),
      requested("s1:apr-g", {
        command: "echo $GITHUB_TOKEN",
        risk_level: "high",
        trigger: "secret",
        secret_kinds: ["github-token"],
      }),
    ).projection;
    const p = proj.pending_approvals[0]!;
    expect(p.trigger).toBe("secret");
    expect(p.secret_kinds).toEqual(["github-token"]);
  });

  it("raw / 未知 secret_kinds は drop し語彙のみ (INV-AUTOGUARD-NO-RAW)", () => {
    const proj = applyEvent(
      initialProjection(SID),
      requested("s1:apr-r", {
        trigger: "secret",
        secret_kinds: ["ghp_FAKErawtokenvalue000000000000000000", "github-token", "phantom"],
      }),
    ).projection;
    const p = proj.pending_approvals[0]!;
    expect(p.secret_kinds).toEqual(["github-token"]);
    expect(JSON.stringify(proj.pending_approvals)).not.toContain("ghp_");
  });

  it("未知 trigger は closed-enum で drop = undefined", () => {
    const proj = applyEvent(
      initialProjection(SID),
      requested("s1:apr-t", { trigger: "bogus", secret_kinds: ["slack-token"] }),
    ).projection;
    const p = proj.pending_approvals[0]!;
    expect(p.trigger).toBeUndefined();
    expect(p.secret_kinds).toEqual(["slack-token"]);
  });

  it("resolved で guard 理由つき pending が消える", () => {
    let proj = applyEvent(
      initialProjection(SID),
      requested("s1:apr-g", { trigger: "both", secret_kinds: ["github-token"] }),
    ).projection;
    expect(proj.pending_approvals).toHaveLength(1);
    proj = applyEvent(proj, resolved("s1:apr-g")).projection;
    expect(proj.pending_approvals).toHaveLength(0);
  });
});

/**
 * QA-1 (ADR 019e99ad): terminal 確定で pending は moot。terminal 後に到達した requested を
 * 滞留させず、終了時に未解決承認を残さない (UI に解消不能な承認カードを出さない)。
 */
describe("QA-1: terminal state clears pending_approvals (no stuck approval card)", () => {
  function ended(atMs: number) {
    return makeEvent({
      session_id: SID,
      event_type: "session.ended",
      state: "completed",
      timestamp: iso(atMs),
      payload: { reason: "logout" },
    });
  }

  it("a session ending with an outstanding pending clears it (terminal moots approvals)", () => {
    let proj = applyEvent(initialProjection(SID), requested("s1:apr-a", {}, 1000)).projection;
    expect(proj.pending_approvals).toHaveLength(1);
    proj = applyEvent(proj, ended(2000)).projection;
    expect(proj.state).toBe("completed");
    expect(proj.pending_approvals).toHaveLength(0);
    expect(proj.needs_attention).toBe(false);
  });

  it("a requested arriving AFTER terminal does not accumulate (state ignored, pending empty)", () => {
    let proj = applyEvent(initialProjection(SID), ended(1000)).projection;
    // terminal 後の requested: state 変更は無視され、pending も滞留しない。
    proj = applyEvent(proj, requested("s1:apr-late", {}, 2000)).projection;
    expect(proj.state).toBe("completed");
    expect(proj.pending_approvals).toHaveLength(0);
    expect(proj.needs_attention).toBe(false);
  });
});

/**
 * SEC-1 (ADR 019e99ad): pending_approvals は有界 (MAX_PENDING_APPROVALS)。resolved が欠落して
 * requested が積み上がっても session_state jsonb が無限肥大しない (最古を捨てる)。
 */
describe("SEC-1: pending_approvals is bounded", () => {
  it(`keeps at most MAX_PENDING_APPROVALS (=${MAX_PENDING_APPROVALS}), dropping the oldest`, () => {
    let proj = initialProjection(SID);
    const total = MAX_PENDING_APPROVALS + 10;
    for (let i = 0; i < total; i++) {
      proj = applyEvent(proj, requested(`s1:apr-${i}`, {}, 1000 + i)).projection;
    }
    expect(proj.pending_approvals).toHaveLength(MAX_PENDING_APPROVALS);
    // 最古 (0..9) は捨てられ、最新側が残る。
    const ids = proj.pending_approvals.map((p) => p.request_id);
    expect(ids[0]).toBe("s1:apr-10");
    expect(ids[ids.length - 1]).toBe(`s1:apr-${total - 1}`);
  });
});
