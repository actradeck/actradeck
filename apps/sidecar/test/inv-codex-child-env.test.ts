/**
 * INV-CODEX-SPAWN-ENV (SEC-1) — 子プロセス spawn env の最小権限 allowlist。
 *
 * Sidecar が managed CLI を spawn する際、全 env を継承させない。`INGEST_TOKEN`
 * (backend ingestion Bearer) / `ACTRADECK_*` 制御変数は child へ漏らさない (最小権限)。
 * buildChildEnv が allowlist で構築し、機密 env が確実に strip されることを固定する。
 */
import { afterEach, describe, expect, it } from "vitest";

import { buildChildEnv } from "../src/child-env.js";
import { startManagedCodex, type ChildLike, type ChildSpawnOptions } from "../src/codex-runner.js";
import { ApprovalBridge } from "../src/approval-bridge.js";
import { SessionIdentity } from "../src/session-identity.js";
import type { EventSink } from "../src/sink.js";

describe("INV-CODEX-SPAWN-ENV: child env allowlist (SEC-1)", () => {
  it("strips INGEST_TOKEN (backend Bearer) from child env", () => {
    const env = buildChildEnv({
      source: { PATH: "/usr/bin", HOME: "/home/x", INGEST_TOKEN: "super-secret-bearer" },
    });
    expect(env.INGEST_TOKEN).toBeUndefined();
    // 値が一切 leak しない (key も value も)。
    expect(Object.values(env)).not.toContain("super-secret-bearer");
  });

  it("strips all ACTRADECK_* control vars", () => {
    const env = buildChildEnv({
      source: {
        PATH: "/usr/bin",
        ACTRADECK_SESSION: "sess_x",
        ACTRADECK_WS_URL: "ws://127.0.0.1:55410",
        ACTRADECK_DB: "/tmp/db",
        ACTRADECK_CODEX_BIN: "/x/codex",
      },
    });
    for (const k of Object.keys(env)) {
      expect(k.startsWith("ACTRADECK_")).toBe(false);
    }
  });

  it("preserves base allowlist keys (PATH/HOME/locale/term)", () => {
    const env = buildChildEnv({
      source: {
        PATH: "/usr/bin:/bin",
        HOME: "/home/x",
        LANG: "en_US.UTF-8",
        TERM: "xterm-256color",
        TMPDIR: "/tmp",
      },
    });
    expect(env.PATH).toBe("/usr/bin:/bin");
    expect(env.HOME).toBe("/home/x");
    expect(env.LANG).toBe("en_US.UTF-8");
    expect(env.TERM).toBe("xterm-256color");
    expect(env.TMPDIR).toBe("/tmp");
  });

  it("drops unknown env by default (fail-safe: future secrets do not auto-leak)", () => {
    const env = buildChildEnv({
      source: { PATH: "/usr/bin", SOME_FUTURE_SECRET: "leak-me", AWS_SECRET_ACCESS_KEY: "x" },
    });
    expect(env.SOME_FUTURE_SECRET).toBeUndefined();
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(env.PATH).toBe("/usr/bin");
  });

  it("extraAllowedKeys unions but cannot re-admit sidecar secrets (double defense)", () => {
    const env = buildChildEnv({
      source: { PATH: "/usr/bin", CODEX_HOME: "/home/x/.codex", INGEST_TOKEN: "secret" },
      extraAllowedKeys: ["CODEX_HOME", "INGEST_TOKEN"], // INGEST_TOKEN を許可しようとしても
    });
    expect(env.CODEX_HOME).toBe("/home/x/.codex"); // 正当な extra は通る
    expect(env.INGEST_TOKEN).toBeUndefined(); // 機密は二重防御で落ちる
  });

  it("omits keys whose value is undefined", () => {
    const env = buildChildEnv({ source: { PATH: "/usr/bin", HOME: undefined } });
    expect("HOME" in env).toBe(false);
    expect(env.PATH).toBe("/usr/bin");
  });
});

