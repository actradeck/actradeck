/**
 * INV-CURRENT-ACTION-PROJECTION (backend 投影部) — 表示時ローカライズ / ADR 019eeac6.
 *
 * session_state.current_action_kind / current_action_subject 列 → realtime-store JOIN_SELECT →
 * SessionListItem / SessionDetail DTO への投影を偽 Pool で固定する (current_action の表示時 i18n の出所)。
 *  - kind は closed-enum gate (isActionKind): 未知値 / NULL はキーを落とす (forward-compat)。
 *  - subject は redacted な構造値ゆえそのまま投影 (NULL→キー落とし)。backend は再 redaction しない。
 *  - legacy current_action (summary) は保持 (DTO の後方互換 fallback)。
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
  current_action_kind: string | null;
  current_action_subject: string | null;
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
    state: "running.command_executing",
    current_action: null,
    current_action_kind: null,
    current_action_subject: null,
    last_event_id: "e1",
    last_event_at: new Date("2026-06-07T00:00:00.000Z"),
    needs_attention: false,
    liveness: { state: "idle", stalled_suspected: false },
    pending_approvals: [],
    secret_detected: null,
    secret_redaction_count: null,
    secret_redaction_count_by_kind: null,
    ...over,
  };
}

function fakePool(rows: FakeRow[]): Pool {
  return {
    query: async (_sql: string, params?: unknown[]) => {
      if (params && params.length > 0 && typeof params[0] === "string") {
        return { rows: rows.filter((r) => r.session_id === params[0]) };
      }
      return { rows };
    },
  } as unknown as Pool;
}

describe("INV-CURRENT-ACTION-PROJECTION: current_action_kind / current_action_subject 投影", () => {
  it("kind + subject を Detail と ListItem へ投影する (legacy current_action も保持)", async () => {
    const store = new RealtimeStore(
      fakePool([
        row({
          session_id: "s1",
          current_action: "コマンド実行: npm test", // legacy summary (日本語焼付け) は据置
          current_action_kind: "command",
          current_action_subject: "npm test",
        }),
      ]),
    );
    const detail = await store.detail("s1");
    expect(detail?.current_action_kind).toBe("command");
    expect(detail?.current_action_subject).toBe("npm test");
    expect(detail?.current_action).toBe("コマンド実行: npm test");

    const item = await store.listItem("s1");
    expect(item?.current_action_kind).toBe("command");
    expect(item?.current_action_subject).toBe("npm test");
  });

  it("NULL (旧行) はキーを落とす (undefined; 後方互換)", async () => {
    const store = new RealtimeStore(
      fakePool([
        row({ session_id: "s1", current_action_kind: null, current_action_subject: null }),
      ]),
    );
    const detail = await store.detail("s1");
    expect(detail).toBeDefined();
    expect(detail!.current_action_kind).toBeUndefined();
    expect(detail!.current_action_subject).toBeUndefined();
    expect(detail!.session_id).toBe("s1"); // 行自体は黙殺しない
  });

  it("未知 kind (crafted / forward-compat) は gate で落とす (closed-enum)", async () => {
    const store = new RealtimeStore(
      fakePool([
        row({
          session_id: "s1",
          current_action_kind: "totally-not-a-kind",
          current_action_subject: "x",
        }),
      ]),
    );
    const detail = await store.detail("s1");
    // kind は未知ゆえ落とす。subject (redacted 構造値) はそのまま残る。
    expect(detail!.current_action_kind).toBeUndefined();
    expect(detail!.current_action_subject).toBe("x");
  });

  it("subject は再 redaction せず redacted な値をそのまま投影する (marker 維持)", async () => {
    const store = new RealtimeStore(
      fakePool([
        row({
          session_id: "s1",
          current_action_kind: "command",
          current_action_subject: "export TOKEN=[REDACTED:github-token] && deploy",
        }),
      ]),
    );
    const detail = await store.detail("s1");
    expect(detail!.current_action_subject).toBe("export TOKEN=[REDACTED:github-token] && deploy");
  });
});
