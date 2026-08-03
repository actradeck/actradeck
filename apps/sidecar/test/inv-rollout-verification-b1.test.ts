/**
 * INV-ROLLOUT-VERIFICATION-B1 (ADR 0015 §D5/§D6・B1)。
 *
 * Codex rollout の emit 側配線を実データ形状で固定する:
 *  - `extractRolloutExitCode`: 構造化 metadata.exit_code (legacy) + harness テキスト "Process exited
 *    with code N" (current) の両抽出。**spoof 耐性**: header ("Output:" マーカー前) 限定照合で、コマンド
 *    stdout が同フレーズを含んでも header の exit が勝つ。抽出不能 → undefined (受入 12)。
 *  - call_id 相関: exec_command (check) の分類を command.completed へ引き継ぐ (command 文字列は output 側に
 *    無いため)。update_plan ack の **de-orphan** (TDA-5): 相関ありのとき command.completed を出さない。
 *  - live verification: 実 rollout 形の (claim → diff → check pass) 列を normalizer→fold へ流し passed へ。
 *  - 実 rollout replay (REAL DATA・~/.codex 不在なら skip): 実ファイルで exit 抽出 + de-orphan が成立。
 *  - QA-5: P0 emitter は fidelity="authoritative" を一切 emit しない (契約テスト)。
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { NormalizedEvent } from "@actradeck/event-model";
import { reduceWorkItems } from "@actradeck/projection";

import {
  extractRolloutExitCode,
  normalizeRolloutLine,
  RolloutCallCorrelation,
  type CodexRolloutLine,
  type CodexRolloutNormalizeContext,
} from "../src/normalize-codex-rollout.js";

const SID = "019a7bfb-9f7d-7bc3-b4a8-95fce7c4dbc4";
const SOURCE = `rollout-2026-05-26T00-00-00-${SID}.jsonl`;

function ctx(correlation?: RolloutCallCorrelation, byteOffset = 0): CodexRolloutNormalizeContext {
  return { sessionId: SID, byteOffset, sourcePath: SOURCE, callCorrelation: correlation };
}

function execLine(cmd: string, callId: string, ts: string): CodexRolloutLine {
  return {
    type: "response_item",
    timestamp: ts,
    payload: {
      type: "function_call",
      name: "exec_command",
      arguments: JSON.stringify({ cmd, workdir: "/repo" }),
      call_id: callId,
    },
  } as CodexRolloutLine;
}

function outputLine(output: string, callId: string, ts: string): CodexRolloutLine {
  return {
    type: "response_item",
    timestamp: ts,
    payload: { type: "function_call_output", call_id: callId, output },
  } as CodexRolloutLine;
}

function updatePlanLine(
  plan: Array<{ step: string; status: string }>,
  callId: string,
  ts: string,
): CodexRolloutLine {
  return {
    type: "response_item",
    timestamp: ts,
    payload: {
      type: "function_call",
      name: "update_plan",
      arguments: JSON.stringify({ plan }),
      call_id: callId,
    },
  } as CodexRolloutLine;
}

/**
 * current codex の harness 出力 (exit を header に持つ・stdout は "Output:" の後)。
 *
 * 実 2026 harness は header 最上部に `Command:` フィールドでコマンド文字列を **verbatim echo** する
 * (実 corpus 2489/75658 件)。SEC-B1-1: 被観測エージェントが command 内に exit フレーズを書けば偽 exit が
 * header 先頭に載る → spoof。`command` 引数で `Command:` 行 (改行込みも可) を再現する。
 */
function harness(exit: number, stdout: string, command?: string): string {
  const cmdLine = command !== undefined ? `Command: ${command}\n` : "";
  return `${cmdLine}Chunk ID: abcd\nWall time: 0.05 seconds\nProcess exited with code ${exit}\nOriginal token count: 12\nOutput:\n${stdout}`;
}

