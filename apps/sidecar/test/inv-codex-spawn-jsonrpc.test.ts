/**
 * ADR 019f4206 A段: INV-SPAWN-PROMPT-VIA-JSONRPC — spawn の argv は固定で prompt を含まず、prompt は
 * turn/start (JSON-RPC・stdin) 経由でのみ渡る (shell/argv/ps 非接触・契約点1)。
 *
 * REAL: CodexSpawnManager は **実 startManagedCodex** を通す (fake は spawnChild seam のみ)。応答する fake
 * app-server 子で handshake を完走させ、prompt が turn/start の構造化 input として stdin に届くことと、argv/env
 * に prompt が一切載らないことを同時に固定する。
 *
 * 🔴 mutation: startManagedCodex の spawn を `spawn(codexBin, ["app-server", prompt])` 等に変えると args に
 *   prompt が載り本 test が RED。turn/start 経路を argv に置換する回帰を捕捉する。
 */
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ApprovalBridge, type RepoScopeResolver } from "../src/approval-bridge.js";
import type { ChildLike, ChildSpawnOptions } from "../src/codex-runner.js";
import { CodexSpawnManager } from "../src/codex-spawn-manager.js";
import { EventSink } from "../src/sink.js";
import { EventStore } from "../src/store.js";
import type { WsClient } from "../src/ws-client.js";

const SENTINEL_PROMPT = "SPAWN_JSONRPC_SENTINEL_refactor_the_widget";

/** stdin の JSON-RPC に応答し handshake を完走させる fake codex 子 (inv-codex-runner の縮約)。 */
class FakeCodexChild extends EventEmitter implements ChildLike {
  readonly pid = 999999;
  private buf = "";
  readonly inbound: Array<Record<string, unknown>> = [];
  private readonly out = new EventEmitter();
  readonly stdin = {
    write: (chunk: string): boolean => {
      this.buf += chunk;
      let i: number;
      while ((i = this.buf.indexOf("\n")) >= 0) {
        const line = this.buf.slice(0, i);
        this.buf = this.buf.slice(i + 1);
        if (line.trim()) this.onMsg(JSON.parse(line) as Record<string, unknown>);
      }
      return true;
    },
  };
  readonly stdout = {
    on: (ev: "data", l: (c: Buffer | string) => void) => this.out.on(ev, l),
    off: (ev: "data", l: (c: Buffer | string) => void) => this.out.off(ev, l),
  };
  readonly stderr = { on: () => {} };
  // on("exit", …) は EventEmitter を継承して ChildLike を満たす (独自 override は不要・
  //   overload 実装署名が (...a: unknown[]) だと exit overload と非互換=TS2394 になるため置かない)。
  kill(): boolean {
    return true;
  }
  private emitLine(msg: Record<string, unknown>): void {
    this.out.emit("data", JSON.stringify(msg) + "\n");
  }
  private onMsg(msg: Record<string, unknown>): void {
    this.inbound.push(msg);
    const id = msg.id;
    if (msg.method === "initialize") {
      this.emitLine({ id, result: { userAgent: "fake/0.137.0", codexHome: "/home/x/.codex" } });
    } else if (msg.method === "thread/start") {
      this.emitLine({
        id,
        result: {
          thread: { id: "thread_abc", sessionId: "sess_abc", status: { type: "idle" } },
          model: "gpt-x",
          modelProvider: "openai",
        },
      });
    } else if (msg.method === "turn/start") {
      this.emitLine({ id, result: { turn: { id: "turn_1", status: "inProgress", items: [] } } });
    }
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const dirs: string[] = [];
const managers: CodexSpawnManager[] = [];
const stores: EventStore[] = [];
afterEach(() => {
  for (const m of managers.splice(0)) m.dispose();
  for (const s of stores.splice(0)) s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("INV-SPAWN-PROMPT-VIA-JSONRPC", () => {
  it("argv は固定 ['app-server']・prompt は turn/start(JSON-RPC) 経由で stdin に届き argv/env に載らない", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ad-spawn-jsonrpc-"));
    dirs.push(dir);
    const store = new EventStore(join(dir, "s.db"));
    stores.push(store);
    const sink = new EventSink({
      store,
      wsClient: { notifyAppended: () => {} } as unknown as WsClient,
    });
    const resolveRepoScope: RepoScopeResolver = async () => ({
      scope: "s",
      label: "repo",
      root: "/repo",
    });

    let capturedFile = "";
    let capturedArgs: readonly string[] = [];
    let capturedEnv: NodeJS.ProcessEnv = {};
    const child = new FakeCodexChild();
    const mgr = new CodexSpawnManager({
      sink,
      approvalBridge: new ApprovalBridge({ timeoutMs: 1000 }),
      resolveRepoScope,
      enabled: true,
      spawnChild: (file: string, args: readonly string[], o: ChildSpawnOptions): ChildLike => {
        capturedFile = file;
        capturedArgs = args;
        capturedEnv = o.env;
        return child;
      },
    });
    managers.push(mgr);

    const res = await mgr.handleSpawn({ prompt: SENTINEL_PROMPT, cwd: "/repo", resolveScope: [] });
    expect(res.ok).toBe(true);

    // argv は固定・prompt を含まない (ps/argv 非接触)。
    expect(capturedFile).toBe("codex");
    expect(capturedArgs).toEqual(["app-server"]);
    expect(capturedArgs).not.toContain(SENTINEL_PROMPT);
    // env にも prompt が載らない。
    expect(JSON.stringify(capturedEnv)).not.toContain(SENTINEL_PROMPT);

    // handshake が turn/start まで進み、prompt が構造化 input として stdin に届く (JSON-RPC 経由の実証)。
    let turnStart: Record<string, unknown> | undefined;
    for (let i = 0; i < 100 && turnStart === undefined; i++) {
      turnStart = child.inbound.find((m) => m.method === "turn/start");
      if (turnStart === undefined) await sleep(10);
    }
    expect(turnStart, "turn/start must be sent via JSON-RPC").toBeDefined();
    const params = turnStart!.params as { input?: Array<{ type?: string; text?: string }> };
    const texts = (params.input ?? []).map((p) => p.text);
    expect(texts).toContain(SENTINEL_PROMPT); // prompt は turn/start の input.text (shell 非接触)。
  });
});