/**
 * startManagedCodex が実際に allowlisted env で spawn する **配線** を falsifiable に pin する
 * (QA carryover / TDA-5・claude QA-1 と同型・mirror of inv-claude-spawn-env QA-1)。
 *
 * buildChildEnv 直叩きだけでは codex-runner.ts の spawn 呼出を `{...process.env}` に戻しても検知できない。
 * 旧 zero-arg seam (`spawnChild: () => ChildLike`) は env を観測できず、env が既定枝の内部で構築され
 * 注入時にバイパスされて配線が未 pin だった。新 seam `(file, args, opts)` で渡る `opts.env` を観測する。
 *
 * 🔴 mutation: codex-runner の env 構築を `buildChildEnv()` → `{...process.env}` に戻すと、本 wiring pin
 *   のみ赤化する (上の buildChildEnv 直叩きテストは緑のまま) → 配線 pin として機能する。
 * 🔴 fake env は process.env に一時設定 (afterEach で復元)。child は最小フェイクで満たし spawn 直後に dispose。
 */
describe("INV-CODEX-SPAWN-ENV: startManagedCodex spawn wiring pin (QA carryover / TDA-5)", () => {
  const SAVED = new Map<string, string | undefined>();
  const setEnv = (k: string, v: string): void => {
    if (!SAVED.has(k)) SAVED.set(k, process.env[k]);
    process.env[k] = v;
  };

  afterEach(() => {
    for (const [k, v] of SAVED) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    SAVED.clear();
  });

  /** spawn の I/O 境界だけ満たす最小フェイク子プロセス (handshake には応答しない → spawn 直後に dispose)。 */
  function makeFakeChild(): ChildLike {
    return {
      pid: undefined, // monitor を起動させない (PID 監視ノイズ回避)。
      stdin: { write: () => true },
      stdout: { on: () => {}, off: () => {} },
      stderr: { on: () => {} },
      on: () => {},
      kill: () => true,
    };
  }

  function run(): {
    capturedEnv: NodeJS.ProcessEnv;
    session: ReturnType<typeof startManagedCodex>;
  } {
    let capturedEnv: NodeJS.ProcessEnv = {};
    const sink = { emit: () => {} } as unknown as EventSink;
    const identity = new SessionIdentity({ fallbackSessionId: "sess_wiring", flushTimeoutMs: 0 });
    const approvalBridge = new ApprovalBridge({ timeoutMs: 1000 });
    const session = startManagedCodex({
      sink,
      approvalBridge,
      identity,
      heartbeatMs: 999_999,
      spawnChild: (_file: string, _args: readonly string[], o: ChildSpawnOptions) => {
        capturedEnv = o.env;
        return makeFakeChild();
      },
    });
    return { capturedEnv, session };
  }

  it("spawns codex with allowlisted env (strips INGEST_TOKEN/ACTRADECK_*, keeps PATH)", () => {
    setEnv("INGEST_TOKEN", "codex-wiring-bearer-sentinel");
    setEnv("ACTRADECK_SESSION", "codex-wiring-sess-sentinel");
    setEnv("ACTRADECK_DB", "/tmp/codex-wiring-db");
    setEnv("PATH", process.env.PATH ?? "/usr/bin");

    const { capturedEnv, session } = run();
    try {
      // leak ガード: sidecar 機密が spawn env に乗らない (key も value も)。
      expect(capturedEnv.INGEST_TOKEN).toBeUndefined();
      expect(capturedEnv.ACTRADECK_SESSION).toBeUndefined();
      expect(capturedEnv.ACTRADECK_DB).toBeUndefined();
      for (const k of Object.keys(capturedEnv)) {
        expect(k.startsWith("ACTRADECK_")).toBe(false);
      }
      expect(Object.values(capturedEnv)).not.toContain("codex-wiring-bearer-sentinel");
      expect(Object.values(capturedEnv)).not.toContain("codex-wiring-sess-sentinel");
      // 正当な base env は通る。
      expect(capturedEnv.PATH).toBe(process.env.PATH);
    } finally {
      session.dispose();
    }
  });
});
