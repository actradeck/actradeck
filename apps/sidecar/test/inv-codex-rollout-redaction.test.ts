import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { CodexRolloutTailer } from "../src/codex-rollout-tailer.js";
import { normalizeRolloutLine, type CodexRolloutLine } from "../src/normalize-codex-rollout.js";
import { EventSink } from "../src/sink.js";
import { EventStore } from "../src/store.js";
import type { WsClient } from "../src/ws-client.js";

const SESSION = "019ed895-6f24-70d2-b4b4-35bdcafb06ad";
const GH_TOKEN = `ghp_${"RolloutFakeToken".padEnd(36, "x")}`;
const AWS_KEY = "AKIAIOSFODNN7EXAMPLE";
const OPENAI_KEY = "sk-proj-fakeOnlyNotReal012345678901234567890123456789";

function fakeWs(): WsClient {
  return { notifyAppended: () => {} } as unknown as WsClient;
}

function makeSink(store = new EventStore(":memory:")) {
  const sink = new EventSink({ store, wsClient: fakeWs() });
  return { sink, store };
}

function emitFixture(sink: EventSink, line: CodexRolloutLine, byteOffset = 64): void {
  const events = normalizeRolloutLine(line, {
    sessionId: SESSION,
    cwd: "/repo",
    byteOffset,
    sourcePath: `/tmp/rollout-2026-06-18T11-35-32-${SESSION}.jsonl`,
  });
  for (const event of events) sink.emit(event);
}

describe("INV-CODEX-ROLLOUT-REDACTION: rollout raw content only persists via sink redactor", () => {
  let tmp: string | undefined;

  afterEach(() => {
    if (tmp !== undefined) rmSync(tmp, { recursive: true, force: true });
    tmp = undefined;
  });

  it("redacts synthetic secrets from rollout command output before SQLite persistence", () => {
    const { sink, store } = makeSink();
    emitFixture(sink, {
      type: "response_item",
      timestamp: "2026-06-18T03:10:00.000Z",
      payload: {
        type: "function_call_output",
        call_id: "call_secret",
        output: `do not store ${GH_TOKEN} ${AWS_KEY} ${OPENAI_KEY}`,
      },
    });

    const joined = store
      .allRows()
      .map((r) => r.event_json)
      .join("\n");
    expect(joined).not.toContain(GH_TOKEN);
    expect(joined).not.toContain(AWS_KEY);
    expect(joined).not.toContain(OPENAI_KEY);
    expect(joined).toContain("[REDACTED:github-token]");
    expect(joined).toContain("[REDACTED:aws-access-key-id]");
    expect(joined).toContain("[REDACTED:openai-key]");

    const parsed = store
      .allRows()
      .map((r) => JSON.parse(r.event_json) as { redaction_count?: number });
    expect(parsed.some((e) => (e.redaction_count ?? 0) > 0)).toBe(true);
    store.close();
  });

  it("is idempotent when the same rollout line is emitted twice", () => {
    const { sink, store } = makeSink();
    const line: CodexRolloutLine = {
      type: "response_item",
      timestamp: "2026-06-18T03:11:00.000Z",
      payload: { type: "function_call_output", call_id: "call_dup", output: "same output" },
    };

    emitFixture(sink, line, 777);
    const firstIds = store.allRows().map((r) => r.event_id);
    emitFixture(sink, line, 777);
    const secondIds = store.allRows().map((r) => r.event_id);

    expect(secondIds).toEqual(firstIds);
    expect(store.totalCount()).toBe(firstIds.length);
    store.close();
  });

  it("tailer persists byte offsets and stable event_id prevents duplicate ingest on backfill replay", async () => {
    tmp = mkdtempSync(join(tmpdir(), "actradeck-codex-rollout-"));
    const codexHome = join(tmp, "codex");
    const sessionDir = join(codexHome, "sessions", "2026", "06", "18");
    const file = join(sessionDir, `rollout-2026-06-18T11-35-32-${SESSION}.jsonl`);
    const stateA = join(tmp, "offsets-a.json");
    const stateB = join(tmp, "offsets-b.json");
    const db = join(tmp, "sidecar.db");
    rmSync(sessionDir, { recursive: true, force: true });
    mkdirSync(sessionDir, { recursive: true });

    const lines: CodexRolloutLine[] = [
      {
        type: "session_meta",
        timestamp: "2026-06-18T03:12:00.000Z",
        payload: { id: SESSION, cwd: "/repo", source: "tui" },
      },
      {
        type: "response_item",
        timestamp: "2026-06-18T03:12:01.000Z",
        payload: {
          type: "function_call_output",
          call_id: "call_tail",
          output: `tail ${GH_TOKEN}`,
        },
      },
    ];
    writeFileSync(file, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);

    const store = new EventStore(db);
    const sink = new EventSink({ store, wsClient: fakeWs() });
    const runTailer = async (statePath: string): Promise<void> => {
      const tailer = new CodexRolloutTailer({
        codexHome,
        statePath,
        backfill: true,
        pollIntervalMs: 10_000,
        onEvents: (events) => {
          for (const event of events) sink.emit(event);
        },
      });
      await tailer.scanOnce({ initial: true });
    };

    await runTailer(stateA);
    const countAfterFirst = store.totalCount();
    const idsAfterFirst = store.allRows().map((r) => r.event_id);
    expect(countAfterFirst).toBeGreaterThan(0);

    await runTailer(stateB);
    expect(store.totalCount()).toBe(countAfterFirst);
    expect(store.allRows().map((r) => r.event_id)).toEqual(idsAfterFirst);

    const joined = store
      .allRows()
      .map((r) => r.event_json)
      .join("\n");
    expect(joined).not.toContain(GH_TOKEN);
    expect(joined).toContain("[REDACTED:github-token]");
    store.close();
  });
});

