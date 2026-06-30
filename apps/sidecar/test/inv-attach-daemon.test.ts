/**
 * INV-ATTACH-{MULTIPLEX,REDACTION,NO-KILL} (ADR 019ea476 D6/D7)。
 *
 * AttachDaemon を実 HTTP hook 受信 + 実 SQLite で駆動する (REAL DATA, モック禁止)。
 * WS は到達不能 URL で接続失敗するが (backend 不要)、redaction choke (SQLite append) は通る。
 *
 * - INV-ATTACH-MULTIPLEX: 2 つの異なる session_id の hook が独立 projection になり相互汚染しない。
 *   mutation: registry を単一 session 上書きにすると片方が落ち赤化。
 * - INV-ATTACH-REDACTION: diff/command の ghp_/AKIA が SQLite で [REDACTED:*] (choke 透過)。
 * - INV-ATTACH-NO-KILL: interrupt 要求で PID kill が一切起きない (managed runner 不在)。
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PolicyCategory } from "@actradeck/event-model";

import { AttachDaemon } from "../src/attach-daemon.js";
import { normalizeHook } from "../src/normalize.js";
import { EventStore } from "../src/store.js";
import { HOOK_TOKEN_HEADER } from "../src/settings-injection.js";

let dir: string;
let daemon: AttachDaemon;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "actradeck-attach-daemon-"));
});
afterEach(async () => {
  await daemon?.shutdown();
  rmSync(dir, { recursive: true, force: true });
});

function makeDaemon(): { daemon: AttachDaemon; dbPath: string } {
  const dbPath = join(dir, "sidecar.db");
  // 到達不能 ws (backend 不要)。hookToken を固定して POST で提示する。
  const d = new AttachDaemon({
    wsUrl: "ws://127.0.0.1:1/ingest/ws",
    dbPath,
    hookToken: "tok-fixed",
    host: "127.0.0.1",
    // 自動ガード (ADR 019ecc70): secret 入り tool_input は承認ゲート対象になり、UI 未接続では
    // タイムアウトで deny する。テストが gate のタイムアウトで 30s ハングしないよう短縮する。
    approvalTimeoutMs: 30,
  });
  return { daemon: d, dbPath };
}

async function postHook(port: number, body: unknown): Promise<number> {
  const res = await fetch(`http://127.0.0.1:${port}/hook`, {
    method: "POST",
    headers: { "content-type": "application/json", [HOOK_TOKEN_HEADER]: "tok-fixed" },
    body: JSON.stringify(body),
  });
  await res.text();
  return res.status;
}

function port(d: AttachDaemon): number {
  return Number(new URL(d.hookEndpoint).port);
}

function readEvents(dbPath: string): Array<Record<string, unknown>> {
  const store = new EventStore(dbPath);
  const rows = store.allRows();
  store.close();
  return rows.map((r) => JSON.parse(r.event_json as string) as Record<string, unknown>);
}

describe("INV-ATTACH-MULTIPLEX: 2 session の相互汚染なし", () => {
  it("two distinct session_ids produce independent projections (no cross-contamination)", async () => {
    const m = makeDaemon();
    daemon = m.daemon;
    await daemon.start();
    const p = port(daemon);

    await postHook(p, {
      session_id: "sessA",
      hook_event_name: "SessionStart",
      cwd: "/tmp/a",
      source: "startup",
    });
    await postHook(p, {
      session_id: "sessB",
      hook_event_name: "SessionStart",
      cwd: "/tmp/b",
      source: "startup",
    });

    // registry は 2 つの独立 entry を持つ (mutation: 単一上書きならここが赤化)。
    expect(daemon.observedSessionCount).toBe(2);
    expect(daemon.registry.get("sessA")?.cwd).toBe("/tmp/a");
    expect(daemon.registry.get("sessB")?.cwd).toBe("/tmp/b");

    const events = readEvents(m.dbPath);
    const a = events.filter((e) => e.session_id === "sessA");
    const b = events.filter((e) => e.session_id === "sessB");
    expect(a.length).toBeGreaterThan(0);
    expect(b.length).toBeGreaterThan(0);
    // A の cwd が B に混ざらない。
    for (const e of a) expect(e.cwd === undefined || e.cwd === "/tmp/a").toBe(true);
    for (const e of b) expect(e.cwd === undefined || e.cwd === "/tmp/b").toBe(true);
    // hello.session_ids に両方が載る (multiplex)。
    expect(daemon.registry.sessionIds().sort()).toEqual(["sessA", "sessB"]);
  });
});

describe("INV-ATTACH-REDACTION: 秘匿が SQLite で REDACTED (choke 透過)", () => {
  it("ghp_/AKIA in a PreToolUse command are redacted before persistence", async () => {
    const m = makeDaemon();
    daemon = m.daemon;
    await daemon.start();
    const p = port(daemon);

    const secretCmd =
      "curl -H 'token: ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' https://x && export KEY=AKIAIOSFODNN7EXAMPLE";
    // 自動ガード (ADR 019ecc70): secret 入り command は承認ゲート対象になり、emitRequest で
    // tool.permission.requested (waiting.approval) が **同期的に** emit→sink choke→SQLite される。
    // UI 未接続なので承認は短縮タイムアウト (30ms) で deny。redaction choke はこの gated event の
    // command field にも同様に効く (本テストは event_type 不問で raw 非存在 + REDACTED を検証する)。
    await postHook(p, {
      session_id: "sredact",
      hook_event_name: "PreToolUse",
      cwd: "/tmp/r",
      tool_name: "Bash",
      tool_input: { command: secretCmd },
    });

    const events = readEvents(m.dbPath);
    const raw = JSON.stringify(events);
    // 生の秘匿は SQLite に存在しない。
    expect(raw).not.toContain("ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
    expect(raw).not.toContain("AKIAIOSFODNN7EXAMPLE");
    // REDACTED マーカーで置換されている。
    expect(raw).toContain("[REDACTED");
  });

  /**
   * QA-1 (H) 真ゲート化: 前テストは `payload.command` のみを検証していたが、command は
   * normalize の `summarize()→redactString` で **sink 到達前に既にマスク**されるため、
   * sink の `redactDeep` choke を bypass しても緑のまま = INV-REDACTION の attach 経路が
   * 未防御だった (偽ゲート)。
   *
   * 本テストは **normalize が生載せする field** (Edit hook の `file_path` → `payload.path` /
   * `summary`。summarize 非経由) に secret を埋め、attach 経路 (hook→normalize→sink→SQLite) で
   * **`sink.redactDeep` 単独**が `[REDACTED]` 化することを assert する。これにより:
   *  - choke が attach 経路を確かに防御していることを固定する。
   *  - sink の redactDeep を外す/弱める mutation で **赤化** する (choke 単独検証・CI 回帰捕捉)。
   */
  it("secret embedded in an Edit file_path is redacted by the sink choke ALONE (normalize does not mask path)", async () => {
    // 前提固定: normalize は Edit の path を **マスクせず生で** payload/summary に載せる
    // (summarize 非経由)。choke が無ければ raw が SQLite に残ることを示す対照。
    const SECRET = "ghp_REDACTIONPROBE0123456789ABCDEFXYZ";
    const candidates = normalizeHook({
      session_id: "sedit",
      hook_event_name: "PreToolUse",
      cwd: "/tmp/e",
      tool_name: "Edit",
      tool_input: { file_path: `/repo/${SECRET}/notes.ts` },
    });
    const preSink = JSON.stringify(candidates);
    // normalize 単独では secret が **生のまま** 残る (= summarize がこの経路を守っていない)。
    expect(preSink).toContain(SECRET);

    // 実 attach 経路: daemon の hook→sink→SQLite。sink.redactDeep choke のみが防御する。
    const m = makeDaemon();
    daemon = m.daemon;
    await daemon.start();
    const p = port(daemon);
    await postHook(p, {
      session_id: "sedit",
      hook_event_name: "PreToolUse",
      cwd: "/tmp/e",
      tool_name: "Edit",
      tool_input: { file_path: `/repo/${SECRET}/notes.ts` },
    });

    const events = readEvents(m.dbPath);
    const raw = JSON.stringify(events);
    // choke 透過後: 生 secret は SQLite に不在、REDACTED 化されている。
    // mutation: sink の redactDeep を bypass するとここが赤化 (raw が SQLite に残る)。
    expect(raw).not.toContain(SECRET);
    expect(raw).toContain("[REDACTED:github-token]");
    // 自動ガード (ADR 019ecc70): secret 入り file_path は承認ゲート対象になり、normalize は
    // file.change.proposed ではなく tool.permission.requested (waiting.approval) を emit する
    // (payload.path に生 file_path を載せる経路は同じ = choke 単独検証の意図を保つ)。
    const gatedEv = events.find((e) => e.event_type === "tool.permission.requested");
    expect(gatedEv).toBeDefined();
  });
});

