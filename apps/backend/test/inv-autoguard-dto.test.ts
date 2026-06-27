/**
 * INV-AUTOGUARD-DTO (ADR 019ecc70 D3 段階1 下流) — backend pending_approvals jsonb → DTO 投影。
 *
 * session_state.pending_approvals jsonb (sidecar redaction 済 at-rest) → realtime-store
 * parsePendingApprovals → SessionDetail / SessionApprovals DTO への透過を偽 Pool で固定する。
 *
 * backend は **再 redaction しない** (sidecar choke 単一)。ただし closed-enum 防御 (= 未知 trigger /
 * 未知 kind / raw の drop) を read 層にも対称適用する。これは再 redaction ではなく allow-list 投影。
 *
 * **件数/語彙のみ**。raw secret は DTO に出ない (INV-AUTOGUARD-NO-RAW を read 層で再固定)。
 */
import { describe, expect, it } from "vitest";

import { RealtimeStore } from "../src/realtime-store.js";
import type { Pool } from "pg";

interface FakeRow {
  session_id: string;
  provider: string;
  source: string;
  agent_id: string | null;
  repo: string | null;
  branch: string | null;
  cwd: string | null;
  capture_mode: string | null;
  permission_mode: string | null;
  state: string | null;
  current_action: string | null;
  last_event_id: string | null;
  last_event_at: Date | null;
  needs_attention: boolean;
  liveness: Record<string, unknown> | null;
  pending_approvals: unknown;
  secret_detected: boolean | null;
  secret_redaction_count: number | null;
  secret_redaction_count_by_kind: unknown;
}

function row(over: Partial<FakeRow> & { session_id: string }): FakeRow {
  return {
    provider: "claude_code",
    source: "hooks",
    agent_id: null,
    repo: null,
    branch: null,
    cwd: null,
    capture_mode: null,
    permission_mode: null,
    state: "waiting.approval",
    current_action: null,
    last_event_id: "e1",
    last_event_at: new Date("2026-06-15T00:00:00.000Z"),
    needs_attention: true,
    liveness: { state: "idle", stalled_suspected: false },
    pending_approvals: [],
    secret_detected: null,
    secret_redaction_count: null,
    secret_redaction_count_by_kind: null,
    ...over,
  };
}

/** isLive 注入なしで detail を取得すると connected=false 既定だが detail 本体は返る。 */
function fakePool(rows: FakeRow[]): Pool {
  return {
    query: async (sql: string, params?: unknown[]) => {
      // approvalsSnapshot は jsonb_array_length WHERE を使う (params 無し)。それ以外は session_id filter。
      if (sql.includes("jsonb_array_length")) return { rows };
      if (params && params.length > 0 && typeof params[0] === "string") {
        return { rows: rows.filter((r) => r.session_id === params[0]) };
      }
      return { rows };
    },
  } as unknown as Pool;
}

describe("INV-AUTOGUARD-DTO: pending_approvals の trigger/secret_kinds を DTO へ投影", () => {
  it("trigger=secret / secret_kinds=[github-token] を SessionDetail へ透過する", async () => {
    const store = new RealtimeStore(
      fakePool([
        row({
          session_id: "s1",
          pending_approvals: [
            {
              request_id: "s1:apr-g",
              tool_name: "Bash",
              command: "echo $GITHUB_TOKEN",
              risk_level: "high",
              requested_at: "2026-06-15T00:00:00.000Z",
              session_id: "s1",
              trigger: "secret",
              secret_kinds: ["github-token"],
            },
          ],
        }),
      ]),
    );
    const detail = await store.detail("s1");
    expect(detail?.pending_approvals).toHaveLength(1);
    const p = detail!.pending_approvals[0]!;
    expect(p.trigger).toBe("secret");
    expect(p.secret_kinds).toEqual(["github-token"]);
  });

  it("destructive のみは trigger=destructive / secret_kinds=undefined", async () => {
    const store = new RealtimeStore(
      fakePool([
        row({
          session_id: "s1",
          pending_approvals: [
            {
              request_id: "s1:apr-d",
              tool_name: "Bash",
              command: "rm -rf /tmp/x",
              risk_level: "high",
              requested_at: "2026-06-15T00:00:00.000Z",
              session_id: "s1",
              trigger: "destructive",
            },
          ],
        }),
      ]),
    );
    const detail = await store.detail("s1");
    const p = detail!.pending_approvals[0]!;
    expect(p.trigger).toBe("destructive");
    expect(p.secret_kinds).toBeUndefined();
  });

  it("旧行 (trigger/secret_kinds 欠落) は両方 undefined (後方互換)", async () => {
    const store = new RealtimeStore(
      fakePool([
        row({
          session_id: "s1",
          pending_approvals: [
            {
              request_id: "s1:apr-legacy",
              tool_name: "Bash",
              command: "make build",
              requested_at: "2026-06-15T00:00:00.000Z",
              session_id: "s1",
            },
          ],
        }),
      ]),
    );
    const detail = await store.detail("s1");
    const p = detail!.pending_approvals[0]!;
    expect(p.trigger).toBeUndefined();
    expect(p.secret_kinds).toBeUndefined();
    // 行は黙殺しない。
    expect(p.request_id).toBe("s1:apr-legacy");
  });

  it("crafted jsonb の raw/未知 (ghp_xxx / phantom / 未知 trigger) は read 層で drop", async () => {
    const store = new RealtimeStore(
      fakePool([
        row({
          session_id: "s1",
          pending_approvals: [
            {
              request_id: "s1:apr-x",
              tool_name: "Bash",
              requested_at: "2026-06-15T00:00:00.000Z",
              session_id: "s1",
              trigger: "secret",
              secret_kinds: ["ghp_FAKErawtoken00000000000000000000000", "github-token", "phantom"],
            },
            {
              request_id: "s1:apr-y",
              tool_name: "Bash",
              requested_at: "2026-06-15T00:00:01.000Z",
              session_id: "s1",
              trigger: "totally-bogus",
              secret_kinds: ["nope"],
            },
          ],
        }),
      ]),
    );
    const detail = await store.detail("s1");
    expect(detail?.pending_approvals).toHaveLength(2);
    const [a, b] = detail!.pending_approvals;
    expect(a!.secret_kinds).toEqual(["github-token"]);
    expect(b!.trigger).toBeUndefined();
    expect(b!.secret_kinds).toBeUndefined();
    // raw secret は DTO の文字列化に一切現れない (no-raw・read 層対称防御)。
    expect(JSON.stringify(detail!.pending_approvals)).not.toContain("ghp_");
  });

  it("Approval Inbox 集約 (approvalsSnapshot) も trigger/secret_kinds を運び raw を drop する", async () => {
    const store = new RealtimeStore(
      fakePool([
        row({
          session_id: "s1",
          pending_approvals: [
            {
              request_id: "s1:apr-g",
              tool_name: "Bash",
              requested_at: "2026-06-15T00:00:00.000Z",
              session_id: "s1",
              trigger: "both",
              secret_kinds: ["github-token", "ghp_FAKEraw0000000000000000000000000000"],
            },
          ],
        }),
      ]),
    );
    // 集約は connected (isLive=true) のみ返す。
    const approvals = await store.approvalsSnapshot(() => true);
    expect(approvals).toHaveLength(1);
    const p = approvals[0]!.pending_approvals[0]!;
    expect(p.trigger).toBe("both");
    expect(p.secret_kinds).toEqual(["github-token"]);
    expect(JSON.stringify(approvals)).not.toContain("ghp_");
  });
});
