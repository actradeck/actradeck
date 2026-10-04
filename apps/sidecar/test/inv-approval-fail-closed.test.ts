/**
 * INV-APPROVAL-FAIL-CLOSED (task 019fd74a・裁定 01a107b4): 承認フック (PreToolUse / PermissionRequest)
 * として届いた要求は、ActraDeck 内部のどの失敗でも空 `{}` (= 上流では「no opinion」→ 通常 flow /
 * bypassPermissions ではそのまま実行) にも allow にもならず、**明示 deny** を返す。
 *
 * 是正 (hook-receiver.ts の内側 catch + respondApprovalFailure) は 0f8303f で着地済み。既存の
 * `hook-approval-gate.test.ts` は「常に throw する sink × PreToolUse」と「identity 失敗 ×
 * PermissionRequest」の 2 セルしか固定しておらず、post-hoc 監査で次の退行が素通りした:
 * - QA-FC-1: requestApproval の reject を defer へ握り潰す変異。常に throw する sink では defer 経路の
 *   観測 ingest も throw して結局 deny になるため見えない。**一過性**の失敗 (1 回だけ throw) で `{}` になる。
 * - QA-FC-2: identity / onHook の位置をずらす変異 (片方の hook 種別だけ素通り)。
 * - SEC-FC-1: 応答を書いた後の失敗で二度目の書込を試みる形 (rejection net の無い本番 daemon が落ち、
 *   並走中の承認待ちが接続断 = 上流契約上 non-blocking で承認なしに通る)。
 *
 * ここでは「失敗源 × hook 種別」を表駆動で流し、応答全体を `toEqual` で比較する。加えて、現行の
 * 挙動として採用した境界 (sink 障害時は low-risk / auto-allow も deny・判定前の解釈不能入力と
 * 非承認 hook は `{}`) を pin する。
 *
 * crash-chain テスト (SEC-FC-1) の前提は worker の自己申告 (`NETS` / `UNHANDLED` / `THROW`) で assert する。
 * **ただし `THROW` は throw の直前に出す印なので、worker の throw 文だけを消す編集は検出できない**
 * (main ループ変異 VW2 で SURVIVED を実測)。worker は test helper (.mts) であり、その編集は本テストの
 * fixture を変える coordinated 編集にあたる (開示する残余)。
 *
 * **固定しないもの**: 承認フックと判定する前に HTTP 層で起きる失敗 (daemon 不在・token 不一致・body
 * 上限超過・CC 側 timeout)。これらは上流契約で non-blocking になり、本 INV の守備範囲外 (SEC-FC-3・
 * 別 task で docs と構造対策を扱う)。
 */
import { spawn } from "node:child_process";
import { request } from "node:http";

import { afterAll, describe, expect, it, vi } from "vitest";

import type { NormalizedEvent } from "@actradeck/event-model";

import { ApprovalBridge } from "../src/approval-bridge.js";
import { HookReceiver } from "../src/hook-receiver.js";
import type { EventSink } from "../src/sink.js";
import { tsxBin, workerScript } from "./helpers/lock-test-support.js";

const FAIL_REASON = "ActraDeck approval gate failed closed";

type ReceiverOptions = ConstructorParameters<typeof HookReceiver>[0];
type BridgeOptions = ConstructorParameters<typeof ApprovalBridge>[0];

async function postRaw(port: number, raw: string): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`http://127.0.0.1:${port}/hook`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: raw,
  });
  const text = await res.text();
  return { status: res.status, body: text.length > 0 ? JSON.parse(text) : "<empty>" };
}
const post = (port: number, body: unknown) => postRaw(port, JSON.stringify(body));

const PRE_HIGH = {
  session_id: "s-fail-closed",
  hook_event_name: "PreToolUse",
  tool_name: "Bash",
  tool_input: { command: "rm -rf /tmp/fail-closed" },
};
const PRE_LOW = { ...PRE_HIGH, tool_input: { command: "ls -la" } };
const PERMISSION_REQUEST = {
  session_id: "s-fail-closed",
  hook_event_name: "PermissionRequest",
  tool_name: "Bash",
  tool_input: { command: "npm install" },
};
const PRE_DENY = {
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision: "deny",
    permissionDecisionReason: FAIL_REASON,
  },
};
const PERMISSION_DENY = {
  hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "deny" } },
};