/**
 * INV-CODEX-ROLLOUT-LINEAGE-REDACTION (ADR 0014 Phase 3b-2・裁定 019fc4c6 SEC-1):
 * rollout ファイル制御の文字列 (session_meta.payload.{session_id, forked_from_id, parent_thread_id})
 * が redaction の correlation allowlist フィールド (provider_session_id / resumed_from_session_id)
 * へ流れる新経路の回帰 pin。防御は redactor の depth-0 shape gate (isCorrelationKeyValue):
 * secret 形は mask・正当 uuid は keep。この配線を落とす refactor を SQLite 保存形で検出する。
 */
describe("INV-CODEX-ROLLOUT-LINEAGE-REDACTION: secret-shaped lineage ids never persist raw", () => {
  const RUN_A = "019f6637-96c4-74f2-91e9-b3b208762cd9";
  const RUN_B = "019f6641-2002-72d1-9b61-1918cfa469a4";
  const STABLE_B = "019f4f85-ec41-7e80-8e8d-857897d73b51";
  const PARENT_B = "019df343-2222-70d2-b4b4-35bdcafb06ad";

  let tmp: string | undefined;

  afterEach(() => {
    if (tmp !== undefined) rmSync(tmp, { recursive: true, force: true });
    tmp = undefined;
  });

  function writeRollout(
    run: string,
    metaPayload: Record<string, unknown>,
  ): {
    codexHome: string;
    statePath: string;
  } {
    tmp = mkdtempSync(join(tmpdir(), "actradeck-lineage-redact-"));
    const codexHome = join(tmp, "codex");
    const sessionDir = join(codexHome, "sessions", "2026", "06", "18");
    mkdirSync(sessionDir, { recursive: true });
    const meta = JSON.stringify({
      type: "session_meta",
      timestamp: "2026-06-18T03:00:00.000Z",
      payload: { id: run, cwd: "/repo", source: "tui", ...metaPayload },
    });
    const agent = JSON.stringify({
      type: "event_msg",
      timestamp: "2026-06-18T03:00:01.000Z",
      payload: { type: "agent_message", message: "hello" },
    });
    writeFileSync(
      join(sessionDir, `rollout-2026-06-18T11-35-32-${run}.jsonl`),
      `${[meta, agent].join("\n")}\n`,
    );
    return { codexHome, statePath: join(tmp, "offsets.json") };
  }

  async function tailInto(sink: EventSink, codexHome: string, statePath: string): Promise<void> {
    const tailer = new CodexRolloutTailer({
      codexHome,
      statePath,
      backfill: true,
      pollIntervalMs: 10_000,
      onEvents: (events) => {
        for (const event of events) sink.emit(event);
      },
    });
    await tailer.scanOnce({ initial: true });
  }

  it("masks secret-shaped session_id / forked_from_id / parent_thread_id from a malicious session_meta [SEC-1]", async () => {
    const { sink, store } = makeSink();
    const { codexHome, statePath } = writeRollout(RUN_A, {
      session_id: OPENAI_KEY, // → provider_session_id (correlation allowlist・depth-0)
      forked_from_id: GH_TOKEN, // → resumed_from_session_id (correlation allowlist・depth-0)
      parent_thread_id: AWS_KEY, // → payload 内 (nested・allowlist 非適用・deep redaction)
    });
    await tailInto(sink, codexHome, statePath);

    const rows = store.allRows().map((r) => JSON.parse(r.event_json) as Record<string, unknown>);
    expect(rows.length).toBeGreaterThan(0);
    const joined = store
      .allRows()
      .map((r) => r.event_json)
      .join("\n");
    // raw secret はどの保存行にも残らない。
    expect(joined).not.toContain(OPENAI_KEY);
    expect(joined).not.toContain(GH_TOKEN);
    expect(joined).not.toContain(AWS_KEY);
    // shape gate: secret 形は correlation keep を通らず mask される。
    const started = rows.find((e) => e.event_type === "session.started");
    expect(started).toBeDefined();
    expect(started!.provider_session_id).toBe("[REDACTED:openai-key]");
    expect(started!.resumed_from_session_id).toBe("[REDACTED:github-token]");
    const payload = started!.payload as Record<string, unknown>;
    expect(payload.parent_thread_id).toBe("[REDACTED:aws-access-key-id]");
    // carry-forward: 後続イベントの provider_session_id も masked (raw で伝播しない)。
    const delta = rows.find((e) => e.event_type === "agent.message.delta");
    expect(delta).toBeDefined();
    expect(delta!.provider_session_id).toBe("[REDACTED:openai-key]");
    // fail-safe: event 自体は drop されず永続される (可用性を壊さない)。
    store.close();
  });

  it("keeps legit uuid-shaped lineage ids verbatim (no over-redaction, lineage intact) [SEC-1]", async () => {
    const { sink, store } = makeSink();
    const { codexHome, statePath } = writeRollout(RUN_B, {
      session_id: STABLE_B,
      forked_from_id: PARENT_B,
    });
    await tailInto(sink, codexHome, statePath);

    const rows = store.allRows().map((r) => JSON.parse(r.event_json) as Record<string, unknown>);
    const started = rows.find((e) => e.event_type === "session.started");
    expect(started).toBeDefined();
    expect(started!.provider_session_id).toBe(STABLE_B);
    expect(started!.resumed_from_session_id).toBe(PARENT_B);
    expect(started!.start_kind).toBe("resume");
    store.close();
  });
});