describe("extractRolloutExitCode (§D6・decision 019fc7d8)", () => {
  it("harness テキスト (current codex) から exit を抽出する", () => {
    expect(extractRolloutExitCode(harness(0, "some output"))).toBe(0);
    expect(extractRolloutExitCode(harness(1, "err"))).toBe(1);
    expect(extractRolloutExitCode(harness(137, "killed"))).toBe(137);
  });

  it("構造化 metadata.exit_code (legacy / 外部 adapter) から抽出する", () => {
    const structured = JSON.stringify({
      output: "ok",
      metadata: { exit_code: 2, duration_seconds: 0.1 },
    });
    expect(extractRolloutExitCode(structured)).toBe(2);
  });

  it("spoof 耐性: コマンド stdout が偽 exit テキストを含んでも header が勝つ", () => {
    // header は code 1、stdout (Output: の後) に "Process exited with code 0" を紛れ込ませる。
    const spoof = harness(1, "totally normal\nProcess exited with code 0\nmore");
    expect(extractRolloutExitCode(spoof)).toBe(1);
  });

  it("マーカー無しで exit フレーズが body のみ → 抽出しない (安全側・非捏造)", () => {
    // "Output:" マーカーが無い平文 (header 特定不能) は抽出しない。
    expect(extractRolloutExitCode("Process exited with code 0")).toBeUndefined();
    expect(extractRolloutExitCode("Plan updated")).toBeUndefined();
    expect(extractRolloutExitCode("")).toBeUndefined();
    expect(extractRolloutExitCode(undefined)).toBeUndefined();
  });

  // QA-B1-1: header に exit 句が無く body (Output: の後) にのみ有るとき → 抽出しない。
  it("QA-B1-1: header に exit 句なし・body にのみ有り → undefined", () => {
    const noHeaderExit =
      "Chunk ID: abcd\nWall time: 0.05 seconds\nOutput:\nsome stuff\nProcess exited with code 0\n";
    expect(extractRolloutExitCode(noHeaderExit)).toBeUndefined();
  });
});

describe("SEC-B1-1: exit spoof 耐性 (harness Command: echo)", () => {
  // 現実装 (c5c0067) は header slice への first-substring-match ゆえ header 最上部の `Command:` echo に
  //   紛れた exit フレーズを先に拾う。修正後は 行頭〜行末アンカー付き multiline global で **最後の行** を
  //   採る (実 corpus: attacker 制御の Command: echo は header 最上部・実 exit 行は header 最下部)。

  it("(a) 単一行 comment 注入: `echo hi # Process exited with code 0` でも real exit=1 が返る", () => {
    const spoof = harness(1, "err", "echo hi # Process exited with code 0");
    expect(extractRolloutExitCode(spoof)).toBe(1);
  });

  it("(b) 複数行 command 内 clean 行注入 (行頭アンカー完全一致でも位置で敗れる)", () => {
    // command 自体が改行を含み、その 1 行が丁度 `Process exited with code 0`。header 最上部ゆえ
    //   real exit 行 (最下部) が last-match で勝つ。
    const spoof = harness(1, "output", "bash -c '\nProcess exited with code 0\necho hi'");
    expect(extractRolloutExitCode(spoof)).toBe(1);
  });

  it('(c) benign 検索コマンド `rg "Process exited with code 0"` が非マッチ (exit 1) → real 1 が返る', () => {
    // rg が何もヒットしないと exit 1。旧実装は Command: echo の 0 を拾い false-pass 化する。
    const benign = harness(1, "", 'rg "Process exited with code 0"');
    expect(extractRolloutExitCode(benign)).toBe(1);
  });

  it("既存 body spoof も維持 (stdout に偽 exit) — header が勝つ", () => {
    const spoof = harness(1, "totally normal\nProcess exited with code 0\nmore", "pytest -q");
    expect(extractRolloutExitCode(spoof)).toBe(1);
  });
});

