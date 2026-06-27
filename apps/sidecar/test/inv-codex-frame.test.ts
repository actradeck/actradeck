/**
 * INV-CODEX-FRAME — line-delimited JSON parser 頑健性 (ADR 019ea31b (g)).
 *
 * 実バイナリ probe 確定: stdout は line-JSON (`{...}\n`)。1 read に複数 message 連結 /
 * 1 message が複数 read に分割 / 空行 / 不正 JSON 行が来てもプロセスを落とさず
 * (parser は throw しない)、正規 message のみ onMessage へ届くことを固定する。
 */
import { EventEmitter } from "node:events";

import { describe, expect, it } from "vitest";

import { CodexJsonRpc, type CodexInboundMessage } from "../src/codex-jsonrpc.js";

/** stdout を模す EventEmitter (data イベントで Buffer|string を流す)。 */
class FakeStdout extends EventEmitter {
  push(chunk: Buffer | string): void {
    this.emit("data", chunk);
  }
}

function harness() {
  const stdout = new FakeStdout();
  const written: string[] = [];
  const messages: CodexInboundMessage[] = [];
  const parseErrors: Array<{ line: string }> = [];
  const rpc = new CodexJsonRpc({
    stdin: { write: (c) => written.push(c) },
    stdout,
    onMessage: (m) => messages.push(m),
    onParseError: (line) => parseErrors.push({ line }),
  });
  return { stdout, written, messages, parseErrors, rpc };
}

describe("INV-CODEX-FRAME: robust line-JSON parsing", () => {
  it("single message terminated by \\n", () => {
    const h = harness();
    h.stdout.push(`{"id":1,"result":{"ok":true}}\n`);
    expect(h.messages.length).toBe(1);
    expect(h.messages[0]!.id).toBe(1);
  });

  it("multiple messages concatenated in one read", () => {
    const h = harness();
    h.stdout.push(`{"method":"a"}\n{"method":"b"}\n{"method":"c"}\n`);
    expect(h.messages.map((m) => m.method)).toEqual(["a", "b", "c"]);
  });

  it("one message split across multiple reads", () => {
    const h = harness();
    h.stdout.push(`{"meth`);
    h.stdout.push(`od":"thread/`);
    h.stdout.push(`started","params":{"thread":{"id":"T1"}}}\n`);
    expect(h.messages.length).toBe(1);
    expect(h.messages[0]!.method).toBe("thread/started");
  });

  it("trailing partial line is buffered until newline arrives", () => {
    const h = harness();
    h.stdout.push(`{"method":"x"}\n{"method":"y"}`); // y has no newline yet
    expect(h.messages.map((m) => m.method)).toEqual(["x"]);
    h.stdout.push(`\n`);
    expect(h.messages.map((m) => m.method)).toEqual(["x", "y"]);
  });

  it("empty lines and whitespace-only lines are skipped (no crash)", () => {
    const h = harness();
    h.stdout.push(`\n   \n{"method":"a"}\n\n`);
    expect(h.messages.map((m) => m.method)).toEqual(["a"]);
    expect(h.parseErrors.length).toBe(0);
  });

  it("malformed JSON line is skipped via onParseError, process not crashed", () => {
    const h = harness();
    h.stdout.push(`not json at all\n{"method":"a"}\n{bad}\n{"method":"b"}\n`);
    expect(h.messages.map((m) => m.method)).toEqual(["a", "b"]);
    expect(h.parseErrors.length).toBe(2);
  });

  it("non-object JSON (array / number / null) is rejected as parse error", () => {
    const h = harness();
    h.stdout.push(`[1,2,3]\n42\nnull\n{"method":"ok"}\n`);
    expect(h.messages.map((m) => m.method)).toEqual(["ok"]);
    expect(h.parseErrors.length).toBe(3);
  });

  it("CRLF line endings tolerated", () => {
    const h = harness();
    h.stdout.push(`{"method":"a"}\r\n{"method":"b"}\r\n`);
    expect(h.messages.map((m) => m.method)).toEqual(["a", "b"]);
  });

  it("send serializes as JSON + newline", () => {
    const h = harness();
    h.rpc.send({ id: 1, method: "initialize", params: { x: 1 } });
    expect(h.written).toEqual([`{"id":1,"method":"initialize","params":{"x":1}}\n`]);
  });

  it("Buffer chunks (not just strings) are handled", () => {
    const h = harness();
    h.stdout.push(Buffer.from(`{"method":"a"}\n`, "utf8"));
    expect(h.messages.map((m) => m.method)).toEqual(["a"]);
  });
});