async function withReceiver(
  opts: Partial<ReceiverOptions> & { sink: EventSink },
  fn: (port: number, bridge: ApprovalBridge) => Promise<void>,
  bridge = new ApprovalBridge({ timeoutMs: 1000 }),
): Promise<void> {
  const receiver = new HookReceiver({ approvalBridge: bridge, ...opts });
  const port = await receiver.listen();
  try {
    await fn(port, bridge);
  } finally {
    await receiver.close();
  }
}

function recordingSink(): { sink: EventSink; events: NormalizedEvent[] } {
  const events: NormalizedEvent[] = [];
  const sink = { emit: vi.fn((ev: NormalizedEvent) => events.push(ev)) } as unknown as EventSink;
  return { sink, events };
}

const throwingSink = (): EventSink =>
  ({
    emit: vi.fn(() => {
      throw new Error("synthetic sink failure");
    }),
  }) as unknown as EventSink;

/** 最初に `type` の event を emit したときだけ throw し、以後は正常 (一過性の失敗)。 */
function oneShotSink(type: string): { sink: EventSink; events: NormalizedEvent[] } {
  const events: NormalizedEvent[] = [];
  let fired = false;
  const sink = {
    emit: vi.fn((ev: NormalizedEvent) => {
      if (!fired && ev.event_type === type) {
        fired = true;
        throw new Error("transient sink failure");
      }
      events.push(ev);
    }),
  } as unknown as EventSink;
  return { sink, events };
}