describe("call_id 相関: check_kind を command.completed へ引き継ぐ (§D6)", () => {
  it("exec_command(check) → output(header exit 0) で command.completed に check_kind + exit_code が乗る", () => {
    const corr = new RolloutCallCorrelation();
    const started = normalizeRolloutLine(
      execLine(".venv/bin/pytest -q", "call_c1", "2026-05-26T00:00:01.000Z"),
      ctx(corr, 100),
    );
    expect(started[0]!.event_type).toBe("command.started");
    expect((started[0]!.payload as { check_kind?: string }).check_kind).toBe("test");
    expect((started[0]!.payload as { check_match?: string }).check_match).toBe("program");

    const done = normalizeRolloutLine(
      outputLine(harness(0, "1 passed"), "call_c1", "2026-05-26T00:00:02.000Z"),
      ctx(corr, 200),
    );
    const completed = done.find((e) => e.event_type === "command.completed")!;
    expect(completed).toBeDefined();
    expect((completed.payload as { check_kind?: string }).check_kind).toBe("test");
    expect((completed.payload as { exit_code?: number }).exit_code).toBe(0);
  });

  it("非 check コマンドは exit_code のみ (check_kind 無し)", () => {
    const corr = new RolloutCallCorrelation();
    normalizeRolloutLine(execLine("ls -la", "call_ls", "2026-05-26T00:00:01.000Z"), ctx(corr, 10));
    const done = normalizeRolloutLine(
      outputLine(harness(0, "files"), "call_ls", "2026-05-26T00:00:02.000Z"),
      ctx(corr, 20),
    );
    const completed = done.find((e) => e.event_type === "command.completed")!;
    expect((completed.payload as { exit_code?: number }).exit_code).toBe(0);
    expect((completed.payload as { check_kind?: string }).check_kind).toBeUndefined();
  });

  it("SEC-B1-1 二次面: 非 shell-exec function_call (check 様 query) は check 分類しない", () => {
    // exec_command/shell 系でない tool (MCP 様) の args.query に check 語彙が入っても command.started に
    //   check_kind を載せない (誤分類による偽検証を防ぐ・item 3 gate)。
    const line = {
      type: "response_item",
      timestamp: "2026-05-26T00:00:01.000Z",
      payload: {
        type: "function_call",
        name: "note_search",
        arguments: JSON.stringify({ query: "pytest -q run the tests" }),
        call_id: "call_ns",
      },
    } as CodexRolloutLine;
    const started = normalizeRolloutLine(line, ctx(new RolloutCallCorrelation(), 5));
    expect(started[0]!.event_type).toBe("command.started");
    expect((started[0]!.payload as { check_kind?: string }).check_kind).toBeUndefined();
  });

  it("shell_command (実 corpus の shell exec 名) は check 分類する", () => {
    const line = {
      type: "response_item",
      timestamp: "2026-05-26T00:00:01.000Z",
      payload: {
        type: "function_call",
        name: "shell_command",
        arguments: JSON.stringify({ command: "eslint .", workdir: "/repo" }),
        call_id: "call_sc",
      },
    } as CodexRolloutLine;
    const started = normalizeRolloutLine(line, ctx(new RolloutCallCorrelation(), 5));
    expect((started[0]!.payload as { check_kind?: string }).check_kind).toBe("lint");
  });

  it("相関喪失 (correlation 未提供) → check_kind は乗らず bare command.completed (安全側縮退)", () => {
    const done = normalizeRolloutLine(
      outputLine(harness(0, "x"), "call_z", "2026-05-26T00:00:02.000Z"),
      ctx(undefined, 20),
    );
    const completed = done.find((e) => e.event_type === "command.completed")!;
    expect(completed).toBeDefined();
    expect((completed.payload as { check_kind?: string }).check_kind).toBeUndefined();
    // exit 抽出自体は correlation 非依存ゆえ乗る。
    expect((completed.payload as { exit_code?: number }).exit_code).toBe(0);
  });
});

describe("TDA-5: update_plan ack の de-orphan", () => {
  it("相関ありのとき update_plan の function_call_output は command.completed を出さない", () => {
    const corr = new RolloutCallCorrelation();
    const plan = normalizeRolloutLine(
      updatePlanLine(
        [{ step: "do x", status: "completed" }],
        "call_up",
        "2026-05-26T00:00:01.000Z",
      ),
      ctx(corr, 100),
    );
    expect(plan[0]!.event_type).toBe("turn.plan.updated");
    const ack = normalizeRolloutLine(
      outputLine("Plan updated", "call_up", "2026-05-26T00:00:02.000Z"),
      ctx(corr, 200),
    );
    expect(ack.length).toBe(0); // de-orphan: command.completed も output.delta も出さない。
    expect(ack.some((e) => e.event_type === "command.completed")).toBe(false);
  });

  it("相関喪失時は従来どおり bare command.completed (check_kind 無しゆえ fold 無反応・A2 pin と同性質)", () => {
    const ack = normalizeRolloutLine(
      outputLine("Plan updated", "call_up", "2026-05-26T00:00:02.000Z"),
      ctx(undefined, 200),
    );
    const completed = ack.find((e) => e.event_type === "command.completed");
    expect(completed).toBeDefined();
    expect((completed!.payload as { check_kind?: string }).check_kind).toBeUndefined();
  });
});

