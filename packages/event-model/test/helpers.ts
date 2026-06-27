/**
 * テスト用ヘルパ: 正当な NormalizedEvent を最小構成で生成する。
 * INV-EVENT-* テストが共有する。
 */
import { newEventId } from "../src/id.js";
import type { NormalizedEventInput } from "../src/event.js";

export function validEvent(overrides: Partial<NormalizedEventInput> = {}): NormalizedEventInput {
  return {
    event_id: newEventId(),
    provider: "claude_code",
    source: "hooks",
    session_id: "sess_test",
    event_type: "command.started",
    state: "running.command_executing",
    timestamp: "2026-05-30T12:34:56.789Z",
    cwd: "/repo",
    summary: "npm test を実行中",
    payload: { command: "npm test", cwd: "/repo", risk_level: "low" },
    metrics: { elapsed_ms: 0 },
    ...overrides,
  };
}
