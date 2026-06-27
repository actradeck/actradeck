/**
 * INV-SECRET-DETECTED-PROJECTION (backend 投影部) — ADR 019ea4ba 段階2 / task 019ea4db.
 *
 * session_state.secret_detected / secret_redaction_count 列 → realtime-store JOIN_SELECT →
 * SessionDetail DTO への投影を偽 Pool で固定する (右ペイン secret_detected の出所)。
 * 寛容性: 欠落 (NULL = 旧行) はキーごと落とす (= undefined; optional・後方互換)。
 *
 * **件数/bool のみ**。秘匿値そのものは DTO に出ない (出所の NormalizedEvent.redaction_count が
 * redacted 件数ゆえ原文非依存)。projection key には使わない (表示専用)。
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
    state: "running.model_wait",
    current_action: null,
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

describe("INV-SECRET-DETECTED-PROJECTION: secret_detected 投影", () => {
  it("secret_detected=true / count を Detail へ投影する", async () => {
    const store = new RealtimeStore(
      fakePool([row({ session_id: "s1", secret_detected: true, secret_redaction_count: 3 })]),
    );
    const detail = await store.detail("s1");
    expect(detail?.secret_detected).toBe(true);
    expect(detail?.secret_redaction_count).toBe(3);
  });

  it("secret_detected=false / count=0 をそのまま投影する", async () => {
    const store = new RealtimeStore(
      fakePool([row({ session_id: "s1", secret_detected: false, secret_redaction_count: 0 })]),
    );
    const detail = await store.detail("s1");
    expect(detail?.secret_detected).toBe(false);
    expect(detail?.secret_redaction_count).toBe(0);
  });

  it("NULL (旧行) はキーを落とす (undefined; 後方互換)", async () => {
    const store = new RealtimeStore(
      fakePool([
        row({
          session_id: "s1",
          secret_detected: null,
          secret_redaction_count: null,
          secret_redaction_count_by_kind: null,
        }),
      ]),
    );
    const detail = await store.detail("s1");
    expect(detail).toBeDefined();
    expect(detail!.secret_detected).toBeUndefined();
    expect(detail!.secret_redaction_count).toBeUndefined();
    expect(detail!.secret_redaction_count_by_kind).toBeUndefined();
    // 欠落でも行自体は黙殺しない。
    expect(detail!.session_id).toBe("s1");
  });

  describe("強み(a)③: secret_redaction_count_by_kind の DTO 投影", () => {
    it("kind 別件数を Detail へ投影する", async () => {
      const store = new RealtimeStore(
        fakePool([
          row({
            session_id: "s1",
            secret_detected: true,
            secret_redaction_count: 3,
            secret_redaction_count_by_kind: { "github-token": 2, "aws-access-key-id": 1 },
          }),
        ]),
      );
      const detail = await store.detail("s1");
      expect(detail?.secret_redaction_count_by_kind).toEqual({
        "github-token": 2,
        "aws-access-key-id": 1,
      });
      // INV: sum(by_kind) === secret_redaction_count。
      const sum = Object.values(detail!.secret_redaction_count_by_kind!).reduce((a, b) => a + b, 0);
      expect(sum).toBe(detail!.secret_redaction_count);
    });

    it("空 {} はキーを落とす (undefined; UI は表示を控える)", async () => {
      const store = new RealtimeStore(
        fakePool([
          row({ session_id: "s1", secret_detected: false, secret_redaction_count_by_kind: {} }),
        ]),
      );
      const detail = await store.detail("s1");
      expect(detail!.secret_redaction_count_by_kind).toBeUndefined();
    });

    it("不正値 (負/非数) は弾き正常 kind のみ投影する", async () => {
      const store = new RealtimeStore(
        fakePool([
          row({
            session_id: "s1",
            secret_detected: true,
            secret_redaction_count_by_kind: { "github-token": 2, bad: -1, junk: "x" },
          }),
        ]),
      );
      const detail = await store.detail("s1");
      expect(detail!.secret_redaction_count_by_kind).toEqual({ "github-token": 2 });
    });
  });
});