describe("live verification (§D5): 実 rollout 形の claim→diff→check pass 列が fold で passed へ", () => {
  it("update_plan(completed) → diff → pytest check(exit 0) ⇒ 該当 plan item が passed", () => {
    const corr = new RolloutCallCorrelation();
    const lines: CodexRolloutLine[] = [
      updatePlanLine(
        [{ step: "implement feature", status: "completed" }],
        "call_p",
        "2026-05-26T00:00:01.000Z",
      ),
      // rollout の diff は patch_apply_end 由来 (diff_hash あり・head_sha 無し → fingerprint は diff_hash-only)。
      {
        type: "event_msg",
        timestamp: "2026-05-26T00:00:02.000Z",
        payload: {
          type: "patch_apply_end",
          changes: { "a.py": { added: 1 } },
          success: true,
          status: "completed",
        },
      } as CodexRolloutLine,
      execLine(".venv/bin/pytest -q", "call_t", "2026-05-26T00:00:03.000Z"),
      outputLine(harness(0, "1 passed"), "call_t", "2026-05-26T00:00:04.000Z"),
    ];
    const events: NormalizedEvent[] = [];
    let off = 0;
    for (const l of lines) events.push(...normalizeRolloutLine(l, ctx(corr, (off += 100))));

    const proj = reduceWorkItems(SID, events);
    const item = proj.items.find((i) => i.status === "completed");
    expect(item).toBeDefined();
    expect(item!.verification_state).toBe("passed");
    expect(item!.verified_tree_fp).toBeDefined();
    expect(item!.check_kind).toBe("test");
    expect(item!.check_exit_code).toBe(0);
  });

  it("check fail (exit 1) ⇒ failed", () => {
    const corr = new RolloutCallCorrelation();
    const lines: CodexRolloutLine[] = [
      updatePlanLine(
        [{ step: "implement", status: "completed" }],
        "call_p",
        "2026-05-26T00:00:01.000Z",
      ),
      execLine("eslint .", "call_l", "2026-05-26T00:00:03.000Z"),
      outputLine(harness(1, "problems"), "call_l", "2026-05-26T00:00:04.000Z"),
    ];
    const events: NormalizedEvent[] = [];
    let off = 0;
    for (const l of lines) events.push(...normalizeRolloutLine(l, ctx(corr, (off += 100))));
    const proj = reduceWorkItems(SID, events);
    const item = proj.items.find((i) => i.status === "completed")!;
    expect(item.verification_state).toBe("failed");
    expect(item.check_kind).toBe("lint");
  });

  it("受入 12: exit 抽出不能 (マーカー無し output) ⇒ verification_state 不動 (unverified)", () => {
    const corr = new RolloutCallCorrelation();
    const lines: CodexRolloutLine[] = [
      updatePlanLine(
        [{ step: "implement", status: "completed" }],
        "call_p",
        "2026-05-26T00:00:01.000Z",
      ),
      {
        type: "event_msg",
        timestamp: "2026-05-26T00:00:02.000Z",
        payload: { type: "patch_apply_end", changes: { "a.py": {} }, success: true },
      } as CodexRolloutLine,
      execLine(".venv/bin/pytest -q", "call_t", "2026-05-26T00:00:03.000Z"),
      // header/Output: マーカーの無い平文 → exit 抽出不能。
      outputLine("pytest ran but no harness marker", "call_t", "2026-05-26T00:00:04.000Z"),
    ];
    const events: NormalizedEvent[] = [];
    let off = 0;
    for (const l of lines) events.push(...normalizeRolloutLine(l, ctx(corr, (off += 100))));
    const proj = reduceWorkItems(SID, events);
    const item = proj.items.find((i) => i.status === "completed")!;
    // check は observed (started 側に check_kind) だが exit 不明 → 遷移させない。
    expect(item.verification_state).toBe("unverified");
  });
});

