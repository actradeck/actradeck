/**
 * INV-CHECK-STAMP-B1 (ADR 0015 §D6・B1)。
 *
 * CC hook (managed/attach) と managed Codex (app-server) の command 経路が、emit 時に check 分類を
 * closed enum (`check_kind`/`check_match`) として payload へ stamp することを固定する。exit_code は
 * 従来どおり両経路に存在 (CC=tool_response.exit_code / managed=item.exitCode)。これで fold の
 * session-global 束縛が実イベントで駆動される (rollout 経路は inv-rollout-verification-b1 で別途)。
 */
import { describe, expect, it } from "vitest";

import { normalizeHook, type HookCommonInput } from "../src/normalize.js";
import { normalizeCodexNotification, type CodexNormalizeContext } from "../src/normalize-codex.js";

const SID = "019a7bfb-9f7d-7bc3-b4a8-95fce7c4dbc4";

function hook(input: Partial<HookCommonInput> & { hook_event_name: string }): HookCommonInput {
  return { session_id: SID, ...input } as HookCommonInput;
}

describe("CC hook (§D6): command.started / command.completed に check 分類を stamp", () => {
  it("PreToolUse Bash `pnpm test` → command.started check_kind=test, check_match=script", () => {
    const evs = normalizeHook(
      hook({
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command: "pnpm test" },
        tool_use_id: "toolu_1",
      }),
    );
    const started = evs.find((e) => e.event_type === "command.started")!;
    expect(started).toBeDefined();
    expect((started.payload as { check_kind?: string }).check_kind).toBe("test");
    expect((started.payload as { check_match?: string }).check_match).toBe("script");
  });

  it("PostToolUse Bash `vitest run` + exit 0 → command.completed check_kind=test, exit_code=0", () => {
    const evs = normalizeHook(
      hook({
        hook_event_name: "PostToolUse",
        tool_name: "Bash",
        tool_input: { command: "vitest run" },
        tool_response: { exit_code: 0, stdout: "", stderr: "" },
        tool_use_id: "toolu_1",
      }),
    );
    const done = evs.find((e) => e.event_type === "command.completed")!;
    expect((done.payload as { check_kind?: string }).check_kind).toBe("test");
    expect((done.payload as { check_match?: string }).check_match).toBe("program");
    expect((done.payload as { exit_code?: number }).exit_code).toBe(0);
  });

  it("非 check コマンド (`git status`) は check_kind を持たない", () => {
    const started = normalizeHook(
      hook({
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command: "git status" },
        tool_use_id: "toolu_2",
      }),
    ).find((e) => e.event_type === "command.started")!;
    expect((started.payload as { check_kind?: string }).check_kind).toBeUndefined();
  });

  it("mutating 変種 (`eslint --fix`) は check 非認定 (started/completed とも check_kind 無し)", () => {
    const started = normalizeHook(
      hook({
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command: "eslint --fix ." },
        tool_use_id: "toolu_3",
      }),
    ).find((e) => e.event_type === "command.started")!;
    expect((started.payload as { check_kind?: string }).check_kind).toBeUndefined();
  });
});

describe("managed Codex (§D6): commandExecution item の check 分類 stamp", () => {
  const ctx: CodexNormalizeContext = { sessionId: SID };

  it("item/started commandExecution `eslint .` → command.started check_kind=lint", () => {
    const evs = normalizeCodexNotification(
      {
        method: "item/started",
        params: { item: { type: "commandExecution", command: "eslint .", id: "i1" } },
      },
      ctx,
    );
    const started = evs.find((e) => e.event_type === "command.started")!;
    expect((started.payload as { check_kind?: string }).check_kind).toBe("lint");
    expect((started.payload as { check_match?: string }).check_match).toBe("program");
  });

  it("item/completed commandExecution `eslint .` exit 0 → command.completed check_kind=lint, exit_code=0", () => {
    const evs = normalizeCodexNotification(
      {
        method: "item/completed",
        params: {
          item: {
            type: "commandExecution",
            command: "eslint .",
            status: "completed",
            exitCode: 0,
            id: "i1",
          },
        },
      },
      ctx,
    );
    const done = evs.find((e) => e.event_type === "command.completed")!;
    expect((done.payload as { check_kind?: string }).check_kind).toBe("lint");
    expect((done.payload as { exit_code?: number }).exit_code).toBe(0);
  });

  it("非 check コマンドは check_kind を持たない", () => {
    const done = normalizeCodexNotification(
      {
        method: "item/completed",
        params: {
          item: {
            type: "commandExecution",
            command: "cat foo",
            status: "completed",
            exitCode: 0,
            id: "i2",
          },
        },
      },
      ctx,
    ).find((e) => e.event_type === "command.completed")!;
    expect((done.payload as { check_kind?: string }).check_kind).toBeUndefined();
  });
});
