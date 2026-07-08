/**
 * INV-SAFETY-DEMO: first-run セーフティデモ起動コントローラ + route ガード (ADR 019f22a7 P1)。
 *
 * 縛る不変条件 (falsifiable・mutation で赤):
 *  - INV-DEMO-SINGLE-FLIGHT: 走行中は新規 spawn せず現行 session_id を返す (多重起動抑止)。
 *    子 exit / spawn error で状態がクリアされ次回起動を許す。
 *  - INV-DEMO-NO-USER-INPUT: 起動は固定コマンド (spawner) のみで、session_id は内部生成の
 *    `demo-safety-` prefix。argv/コマンドへユーザー入力を渡さない (env でのみ子へ渡す)。
 *  - INV-DEMO-FAIL-SAFE: disabled → 503・spawn 同期失敗 → 500・throw しない値ベース (SEC-R3-3)。
 *  - INV-DEMO-ROUTE-AUTH: route は REALTIME_TOKEN gate 背後。launcher 未配線 → 404。method-pure POST。
 *
 * REAL DATA ONLY 規律: 本 suite は launcher の状態機械と route 層の分岐を対象とし、実際の子デモ
 * (sidecar → ingestion → event store) の駆動は real-stack e2e (手動検証・報告参照) が担保する。
 * ここでは spawner を fake 化し spawn 副作用なしに決定論で固定する。
 */
import { afterEach, describe, expect, it } from "vitest";
import Fastify from "fastify";
import fastifyWebsocket from "@fastify/websocket";

import type { FastifyInstance } from "fastify";

import { registerRealtimeRoute } from "../src/realtime-server.js";
import { SidecarRegistry } from "../src/sidecar-registry.js";
import { dirname, join } from "node:path";

import {
  SafetyDemoLauncher,
  SAFETY_DEMO_SESSION_PREFIX,
  resolveDefaultDriverPath,
  defaultDemoSpawnSpec,
  makeDefaultSpawner,
  type DemoChildHandle,
  type DemoSpawner,
} from "../src/safety-demo.js";
import type { RealtimeHub } from "../src/realtime-hub.js";
import type { RealtimeStore } from "../src/realtime-store.js";
import type { ReplayStore } from "../src/replay-store.js";
import type { AuditStore } from "../src/audit-store.js";

const REALTIME_TOKEN = "test-realtime-token-safety-demo-abcdefghij";

/** exit/error を手動発火できる fake 子プロセス (spawn 副作用なし)。 */
class FakeChild implements DemoChildHandle {
  readonly pid = 4242;
  killed = false;
  killSignal: NodeJS.Signals | undefined;
  private exitCbs: Array<(code: number | null) => void> = [];
  private errorCbs: Array<(err: Error) => void> = [];
  on(event: "exit", listener: (code: number | null) => void): void;
  on(event: "error", listener: (err: Error) => void): void;
  on(event: "exit" | "error", listener: (arg: never) => void): void {
    if (event === "exit") this.exitCbs.push(listener as (code: number | null) => void);
    else this.errorCbs.push(listener as (err: Error) => void);
  }
  kill(signal?: NodeJS.Signals): boolean {
    this.killed = true;
    this.killSignal = signal;
    return true;
  }
  emitExit(code: number | null): void {
    for (const cb of this.exitCbs) cb(code);
  }
  emitError(err: Error): void {
    for (const cb of this.errorCbs) cb(err);
  }
}

/** 各起動の request を採取し FakeChild を返す fake spawner。 */
function recordingSpawner(): {
  spawner: DemoSpawner;
  requests: Array<{ sessionId: string; env: NodeJS.ProcessEnv }>;
  children: FakeChild[];
} {
  const requests: Array<{ sessionId: string; env: NodeJS.ProcessEnv }> = [];
  const children: FakeChild[] = [];
  const spawner: DemoSpawner = (req) => {
    requests.push({ sessionId: req.sessionId, env: req.env });
    const child = new FakeChild();
    children.push(child);
    return child;
  };
  return { spawner, requests, children };
}

