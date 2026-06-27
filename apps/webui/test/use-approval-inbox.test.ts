/**
 * Approval Inbox 集約 pull の応答パーサ `parseApprovalsResponse` の不変条件 (QA-1)。
 *
 * 縛る性質 (falsifiable):
 *  - 寛容パース: request_id 欠落要素・session_id 欠落行のみ落とし、全黙殺しない
 *    (LIVE-FOUND-3 教訓 019e98fc)。
 *  - allow-list 限定: 要素の projection は canonical parsePendingApprovals に委譲し (TDA-1)、
 *    allow-list 7 キー以外の生フィールド (secret_env 等) を結果へ通さない。
 *  - parse 後空 (request_id 欠落要素のみ) の行は除外する。
 *  - 欠落 session_id を持つ要素は group の session_id を継承する。
 *  - envelope (provider 既定 "" / cwd 省略時 undefined) の整形。
 */
import { describe, expect, it } from "vitest";

import { parseApprovalsResponse } from "../src/ui/use-approval-inbox";

describe("parseApprovalsResponse (QA-1)", () => {
  it("非 object / approvals 非配列は空配列", () => {
    expect(parseApprovalsResponse(null)).toEqual([]);
    expect(parseApprovalsResponse("x")).toEqual([]);
    expect(parseApprovalsResponse({})).toEqual([]);
    expect(parseApprovalsResponse({ approvals: "nope" })).toEqual([]);
  });

  it("session_id 欠落の行は丸ごと落とす", () => {
    const out = parseApprovalsResponse({
      approvals: [{ pending_approvals: [{ request_id: "r1" }] }],
    });
    expect(out).toEqual([]);
  });

  it("request_id 欠落の要素だけ落とし、有効要素は残す (寛容)", () => {
    const out = parseApprovalsResponse({
      approvals: [
        {
          session_id: "s1",
          pending_approvals: [{ tool_name: "Bash" }, { request_id: "r1", command: "ls" }],
        },
      ],
    });
    expect(out).toHaveLength(1);
    expect(out[0]!.pending_approvals.map((p) => p.request_id)).toEqual(["r1"]);
  });

  it("非空 jsonb だが request_id 欠落要素のみの行は除外 (parse 後空)", () => {
    const out = parseApprovalsResponse({
      approvals: [
        { session_id: "s1", pending_approvals: [{ tool_name: "Bash" }, { command: "x" }] },
      ],
    });
    expect(out).toEqual([]);
  });

  it("allow-list 外の生フィールド (secret_env) は結果へ通さない", () => {
    const out = parseApprovalsResponse({
      approvals: [
        {
          session_id: "s1",
          pending_approvals: [
            {
              request_id: "r1",
              command: "export TOKEN=[REDACTED:github-token]",
              secret_env: "ghp_SHOULD_NOT_LEAK_0123456789",
            },
          ],
        },
      ],
    });
    const p = out[0]!.pending_approvals[0]!;
    // 自動ガード 段階1 (ADR 019ecc70 D3 / 下流 019ecc97): canonical parsePendingApprovals が
    // closed-enum 防御つきで 7→9→10 キーへ拡張 (trigger / secret_kinds / persistable)。leak ガードは
    // この allow-list 外の生フィールド (secret_env / raw) が通らないことを引き続き担保する。
    const ALLOW = new Set([
      "request_id",
      "tool_name",
      "command",
      "path",
      "risk_level",
      "requested_at",
      "session_id",
      "trigger",
      "secret_kinds",
      "persistable",
    ]);
    for (const k of Object.keys(p)) {
      expect(ALLOW.has(k), `non-allow-list field leaked: ${k}`).toBe(true);
    }
    expect(p).not.toHaveProperty("secret_env");
    expect(JSON.stringify(out)).not.toContain("ghp_");
    expect(JSON.stringify(out)).not.toContain("SHOULD_NOT_LEAK");
  });

  it("要素の session_id 欠落時は group の session_id を継承する", () => {
    const out = parseApprovalsResponse({
      approvals: [{ session_id: "grp-1", pending_approvals: [{ request_id: "r1" }] }],
    });
    expect(out[0]!.pending_approvals[0]!.session_id).toBe("grp-1");
  });

  it("要素が自前の session_id を持つ場合はそれを保持する", () => {
    const out = parseApprovalsResponse({
      approvals: [
        { session_id: "grp-1", pending_approvals: [{ request_id: "r1", session_id: "own" }] },
      ],
    });
    expect(out[0]!.pending_approvals[0]!.session_id).toBe("own");
  });

  it('provider 欠落は ""、cwd 欠落は undefined、cwd ありは保持', () => {
    const out = parseApprovalsResponse({
      approvals: [
        { session_id: "s1", pending_approvals: [{ request_id: "r1" }] },
        {
          session_id: "s2",
          provider: "codex",
          cwd: "/repo",
          pending_approvals: [{ request_id: "r2" }],
        },
      ],
    });
    expect(out[0]!.provider).toBe("");
    expect(out[0]!.cwd).toBeUndefined();
    expect(out[1]!.provider).toBe("codex");
    expect(out[1]!.cwd).toBe("/repo");
  });

  it("非文字列フィールドは undefined に倒れ、型外の値を載せない (canonical coercion)", () => {
    const out = parseApprovalsResponse({
      approvals: [
        {
          session_id: "s1",
          pending_approvals: [{ request_id: "r1", command: 123, risk_level: { x: 1 } }],
        },
      ],
    });
    const p = out[0]!.pending_approvals[0]!;
    expect(p.command).toBeUndefined();
    expect(p.risk_level).toBeUndefined();
    expect(p.requested_at).toBe("");
  });
});