describe("QA-5: P0 emitter は fidelity=authoritative を一切 emit しない (契約)", () => {
  it("合成 rollout イベント群に authoritative fidelity が現れない", () => {
    const corr = new RolloutCallCorrelation();
    const lines: CodexRolloutLine[] = [
      updatePlanLine([{ step: "s", status: "completed" }], "call_p", "2026-05-26T00:00:01.000Z"),
      execLine(".venv/bin/pytest -q", "call_t", "2026-05-26T00:00:03.000Z"),
      outputLine(harness(0, "ok"), "call_t", "2026-05-26T00:00:04.000Z"),
    ];
    const events: NormalizedEvent[] = [];
    let off = 0;
    for (const l of lines) events.push(...normalizeRolloutLine(l, ctx(corr, (off += 100))));
    for (const e of events) {
      const obs = (e.payload as { observation?: { fidelity?: string } }).observation;
      expect(obs?.fidelity).not.toBe("authoritative");
    }
  });
});

// ── REAL DATA replay (~/.codex 不在なら skip・never-run-ci-latent-failures) ───────────────────
const REAL_FILE = join(
  homedir(),
  ".codex/sessions/2026/05/26/rollout-2026-05-26T22-36-36-019e6480-6468-7542-a73d-895404359d8f.jsonl",
);
const hasReal = existsSync(REAL_FILE);

describe.runIf(hasReal)(
  "REAL DATA replay: 実 rollout での exit 抽出 + de-orphan + authoritative 不在",
  () => {
    it("実ファイルを normalizer(相関) で replay: exit 抽出成立・update_plan ack は de-orphan・authoritative 無し", () => {
      const corr = new RolloutCallCorrelation();
      const raw = readFileSync(REAL_FILE, "utf8")
        .split("\n")
        .filter((l) => l.trim().length > 0);
      const events: NormalizedEvent[] = [];
      // update_plan の call_id を先に集めておき、その ack から command.completed が出ないことを検証する。
      const updatePlanCallIds = new Set<string>();
      let byteOffset = 0;
      for (const rawLine of raw) {
        const size = Buffer.byteLength(rawLine, "utf8") + 1;
        let line: CodexRolloutLine;
        try {
          line = JSON.parse(rawLine) as CodexRolloutLine;
        } catch {
          byteOffset += size;
          continue;
        }
        const p = (line.payload ?? {}) as Record<string, unknown>;
        if (
          p.type === "function_call" &&
          p.name === "update_plan" &&
          typeof p.call_id === "string"
        ) {
          updatePlanCallIds.add(p.call_id);
        }
        events.push(...normalizeRolloutLine(line, ctx(corr, byteOffset)));
        byteOffset += size;
      }

      // exit 抽出が実データで成立する (harness テキスト経路)。
      const withExit = events.filter(
        (e) =>
          e.event_type === "command.completed" &&
          typeof (e.payload as { exit_code?: unknown }).exit_code === "number",
      );
      expect(withExit.length).toBeGreaterThan(0);

      // de-orphan: update_plan の call_id を request_id に持つ command.completed は 1 件も出ない。
      const orphanAcks = events.filter(
        (e) =>
          e.event_type === "command.completed" &&
          typeof (e.payload as { request_id?: unknown }).request_id === "string" &&
          updatePlanCallIds.has((e.payload as { request_id: string }).request_id),
      );
      expect(orphanAcks.length).toBe(0);

      // QA-5: 実データ replay 全体で authoritative fidelity は出ない。
      for (const e of events) {
        const obs = (e.payload as { observation?: { fidelity?: string } }).observation;
        expect(obs?.fidelity).not.toBe("authoritative");
      }

      // 観測ログ (REAL DATA 実測値の可視化・アサートは上の不変条件が担保)。
      const checks = events.filter(
        (e) =>
          e.event_type === "command.completed" &&
          typeof (e.payload as { check_kind?: unknown }).check_kind === "string",
      );
      console.log(
        `[REAL replay] events=${events.length} command.completed+exit=${withExit.length} check-classified=${checks.length} update_plan_calls=${updatePlanCallIds.size}`,
      );
    });
  },
);