describe("INV-ATTACH-NO-KILL: 非所有 PID を kill しない", () => {
  it("interrupt request does NOT call process.kill (no managed runner exists)", async () => {
    const m = makeDaemon();
    daemon = m.daemon;
    const ignored = vi.fn();
    // onInterruptIgnored を観測するため別 daemon を構築。
    await daemon.shutdown();
    daemon = new AttachDaemon({
      wsUrl: "ws://127.0.0.1:1/ingest/ws",
      dbPath: join(dir, "nokill.db"),
      hookToken: "tok-fixed",
      host: "127.0.0.1",
      onInterruptIgnored: ignored,
    });
    await daemon.start();

    const killSpy = vi.spyOn(process, "kill");
    // WsClient の interrupt イベントを直接発火 (UI relay 相当)。
    daemon.wsClient.emit("interrupt", { session_id: "sessA" });

    // PID kill は呼ばれない (no-op + 観測)。
    expect(killSpy).not.toHaveBeenCalled();
    expect(ignored).toHaveBeenCalledWith("sessA");
    killSpy.mockRestore();
  });
});

/**
 * QA-1 (ADR 019f0c3e Phase 2 4面監査・decision 019f0e7d): onPersistFailure が daemon→bridge→cli へ
 * 配線され、実際に発火することを daemon レベルで pin する (bridge 単体 pin=L2(a) に加えた forward の
 * firing テスト・onInterruptIgnored と parity)。disk-persist 失敗を強制する: HOME を temp に向け
 * `$HOME/.actradeck` を **ファイル**にしておくと saveApprovalPolicy の mkdir($HOME/.actradeck/approvals)
 * が ENOTDIR で同期 throw する (非 root でも確実)。forward の spread を外す mutation で surfaced 空 → RED。
 */