/** 承認カード (requested) が出るまで待ち、その request_id を返す。 */
async function waitForRequestId(events: readonly NormalizedEvent[]): Promise<string> {
  for (let i = 0; i < 400; i++) {
    const req = events.find((e) => e.event_type === "tool.permission.requested");
    const id = (req?.payload as { request_id?: string } | undefined)?.request_id;
    if (id !== undefined) return id;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("approval card never appeared");
}

/** 失敗源ごとに receiver / bridge を組む。いずれも承認フックとして解釈された**後**の内部失敗。 */
interface FailureSource {
  readonly name: string;
  readonly build: () => {
    opts: Partial<ReceiverOptions> & { sink: EventSink };
    bridge?: ApprovalBridge;
  };
  /** 要求に足す field (bypass + cwd 等)。 */
  readonly extra?: Record<string, unknown>;
}

const FAILURE_SOURCES: readonly FailureSource[] = [
  {
    name: "identity 解決 (resolveIdentity) が throw",
    build: () => ({
      opts: {
        sink: recordingSink().sink,
        resolveIdentity: () => {
          throw new Error("synthetic identity failure");
        },
      },
    }),
  },
  {
    name: "静的 identity の run 境界判定 (onHookSession) が throw",
    build: () => ({
      opts: {
        sink: recordingSink().sink,
        identity: {
          onHookSession: () => {
            throw new Error("synthetic boundary failure");
          },
        } as unknown as ReceiverOptions["identity"],
      },
    }),
  },
  {
    name: "onHook が throw",
    build: () => ({
      opts: {
        sink: recordingSink().sink,
        onHook: () => {
          throw new Error("synthetic onHook failure");
        },
      },
    }),
  },
  {
    name: "requestApproval が reject (bypass + per-repo policy の git 境界失敗・sink は正常)",
    build: () => ({
      opts: { sink: recordingSink().sink },
      bridge: new ApprovalBridge({
        timeoutMs: 1000,
        policy: { enabled: true, categories: new Set(["recursive-rm"]) },
        policyRepos: new Map([
          ["deadbeefdeadbeef", { enabled: true, categories: new Set(["recursive-rm"]) }],
        ]),
        resolveRepoScope: async () => {
          throw new Error("synthetic git boundary failure");
        },
      } as BridgeOptions),
    }),
    extra: { permission_mode: "bypassPermissions", cwd: "/tmp" },
  },
  {
    name: "承認カード (requested) の emit が一過性に失敗 (以後 sink は正常)",
    build: () => ({ opts: { sink: oneShotSink("tool.permission.requested").sink } }),
  },
  {
    name: "承認カード (requested) の emit が常に失敗",
    build: () => ({ opts: { sink: throwingSink() } }),
  },
];

const HOOK_KINDS = [
  { kind: "PreToolUse", request: PRE_HIGH, expected: PRE_DENY },
  { kind: "PermissionRequest", request: PERMISSION_REQUEST, expected: PERMISSION_DENY },
] as const;

describe("INV-APPROVAL-FAIL-CLOSED: 失敗源 × hook 種別は応答全体が明示 deny", () => {
  let cellsExecuted = 0;
  afterAll(() => {
    // 表の全セルが計測 callback の末尾まで到達したこと (skip / 早期 return を loud にする)。
    expect(cellsExecuted).toBe(FAILURE_SOURCES.length * HOOK_KINDS.length);
  });

  it("表の構成: 失敗源 6 種 × hook 種別 2 種・名前は相異", () => {
    expect(new Set(FAILURE_SOURCES.map((s) => s.name)).size).toBe(FAILURE_SOURCES.length);
    expect(FAILURE_SOURCES.length).toBe(6);
    expect(HOOK_KINDS.map((h) => h.kind)).toEqual(["PreToolUse", "PermissionRequest"]);
  });

  for (const source of FAILURE_SOURCES) {
    for (const hook of HOOK_KINDS) {
      it(`${hook.kind} × ${source.name}`, async () => {
        const { opts, bridge } = source.build();
        await withReceiver(
          opts,
          async (port, b) => {
            const res = await post(port, { ...hook.request, ...(source.extra ?? {}) });
            expect(res.status).toBe(200);
            expect(res.body).toEqual(hook.expected);
            // 失敗後に承認待ちが残らない (timer も pending も漏らさない)。
            expect(b.pendingCount).toBe(0);
          },
          bridge,
        );
        cellsExecuted += 1;
      });
    }
  }
});

describe("INV-APPROVAL-FAIL-CLOSED: 採用した境界の pin", () => {
  it("一過性の失敗後に通常の観測 (command.started) を出して素通りしない (QA-FC-1)", async () => {
    const { sink, events } = oneShotSink("tool.permission.requested");
    await withReceiver({ sink }, async (port) => {
      expect((await post(port, PRE_HIGH)).body).toEqual(PRE_DENY);
      expect(events.some((e) => e.event_type === "command.started")).toBe(false);
      // 対照: 同じ receiver は失敗が過ぎた後の low-risk を通常どおり `{}` で通す (sink が健全に戻った)。
      expect((await post(port, PRE_LOW)).body).toEqual({});
      expect(events.some((e) => e.event_type === "command.started")).toBe(true);
    });
  });

  it("sink 障害時は low-risk PreToolUse の defer 経路も deny (fail-closed を採用・QA-FC-3)", async () => {
    await withReceiver({ sink: throwingSink() }, async (port) => {
      expect((await post(port, PRE_LOW)).body).toEqual(PRE_DENY);
    });
    // 対照: 健全な sink なら同じ要求は `{}` (= ゲート対象外)。
    await withReceiver({ sink: recordingSink().sink }, async (port) => {
      expect((await post(port, PRE_LOW)).body).toEqual({});
    });
  });

  it("sink 障害時は allow_for_session 済みの auto-allow 経路も deny (fail-closed を採用・QA-FC-3)", async () => {
    let failObservation = false;
    const events: NormalizedEvent[] = [];
    const sink = {
      emit: vi.fn((ev: NormalizedEvent) => {
        if (failObservation && ev.event_type === "command.started") throw new Error("x");
        events.push(ev);
      }),
    } as unknown as EventSink;
    await withReceiver({ sink }, async (port, bridge) => {
      const first = post(port, PRE_HIGH);
      expect(bridge.resolve(await waitForRequestId(events), "allow_for_session", "ok")).toBe(true);
      expect((await first).body).toMatchObject({
        hookSpecificOutput: { permissionDecision: "allow" },
      });
      // 対照: 失敗を入れない 2 回目は auto-allow (同一署名の再適用) で allow。
      expect((await post(port, PRE_HIGH)).body).toMatchObject({
        hookSpecificOutput: { permissionDecision: "allow" },
      });
      failObservation = true;
      expect((await post(port, PRE_HIGH)).body).toEqual(PRE_DENY);
    });
  });

  it("応答を書いた後の resolved emit 失敗では、応答は allow のまま 1 回だけでサーバも生存 (QA-FC-5)", async () => {
    const events: NormalizedEvent[] = [];
    const sink = {
      emit: vi.fn((ev: NormalizedEvent) => {
        if (ev.event_type === "tool.permission.resolved") throw new Error("resolved sink failure");
        events.push(ev);
      }),
    } as unknown as EventSink;
    await withReceiver({ sink }, async (port, bridge) => {
      const pending = post(port, PRE_HIGH);
      expect(bridge.resolve(await waitForRequestId(events), "allow", "ok")).toBe(true);
      const res = await pending;
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ hookSpecificOutput: { permissionDecision: "allow" } });
      // 失敗の後も次の要求を捌く。
      expect((await post(port, PRE_LOW)).status).toBe(200);
    });
  });

  it("承認フックと判定する前の解釈不能入力は `{}` (現行の挙動 pin・QA-FC-4)", async () => {
    await withReceiver({ sink: recordingSink().sink }, async (port) => {
      expect(await postRaw(port, "{not json")).toEqual({ status: 200, body: {} });
      expect(await postRaw(port, "null")).toEqual({ status: 200, body: {} });
      expect(await post(port, { hook_event_name: "PreToolUse", tool_name: "Bash" })).toEqual({
        status: 200,
        body: {},
      });
      expect(await post(port, { session_id: 1, hook_event_name: "PermissionRequest" })).toEqual({
        status: 200,
        body: {},
      });
    });
  });

  it("非承認 hook の内部失敗は `{}` (可用性優先・承認経路だけが deny・QA-FC-4)", async () => {
    await withReceiver({ sink: throwingSink() }, async (port) => {
      expect(await post(port, { session_id: "s", hook_event_name: "Stop" })).toEqual({
        status: 200,
        body: {},
      });
      // 対照: 同じ sink 障害下でも承認フックは deny。
      expect((await post(port, PRE_HIGH)).body).toEqual(PRE_DENY);
    });
  });
});