describe("INV-SAFETY-DEMO launcher (state machine)", () => {
  it("INV-DEMO-SINGLE-FLIGHT: 走行中は新規 spawn せず現行 session_id を返す", () => {
    const { spawner, requests } = recordingSpawner();
    let n = 0;
    const launcher = new SafetyDemoLauncher({
      ingestToken: "tok",
      spawner,
      idFactory: () => `${SAFETY_DEMO_SESSION_PREFIX}fixed${n++}`,
    });
    expect(launcher.currentSessionId()).toBeUndefined();
    const first = launcher.launch();
    expect(first.ok).toBe(true);
    expect(first.status).toBe(200);
    expect(first.sessionId).toBe(`${SAFETY_DEMO_SESSION_PREFIX}fixed0`);
    expect(first.alreadyRunning).toBeUndefined();
    expect(requests).toHaveLength(1);
    expect(launcher.currentSessionId()).toBe(`${SAFETY_DEMO_SESSION_PREFIX}fixed0`);

    // 二度目は走行中 → 新規 spawn せず現行を返す。
    const second = launcher.launch();
    expect(second.ok).toBe(true);
    expect(second.status).toBe(200);
    expect(second.sessionId).toBe(`${SAFETY_DEMO_SESSION_PREFIX}fixed0`);
    expect(second.alreadyRunning).toBe(true);
    expect(requests).toHaveLength(1); // spawn は増えない (多重起動抑止)。
  });

  it("子 exit で状態がクリアされ次回起動を許す", () => {
    const { spawner, requests, children } = recordingSpawner();
    let n = 0;
    const launcher = new SafetyDemoLauncher({
      ingestToken: "tok",
      spawner,
      idFactory: () => `${SAFETY_DEMO_SESSION_PREFIX}s${n++}`,
    });
    launcher.launch();
    expect(launcher.running).toBe(true);
    children[0].emitExit(0);
    expect(launcher.running).toBe(false);
    // 次回は新規 spawn (別 session_id)。
    const again = launcher.launch();
    expect(again.sessionId).toBe(`${SAFETY_DEMO_SESSION_PREFIX}s1`);
    expect(requests).toHaveLength(2);
  });

  it("spawn error (非同期) で状態がクリアされる", () => {
    const { spawner, children } = recordingSpawner();
    const launcher = new SafetyDemoLauncher({ ingestToken: "tok", spawner });
    launcher.launch();
    expect(launcher.running).toBe(true);
    children[0].emitError(new Error("ENOENT"));
    expect(launcher.running).toBe(false);
  });

  it("INV-DEMO-NO-USER-INPUT: session_id は内部生成 prefix・INGEST_TOKEN と hold を env で子へ渡す", () => {
    const { spawner, requests } = recordingSpawner();
    const launcher = new SafetyDemoLauncher({ ingestToken: "secret-ingest-tok", spawner });
    const res = launcher.launch();
    expect(res.sessionId?.startsWith(SAFETY_DEMO_SESSION_PREFIX)).toBe(true);
    const env = requests[0].env;
    expect(env.INGEST_TOKEN).toBe("secret-ingest-tok");
    expect(env.ACTRADECK_DEMO_APPROVAL).toBe("hold");
    expect(env.ACTRADECK_DEMO_SESSION_ID).toBe(res.sessionId);
  });

  it("INV-DEMO-NO-USER-INPUT: backend の機微 env (REALTIME_TOKEN/DATABASE_URL/PG*) は子 env へ流入しない (最小権限)", () => {
    // 子 sidecar は temp SQLite を使い PG にも REALTIME_TOKEN にも実依存しない (WS 送信は INGEST_TOKEN
    // のみ)。ゆえに backend の credential を子プロセスへ流入させない。launch 前に親 env を汚染しておき、
    // 子 env に不在 (scrub 済) であることを固定する (現行スプレッド実装なら赤・scrub 実装で緑)。
    const saved: Record<string, string | undefined> = {
      REALTIME_TOKEN: process.env.REALTIME_TOKEN,
      DATABASE_URL: process.env.DATABASE_URL,
      PGPASSWORD: process.env.PGPASSWORD,
      PGUSER: process.env.PGUSER,
      PGHOST: process.env.PGHOST,
      PGDATABASE: process.env.PGDATABASE,
      PGPORT: process.env.PGPORT,
    };
    try {
      process.env.REALTIME_TOKEN = "leak-realtime-token-should-not-propagate";
      process.env.DATABASE_URL = "postgres://leakuser:leakpass@leakhost:5432/leakdb";
      process.env.PGPASSWORD = "leak-pg-password";
      process.env.PGUSER = "leak-pg-user";
      process.env.PGHOST = "leak-pg-host";
      process.env.PGDATABASE = "leak-pg-database";
      process.env.PGPORT = "5432";

      const { spawner, requests } = recordingSpawner();
      const launcher = new SafetyDemoLauncher({ ingestToken: "secret-ingest-tok", spawner });
      const res = launcher.launch();
      const env = requests[0].env;

      // 機微 env は子へ渡らない (scrub)。
      expect(env.REALTIME_TOKEN).toBeUndefined();
      expect(env.DATABASE_URL).toBeUndefined();
      expect(env.PGPASSWORD).toBeUndefined();
      expect(env.PGUSER).toBeUndefined();
      expect(env.PGHOST).toBeUndefined();
      expect(env.PGDATABASE).toBeUndefined();
      expect(env.PGPORT).toBeUndefined();

      // positive: 子に必要な env は保持/注入されている (scrub が過剰でない)。
      expect(env.INGEST_TOKEN).toBe("secret-ingest-tok");
      expect(env.ACTRADECK_DEMO_APPROVAL).toBe("hold");
      expect(env.ACTRADECK_DEMO_SESSION_ID).toBe(res.sessionId);
      expect(env.PATH).toBe(process.env.PATH); // 実行基盤 env は保持 (pnpm/tsx 起動に必要)。
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });

  it("INV-DEMO-FAIL-SAFE: disabled → 503 (throw しない)", () => {
    const { spawner } = recordingSpawner();
    const launcher = new SafetyDemoLauncher({ ingestToken: "tok", spawner, enabled: false });
    const res = launcher.launch();
    expect(res.ok).toBe(false);
    expect(res.status).toBe(503);
    expect(launcher.running).toBe(false);
  });

  it("INV-DEMO-FAIL-SAFE: spawner 同期 throw → 500・状態据え置き (throw しない)", () => {
    const spawner: DemoSpawner = () => {
      throw new Error("boom");
    };
    const launcher = new SafetyDemoLauncher({ ingestToken: "tok", spawner });
    const res = launcher.launch();
    expect(res.ok).toBe(false);
    expect(res.status).toBe(500);
    expect(launcher.running).toBe(false);
  });

  it("resolveDefaultDriverPath: native-free 単一 driver の backend src 同居パスを返す (固定コードパス)", () => {
    const p = resolveDefaultDriverPath();
    // decision 019f387f: 旧 apps/sidecar/e2e/run-safety-demo.mts から backend src 同居の driver へ昇格
    // (Docker cockpit image が apps/sidecar を COPY しないため)。sibling 解決を回帰固定する。
    expect(p.endsWith(join("apps", "backend", "src", "safety-demo-driver.ts"))).toBe(true);
    expect(p.includes(join("apps", "sidecar"))).toBe(false); // 旧 sidecar 依存へ戻さない。
  });

  it("既定 launcher (spawner 非注入) を構成できる・enabled=false 明示で spawn せず 503", () => {
    // spawner 非注入 → 既定 spawner を構成する経路 (実 spawn はしない)。enabled を明示 false に
    // することで driver 実在の repo でも実プロセス起動を避けつつ constructor の既定経路を通す。
    const launcher = new SafetyDemoLauncher({ ingestToken: "tok", enabled: false });
    const res = launcher.launch();
    expect(res.status).toBe(503);
    expect(launcher.running).toBe(false);
  });

  it("dispose: 走行中の子を SIGTERM で kill し状態をクリアする (冪等)", () => {
    const { spawner, children } = recordingSpawner();
    const launcher = new SafetyDemoLauncher({ ingestToken: "tok", spawner });
    launcher.launch();
    launcher.dispose();
    expect(children[0].killed).toBe(true);
    expect(children[0].killSignal).toBe("SIGTERM");
    expect(launcher.running).toBe(false);
    // 二度目の dispose は no-op (冪等)。
    expect(() => launcher.dispose()).not.toThrow();
  });
});

describe("INV-SAFETY-DEMO route (POST /realtime/demo/safety)", () => {
  let app: FastifyInstance;

  afterEach(async () => {
    if (app) await app.close();
  });

  async function mount(demoLauncher?: SafetyDemoLauncher): Promise<FastifyInstance> {
    app = Fastify();
    await app.register(fastifyWebsocket);
    registerRealtimeRoute(app, {
      realtimeToken: REALTIME_TOKEN,
      hub: {} as unknown as RealtimeHub,
      store: {} as unknown as RealtimeStore,
      replayStore: {} as unknown as ReplayStore,
      auditStore: {} as unknown as AuditStore,
      sidecarRegistry: new SidecarRegistry(),
      ...(demoLauncher ? { demoLauncher } : {}),
    });
    await app.ready();
    return app;
  }

  const auth = { authorization: `Bearer ${REALTIME_TOKEN}` };

  it("INV-DEMO-ROUTE-AUTH: 無認証 POST → 401 (REALTIME_TOKEN gate)", async () => {
    const { spawner } = recordingSpawner();
    await mount(new SafetyDemoLauncher({ ingestToken: "tok", spawner }));
    const res = await app.inject({ method: "POST", url: "/realtime/demo/safety" });
    expect(res.statusCode).toBe(401);
  });

  it("launcher 未配線 → 404 (この配備でデモ導線を生やさない)", async () => {
    await mount(undefined);
    const res = await app.inject({ method: "POST", url: "/realtime/demo/safety", headers: auth });
    expect(res.statusCode).toBe(404);
  });

  it("成功 → 200 + session_id を返す", async () => {
    const { spawner } = recordingSpawner();
    await mount(
      new SafetyDemoLauncher({
        ingestToken: "tok",
        spawner,
        idFactory: () => `${SAFETY_DEMO_SESSION_PREFIX}route0`,
      }),
    );
    const res = await app.inject({ method: "POST", url: "/realtime/demo/safety", headers: auth });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { session_id?: string; already_running?: boolean };
    expect(body.session_id).toBe(`${SAFETY_DEMO_SESSION_PREFIX}route0`);
    expect(body.already_running).toBeUndefined();
  });

  it("走行中の再起動 → 200 + already_running + 同一 session_id", async () => {
    const { spawner, requests } = recordingSpawner();
    await mount(
      new SafetyDemoLauncher({
        ingestToken: "tok",
        spawner,
        idFactory: () => `${SAFETY_DEMO_SESSION_PREFIX}route-dup`,
      }),
    );
    await app.inject({ method: "POST", url: "/realtime/demo/safety", headers: auth });
    const res = await app.inject({ method: "POST", url: "/realtime/demo/safety", headers: auth });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { session_id?: string; already_running?: boolean };
    expect(body.already_running).toBe(true);
    expect(body.session_id).toBe(`${SAFETY_DEMO_SESSION_PREFIX}route-dup`);
    expect(requests).toHaveLength(1);
  });

  it("disabled launcher → 503 (fail-safe・error 本文)", async () => {
    const { spawner } = recordingSpawner();
    await mount(new SafetyDemoLauncher({ ingestToken: "tok", spawner, enabled: false }));
    const res = await app.inject({ method: "POST", url: "/realtime/demo/safety", headers: auth });
    expect(res.statusCode).toBe(503);
    expect((res.json() as { error?: string }).error).toBeTypeOf("string");
  });

  it("method-pure: GET は route 不一致で拒否 (POST-only)", async () => {
    const { spawner } = recordingSpawner();
    await mount(new SafetyDemoLauncher({ ingestToken: "tok", spawner }));
    const res = await app.inject({ method: "GET", url: "/realtime/demo/safety", headers: auth });
    expect(res.statusCode).toBe(404);
  });

  it("SEC 注記 pin (sweep 019f38b9): content-type JSON + 空 body は 400 (fail-loud・5xx/起動なし)", async () => {
    // Fastify は空 JSON body を content parser 段で FST_ERR_CTP_EMPTY_JSON_BODY として 400 にする。
    // 実 client (use-safety-demo.ts) は常に body "{}" を送るため到達しないが、「空 body でも
    // 5xx にならず・デモ子プロセスも起動しない」ことを回帰 pin する (脆さの開示・挙動固定)。
    const { spawner, requests } = recordingSpawner();
    await mount(new SafetyDemoLauncher({ ingestToken: "tok", spawner }));
    const res = await app.inject({
      method: "POST",
      url: "/realtime/demo/safety",
      headers: { ...auth, "content-type": "application/json" },
    });
    expect(res.statusCode).toBe(400);
    expect(requests.length).toBe(0); // parser 段で弾かれ launcher は呼ばれない。
  });
});

describe("INV-DEMO-SPAWN-PATH-INDEPENDENT: default spawner は pnpm でなく node(execPath)+tsx", () => {
  // 実機検証 (ADR 019f280c) で、旧 `spawn('pnpm', …)` が systemd --user の最小 PATH に pnpm が
  // 無いと ENOENT で黙って失敗し初回デモ CTA が route 200 のまま何も起きない欠陥を検出した。
  // default spawner が backend 自身の node (process.execPath・常在=PATH 非依存) + tsx で driver を
  // 直実行することを固定する (pnpm へ戻すと本テストが赤化する)。
  it("command は process.execPath (pnpm でない)・args は --import tsx <driver>・cwd は apps/backend", () => {
    const driver = resolveDefaultDriverPath();
    const spec = defaultDemoSpawnSpec(driver);
    expect(spec.command).toBe(process.execPath); // backend の node 実体
    expect(spec.command).not.toBe("pnpm"); // PATH 依存の pnpm を使わない
    expect(spec.args).toEqual(["--import", "tsx", driver]); // tsx ローダで driver 直実行
    // decision 019f387f: driver は backend src 同居 (apps/backend/src/…) ゆえ cwd は apps/backend
    // (tsx prod dep が解決する dir)。不変ロジック join(dirname(driver),"..") が driver 位置に追従する。
    expect(spec.cwd).toBe(join(dirname(driver), ".."));
    expect(spec.cwd.endsWith(join("apps", "backend"))).toBe(true);
    expect(driver.endsWith(join("apps", "backend", "src", "safety-demo-driver.ts"))).toBe(true);
  });

  // QA-1 (ADR 019f280c 監査): 純関数 spec だけでなく、launcher が実際に配線する makeDefaultSpawner
  // (load-bearing な wire) が spec を **消費して spawn を呼ぶ**ことを固定する。spec が正でも wire が
  // spec を無視して pnpm を spawn すれば旧欠陥が復活しうる — それを CI で赤化する。real spawn は
  // 起こさず spawnFn を DI で差し替えて引数を採取する。
  it("makeDefaultSpawner は spec を消費して spawn を呼ぶ (wire も pnpm でなく execPath+tsx)", () => {
    const driver = resolveDefaultDriverPath();
    const calls: Array<{
      command: string;
      args: readonly string[];
      opts: { cwd?: string; stdio?: unknown; shell?: boolean };
    }> = [];
    const fakeSpawn = ((
      command: string,
      args: readonly string[],
      opts: { cwd?: string; stdio?: unknown; shell?: boolean },
    ) => {
      calls.push({ command, args, opts });
      return new FakeChild();
    }) as unknown as typeof import("node:child_process").spawn;

    const spawner = makeDefaultSpawner(driver, fakeSpawn);
    spawner({ sessionId: "s-wire", env: { INGEST_TOKEN: "tok" } });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.command).toBe(process.execPath); // wire も backend の node (pnpm でない)
    expect(calls[0]?.command).not.toBe("pnpm");
    expect(calls[0]?.args).toEqual(["--import", "tsx", driver]);
    expect(calls[0]?.opts).toMatchObject({
      cwd: join(dirname(driver), ".."), // apps/sidecar
      stdio: "ignore", // 生データ混入面ゼロ
      shell: false, // injection 面ゼロ
    });
  });
});