describe("QA-1: onPersistFailure が daemon→bridge→cli 配線経由で発火する", () => {
  it("policy 永続 (persistDelta→applyPolicyDelta) が disk 失敗すると onPersistFailure(count) が daemon forward 経由で発火し live gate は保持", () => {
    const origHome = process.env.HOME;
    const home = mkdtempSync(join(tmpdir(), "actradeck-qa1-home-"));
    try {
      process.env.HOME = home;
      const surfaced: number[] = [];
      // 構築時点では $HOME/.actradeck 不在 → loadApprovalPolicy は ENOENT→既定プリセット (構築成功)。
      daemon = new AttachDaemon({
        wsUrl: "ws://127.0.0.1:1/ingest/ws",
        dbPath: join(dir, "qa1.db"),
        hookToken: "tok-fixed",
        host: "127.0.0.1",
        onPersistFailure: (count) => surfaced.push(count),
      });
      // $HOME/.actradeck を **ファイル**化 → 以降 saveApprovalPolicy の mkdir が ENOTDIR throw。
      writeFileSync(join(home, ".actradeck"), "not-a-dir");
      // attach-daemon.ts の onPersistFailure forward spread を外す mutation だと surfaced 空で RED。
      daemon.approvalBridge.setPolicyConfig({
        categories: new Set<PolicyCategory>(["disk-destroy"]),
      });
      // 件数 (非負整数) が cli 配線へ届く (NO-RAW)。
      expect(surfaced).toEqual([1]);
      // primary 効果 (live gate=memory) は disk 失敗でも保持 (deny-safe)。
      expect([...daemon.approvalBridge.getPolicyConfig().categories]).toEqual(["disk-destroy"]);
    } finally {
      if (origHome === undefined) delete process.env.HOME;
      else process.env.HOME = origHome;
      rmSync(home, { recursive: true, force: true });
    }
  });
});