/** HTTP POST (fetch でなく node:http・接続断を error として受け取る)。 */
function postNode(
  port: number,
  body: unknown,
): Promise<{ status?: number | undefined; body?: string; error?: string }> {
  return new Promise((resolvePromise) => {
    const buf = Buffer.from(JSON.stringify(body), "utf8");
    const req = request(
      {
        host: "127.0.0.1",
        port,
        path: "/hook",
        method: "POST",
        headers: { "content-type": "application/json", "content-length": buf.length },
      },
      (res) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (c: string) => (data += c));
        res.on("end", () => resolvePromise({ status: res.statusCode, body: data }));
        res.on("error", (e: NodeJS.ErrnoException) =>
          resolvePromise({ error: e.code ?? e.message }),
        );
      },
    );
    req.setTimeout(15_000, () => req.destroy(new Error("CLIENT_TIMEOUT")));
    req.on("error", (e: NodeJS.ErrnoException) => resolvePromise({ error: e.code ?? e.message }));
    req.end(buf);
  });
}

describe("INV-APPROVAL-FAIL-CLOSED: 応答後の失敗で daemon が落ちず並走中の承認も deny (SEC-FC-1)", () => {
  it("rejection net の無い実プロセスで、承認 A の応答後失敗が並走中の承認 B を素通りさせない", async () => {
    // 親の NODE_OPTIONS に unhandled-rejections の緩和が入っていても worker へ渡さない (前提を固定)。
    const nodeOptions = (process.env.NODE_OPTIONS ?? "")
      .split(/\s+/)
      .filter((a) => a.length > 0 && !a.startsWith("--unhandled-rejections"))
      .join(" ");
    // detached: worker 実体は tsx CLI が起動する孫プロセス。CLI の pid だけを kill すると孫が孤児として
    // 残る (QA-FC-R2-1)。新しいプロセスグループで起動し、グループごと終了させる。
    const child = spawn(tsxBin, [workerScript("hook-crash-chain-worker.mts")], {
      env: { ...process.env, NODE_OPTIONS: nodeOptions },
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    let stderr = "";
    child.stderr.on("data", (c: Buffer) => (stderr += c.toString()));
    const exited = new Promise<string>((r) =>
      child.on("exit", (code, sig) => r(`EXITED code=${String(code)} sig=${String(sig)}`)),
    );
    let stdout = "";
    child.stdout.on("data", (c: Buffer) => (stdout += c.toString()));
    const field = (name: string): string | undefined =>
      new RegExp(`^${name} (\\S+)$`, "m").exec(stdout)?.[1];
    try {
      const port = await new Promise<number>((resolvePort, reject) => {
        child.stdout.on("data", () => {
          const p = field("PORT");
          if (p !== undefined) resolvePort(Number(p));
        });
        void exited.then((why) =>
          reject(new Error(`worker exited before listening: ${why} ${stderr}`)),
        );
      });

      // A: operator が allow する (応答の後で resolved の emit が throw する)。
      const a = postNode(port, {
        ...PRE_HIGH,
        session_id: "s-a",
        tool_input: { command: "rm -rf /tmp/a" },
      });
      await new Promise((r) => setTimeout(r, 30));
      // B: A の解決時点でまだ承認待ち (誰も決めない → timeout で安全側 deny)。
      const b = postNode(port, {
        ...PRE_HIGH,
        session_id: "s-b",
        tool_input: { command: "rm -rf /tmp/b" },
      });
      const [ra, rb] = await Promise.all([a, b]);
      const alive = await Promise.race([
        exited,
        new Promise<string>((r) => setTimeout(() => r("ALIVE"), 300)),
      ]);

      // 前提 (QA-FC-R2-2): rejection net 0・未処理 rejection は既定 (= throw して落ちる) モード・
      // resolved の emit が実際に throw した。どれかが崩れると「落ちなかった」は何も証明しない。
      expect(field("NETS")).toBe("0");
      expect(field("UNHANDLED")).toBe("default");
      expect((stdout.match(/^THROW$/gm) ?? []).length).toBeGreaterThanOrEqual(1);

      expect(alive, `worker died: ${stderr.split("\n").slice(0, 3).join(" / ")}`).toBe("ALIVE");
      expect(ra.error).toBeUndefined();
      expect(JSON.parse(ra.body ?? "{}")).toMatchObject({
        hookSpecificOutput: { permissionDecision: "allow" },
      });
      // B は接続断 (= 上流では non-blocking で承認なしに実行) でなく、明示 deny を受け取る。
      expect(rb.error, "concurrent approval lost its connection").toBeUndefined();
      expect(rb.status).toBe(200);
      expect(JSON.parse(rb.body ?? "{}")).toMatchObject({
        hookSpecificOutput: { permissionDecision: "deny" },
      });
    } finally {
      const workerPid = Number(field("PID"));
      if (child.pid !== undefined) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          /* 既に終了 */
        }
      }
      // worker 実体 (孫) が実際に消えたことを確認する (QA-FC-R2-1: 孤児を残さない)。
      expect(Number.isInteger(workerPid) && workerPid > 0, "worker never reported its pid").toBe(
        true,
      );
      let gone = false;
      for (let i = 0; i < 200 && !gone; i++) {
        try {
          process.kill(workerPid, 0);
          await new Promise((r) => setTimeout(r, 10));
        } catch (err) {
          gone = (err as NodeJS.ErrnoException).code === "ESRCH";
        }
      }
      expect(gone, `worker pid ${workerPid} survived the group kill`).toBe(true);
    }
  }, 30_000);
});