/**
 * SEC-2 + QA-2 (ADR 019f0eca full 監査・decision 019f0f2f): policy handler の async 化で、構造 backstop
 * (WsClient.handleInbound の同期 try/catch) が async IIFE の本体/catch を覆わなくなった。catch 内 respondPolicy
 * が throw すると void では unhandledRejection が escape し、global net 無しの attach daemon がプロセス死する。
 * IIFE 末尾の `.catch(()=>{})` が非同期版の最終 net。以下を falsifiable に pin する:
 *  - SEC-2 crash-safety: respondPolicy が常に throw しても policyRequest 処理で unhandledRejection が発火せず
 *    daemon は生存する (.catch を外すと unhandledRejection が漏れて RED)。
 *  - QA-2 graceful-error: buildPolicyResponse が throw (resolveRepoScope 例外) しても、handler の inner catch が
 *    request_id へ error 応答を返し、unhandledRejection も出ない (graceful 縮退)。
 */
describe("SEC-2/QA-2: async policy handler の crash-safety + graceful-error", () => {
  /** policyRequest emit 後の async IIFE / microtask を確実に走らせる。 */
  async function flush(): Promise<void> {
    await new Promise((r) => setTimeout(r, 20));
  }

  it("SEC-2: respondPolicy が throw しても unhandledRejection を出さず daemon は生存する", async () => {
    daemon = makeDaemon().daemon;
    const rejections: unknown[] = [];
    const onRej = (e: unknown): void => {
      rejections.push(e);
    };
    process.on("unhandledRejection", onRej);
    try {
      // 最悪ケース: 成功側 respondPolicy も inner catch の respondPolicy も throw する。
      daemon.wsClient.respondPolicy = () => {
        throw new Error("respond boom (sentinel)");
      };
      daemon.wsClient.emit("policyRequest", {
        type: "policy.request",
        request_id: "r1",
        op: "get",
      });
      await flush();
      // .catch(()=>{}) が IIFE の reject を飲む → unhandledRejection 0 (外すと sentinel が漏れて RED)。
      expect(rejections).toHaveLength(0);
      // daemon は生存 (別イベントを処理できる)。
      expect(() => daemon.wsClient.emit("policyRequest", { type: "policy.request" })).not.toThrow();
    } finally {
      process.off("unhandledRejection", onRej);
    }
  });

  it("QA-2: buildPolicyResponse が throw しても inner catch が error 応答を返し unhandledRejection は出ない", async () => {
    daemon = makeDaemon().daemon;
    const rejections: unknown[] = [];
    const onRej = (e: unknown): void => {
      rejections.push(e);
    };
    process.on("unhandledRejection", onRej);
    try {
      // resolveRepoScope 例外を模す: getPolicyConfigForPath を throw させる (op=resolve がこれを await)。
      daemon.approvalBridge.getPolicyConfigForPath = async () => {
        throw new Error("resolver boom");
      };
      const sent: Array<Record<string, unknown>> = [];
      daemon.wsClient.respondPolicy = (res: Record<string, unknown>) => {
        sent.push(res);
      };
      daemon.wsClient.emit("policyRequest", {
        type: "policy.request",
        request_id: "r2",
        op: "resolve",
        path: "/some/path",
      });
      await flush();
      // graceful: request_id へ error 応答 (backend の timeout 待ちを避ける)。
      expect(sent).toHaveLength(1);
      expect(sent[0]!.request_id).toBe("r2");
      expect(sent[0]!.error).toBeDefined();
      expect(rejections).toHaveLength(0);
    } finally {
      process.off("unhandledRejection", onRej);
    }
  });
});
