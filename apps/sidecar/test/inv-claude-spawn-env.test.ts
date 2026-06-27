/**
 * INV-CLAUDE-SPAWN-ENV (SEC, task 019ea341-270f) — claude managed-runner spawn env の最小権限 allowlist。
 *
 * managed-runner.ts は claude を PTY spawn する。全 env 継承 (`{...process.env}`) をやめ
 * buildChildEnv({ extraAllowedKeys: CLAUDE_EXTRA_ENV_KEYS }) で構築する。本テストは fake source env を
 * 注入し、(1) sidecar 機密 (INGEST_TOKEN / ACTRADECK_*) が strip、(2) base allowlist 保持、
 * (3) claude provider 認証 (Anthropic API / AWS Bedrock / Vertex) が継承、(4) 親 CC セッション runtime
 * (CLAUDE_CODE_SESSION_ID 等) が drop、(5) 未知 env が fail-safe drop、を固定する。
 *
 * 🔴 すべて fake env。実 process.env の機密を test に焼かない (source を明示注入)。
 * inv-codex-child-env.test.ts を mirror する。
 */
import { afterEach, describe, expect, it } from "vitest";

import {
  buildChildEnv,
  CLAUDE_EXTRA_ENV_KEYS,
  CLAUDE_EXTRA_ENV_PREFIXES,
} from "../src/child-env.js";
import {
  startManagedClaude,
  type ManagedRunnerOptions,
  type PtyLike,
  type PtySpawnOptions,
} from "../src/managed-runner.js";
import type { SessionIdentity } from "../src/session-identity.js";
import type { EventSink } from "../src/sink.js";

describe("INV-CLAUDE-SPAWN-ENV: managed claude child env allowlist (SEC)", () => {
  it("strips INGEST_TOKEN (backend Bearer) from claude child env", () => {
    const env = buildChildEnv({
      source: { PATH: "/usr/bin", HOME: "/home/x", INGEST_TOKEN: "super-secret-bearer" },
      extraAllowedKeys: CLAUDE_EXTRA_ENV_KEYS,
    });
    expect(env.INGEST_TOKEN).toBeUndefined();
    // key も value も leak しない。
    expect(Object.values(env)).not.toContain("super-secret-bearer");
  });

  it("strips all ACTRADECK_* control vars (incl. ACTRADECK_SESSION)", () => {
    const env = buildChildEnv({
      source: {
        PATH: "/usr/bin",
        ACTRADECK_SESSION: "sess_x",
        ACTRADECK_WS_URL: "ws://127.0.0.1:55410",
        ACTRADECK_DB: "/tmp/db",
        ACTRADECK_CLAUDE_BIN: "/x/claude",
      },
      extraAllowedKeys: CLAUDE_EXTRA_ENV_KEYS,
    });
    for (const k of Object.keys(env)) {
      expect(k.startsWith("ACTRADECK_")).toBe(false);
    }
    expect(env.ACTRADECK_SESSION).toBeUndefined();
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
      extraAllowedKeys: CLAUDE_EXTRA_ENV_KEYS,
    });
    expect(env.PATH).toBe("/usr/bin:/bin");
    expect(env.HOME).toBe("/home/x");
    expect(env.LANG).toBe("en_US.UTF-8");
    expect(env.TERM).toBe("xterm-256color");
    expect(env.TMPDIR).toBe("/tmp");
  });

  it("preserves claude provider auth env (Anthropic API / Bedrock / Vertex)", () => {
    const env = buildChildEnv({
      source: {
        PATH: "/usr/bin",
        // Anthropic direct
        ANTHROPIC_API_KEY: "sk-ant-fake",
        ANTHROPIC_BASE_URL: "https://api.anthropic.com",
        ANTHROPIC_MODEL: "claude-fake",
        // Bedrock
        CLAUDE_CODE_USE_BEDROCK: "1",
        AWS_REGION: "us-east-1",
        AWS_ACCESS_KEY_ID: "AKIA_FAKE",
        AWS_SECRET_ACCESS_KEY: "secret-fake",
        AWS_SESSION_TOKEN: "session-fake",
        // Vertex
        CLAUDE_CODE_USE_VERTEX: "1",
        CLOUD_ML_REGION: "us-central1",
        ANTHROPIC_VERTEX_PROJECT_ID: "proj-fake",
        GOOGLE_APPLICATION_CREDENTIALS: "/tmp/gcp.json",
      },
      extraAllowedKeys: CLAUDE_EXTRA_ENV_KEYS,
    });
    // claude 自身の資格情報なので継承して良い。
    expect(env.ANTHROPIC_API_KEY).toBe("sk-ant-fake");
    expect(env.ANTHROPIC_BASE_URL).toBe("https://api.anthropic.com");
    expect(env.ANTHROPIC_MODEL).toBe("claude-fake");
    expect(env.CLAUDE_CODE_USE_BEDROCK).toBe("1");
    expect(env.AWS_REGION).toBe("us-east-1");
    expect(env.AWS_ACCESS_KEY_ID).toBe("AKIA_FAKE");
    expect(env.AWS_SECRET_ACCESS_KEY).toBe("secret-fake");
    expect(env.AWS_SESSION_TOKEN).toBe("session-fake");
    expect(env.CLAUDE_CODE_USE_VERTEX).toBe("1");
    expect(env.CLOUD_ML_REGION).toBe("us-central1");
    expect(env.ANTHROPIC_VERTEX_PROJECT_ID).toBe("proj-fake");
    expect(env.GOOGLE_APPLICATION_CREDENTIALS).toBe("/tmp/gcp.json");
  });

  it("drops parent Claude Code session runtime vars (child must not impersonate parent session)", () => {
    const env = buildChildEnv({
      source: {
        PATH: "/usr/bin",
        CLAUDE_CODE_SESSION_ID: "parent-sess",
        CLAUDE_CODE_CHILD_SESSION: "parent-child",
        CLAUDECODE: "1",
        CLAUDE_CODE_ENTRYPOINT: "cli",
        CLAUDE_CODE_EXECPATH: "/usr/bin/claude",
      },
      extraAllowedKeys: CLAUDE_EXTRA_ENV_KEYS,
    });
    expect(env.CLAUDE_CODE_SESSION_ID).toBeUndefined();
    expect(env.CLAUDE_CODE_CHILD_SESSION).toBeUndefined();
    expect(env.CLAUDECODE).toBeUndefined();
    expect(env.CLAUDE_CODE_ENTRYPOINT).toBeUndefined();
    expect(env.CLAUDE_CODE_EXECPATH).toBeUndefined();
    expect(env.PATH).toBe("/usr/bin");
  });

  it("drops unknown env by default (fail-safe: future secrets do not auto-leak)", () => {
    const env = buildChildEnv({
      source: { PATH: "/usr/bin", RANDOM_SECRET: "leak-me", SOME_FUTURE_TOKEN: "x" },
      extraAllowedKeys: CLAUDE_EXTRA_ENV_KEYS,
    });
    expect(env.RANDOM_SECRET).toBeUndefined();
    expect(env.SOME_FUTURE_TOKEN).toBeUndefined();
    expect(env.PATH).toBe("/usr/bin");
  });

  it("CLAUDE_EXTRA_ENV_KEYS/_PREFIXES do not contain sidecar secrets or parent-session runtime vars", () => {
    // 設計不変条件: 追加許可リスト/prefix に sidecar 機密 / 親セッション runtime を絶対に書かない。
    for (const k of [...CLAUDE_EXTRA_ENV_KEYS, ...CLAUDE_EXTRA_ENV_PREFIXES]) {
      expect(k.startsWith("ACTRADECK_")).toBe(false);
      expect(k).not.toBe("INGEST_TOKEN");
      expect(k.startsWith("CLAUDE_CODE_SESSION")).toBe(false);
      expect(k).not.toBe("CLAUDE_CODE_CHILD_SESSION");
      expect(k).not.toBe("CLAUDECODE");
      expect(k).not.toBe("CLAUDE_CODE_ENTRYPOINT");
      expect(k).not.toBe("CLAUDE_CODE_EXECPATH");
    }
  });

  // --- TDA-2: provider-config model alias keys + prefix-allow ---

  it("preserves model alias override env (Sonnet/Opus/Fable/Haiku symmetry)", () => {
    const env = buildChildEnv({
      source: {
        PATH: "/usr/bin",
        ANTHROPIC_DEFAULT_HAIKU_MODEL: "haiku-x",
        ANTHROPIC_DEFAULT_SONNET_MODEL: "sonnet-x",
        ANTHROPIC_DEFAULT_OPUS_MODEL: "opus-x",
        ANTHROPIC_DEFAULT_FABLE_MODEL: "fable-x",
      },
      extraAllowedKeys: CLAUDE_EXTRA_ENV_KEYS,
    });
    // Haiku だけ通る非対称を解消 (全 tier が継承される)。
    expect(env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe("haiku-x");
    expect(env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe("sonnet-x");
    expect(env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe("opus-x");
    expect(env.ANTHROPIC_DEFAULT_FABLE_MODEL).toBe("fable-x");
  });

  it("preserves Vertex per-model region via extraAllowedPrefixes", () => {
    const env = buildChildEnv({
      source: {
        PATH: "/usr/bin",
        VERTEX_REGION_CLAUDE_US_EAST5: "us-east5",
        VERTEX_REGION_CLAUDE_3_7_SONNET: "europe-west1",
        UNRELATED_REGION: "drop-me",
      },
      extraAllowedKeys: CLAUDE_EXTRA_ENV_KEYS,
      extraAllowedPrefixes: CLAUDE_EXTRA_ENV_PREFIXES,
    });
    expect(env.VERTEX_REGION_CLAUDE_US_EAST5).toBe("us-east5");
    expect(env.VERTEX_REGION_CLAUDE_3_7_SONNET).toBe("europe-west1");
    // prefix 非一致は通らない。
    expect(env.UNRELATED_REGION).toBeUndefined();
  });

  it("isSidecarSecretKey wins over extraAllowedPrefixes (fake ACTRADECK_-prefixed input is dropped)", () => {
    const env = buildChildEnv({
      source: {
        PATH: "/usr/bin",
        // 攻撃的入力: prefix-allow を悪用して機密を再混入させようとする。
        ACTRADECK_SECRET: "leak-me",
        INGEST_TOKEN: "bearer-leak",
        VERTEX_REGION_CLAUDE_OK: "keep",
      },
      extraAllowedKeys: CLAUDE_EXTRA_ENV_KEYS,
      // 偽 prefix を渡しても二重防御が勝つ。
      extraAllowedPrefixes: [...CLAUDE_EXTRA_ENV_PREFIXES, "ACTRADECK_", "INGEST_"],
    });
    expect(env.ACTRADECK_SECRET).toBeUndefined();
    expect(env.INGEST_TOKEN).toBeUndefined();
    expect(Object.values(env)).not.toContain("leak-me");
    expect(Object.values(env)).not.toContain("bearer-leak");
    // 正当な prefix キーは通る。
    expect(env.VERTEX_REGION_CLAUDE_OK).toBe("keep");
  });

  // --- QA-2: re-admission (codex と対称) ---

  it("extraAllowedKeys cannot re-admit sidecar secrets (claude double-defense, mirror of codex)", () => {
    const env = buildChildEnv({
      source: { PATH: "/usr/bin", ANTHROPIC_API_KEY: "sk-ant", INGEST_TOKEN: "secret" },
      extraAllowedKeys: [...CLAUDE_EXTRA_ENV_KEYS, "INGEST_TOKEN"],
    });
    expect(env.ANTHROPIC_API_KEY).toBe("sk-ant"); // 正当な extra は通る
    expect(env.INGEST_TOKEN).toBeUndefined(); // 機密は二重防御で落ちる
  });

  // --- QA-3: 誤追加の強制検知 (リスト固定) ---

  it("CLAUDE_EXTRA_ENV_KEYS is pinned exactly (forces review on accidental add/remove)", () => {
    expect([...CLAUDE_EXTRA_ENV_KEYS]).toEqual([
      // Anthropic API (direct)
      "ANTHROPIC_API_KEY",
      "ANTHROPIC_AUTH_TOKEN",
      "ANTHROPIC_BASE_URL",
      "ANTHROPIC_CUSTOM_HEADERS",
      "ANTHROPIC_MODEL",
      "ANTHROPIC_SMALL_FAST_MODEL",
      "ANTHROPIC_DEFAULT_HAIKU_MODEL",
      "ANTHROPIC_DEFAULT_SONNET_MODEL",
      "ANTHROPIC_DEFAULT_OPUS_MODEL",
      "ANTHROPIC_DEFAULT_FABLE_MODEL",
      // Amazon Bedrock
      "CLAUDE_CODE_USE_BEDROCK",
      "CLAUDE_CODE_SKIP_BEDROCK_AUTH",
      "ANTHROPIC_BEDROCK_BASE_URL",
      "AWS_REGION",
      "AWS_DEFAULT_REGION",
      "AWS_PROFILE",
      "AWS_BEARER_TOKEN_BEDROCK",
      "AWS_ACCESS_KEY_ID",
      "AWS_SECRET_ACCESS_KEY",
      "AWS_SESSION_TOKEN",
      // Google Vertex AI
      "CLAUDE_CODE_USE_VERTEX",
      "CLAUDE_CODE_SKIP_VERTEX_AUTH",
      "ANTHROPIC_VERTEX_BASE_URL",
      "CLOUD_ML_REGION",
      "ANTHROPIC_VERTEX_PROJECT_ID",
      "GOOGLE_APPLICATION_CREDENTIALS",
    ]);
    expect([...CLAUDE_EXTRA_ENV_PREFIXES]).toEqual(["VERTEX_REGION_CLAUDE_"]);
  });
});

/**
 * QA-1 — startManagedClaude が実際に allowlisted env で spawn する **配線** を falsifiable に pin する。
 * buildChildEnv 直叩きだけでは managed-runner.ts の spawn 呼出を `{...process.env}` に戻しても検知できない。
 * fake spawnPty seam を注入し、spawn に渡った opts.env を観測する。
 *
 * 🔴 fake env は process.env に一時設定 (afterEach で復元)。pty/collector/monitor は最小フェイクで満たす。
 */
describe("INV-CLAUDE-SPAWN-ENV: startManagedClaude spawn wiring pin (QA-1)", () => {
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

  function makeFakePty(): PtyLike {
    return {
      pid: 4242,
      onData: () => ({ dispose: () => {} }),
      onExit: () => ({ dispose: () => {} }),
      write: () => {},
      resize: () => {},
      kill: () => {},
    };
  }

  function run(): {
    capturedEnv: NodeJS.ProcessEnv;
    session: ReturnType<typeof startManagedClaude>;
  } {
    let capturedEnv: NodeJS.ProcessEnv = {};
    const sink = { emit: () => {} } as unknown as EventSink;
    // SessionIdentity の本テストで触れない surface は呼ばれない (spawn 直後に観測して dispose)。
    const identity = {
      emitMonitoring: () => {},
    } as unknown as SessionIdentity;
    const opts: ManagedRunnerOptions = {
      sink,
      hookEndpoint: "http://127.0.0.1:0/hook",
      identity,
      // 非 TTY フェイク端末 (raw mode 化・resize・stdin 転送をスキップさせる)。
      terminal: {
        stdin: { on: () => {}, off: () => {} },
        stdout: { write: () => true, on: () => {}, off: () => {} },
      },
      spawnPty: (_file, _args, o: PtySpawnOptions) => {
        capturedEnv = o.env;
        return makeFakePty();
      },
    };
    const session = startManagedClaude(opts);
    return { capturedEnv, session };
  }

  it("spawns claude with allowlisted env (strips INGEST_TOKEN/ACTRADECK_*, keeps PATH/ANTHROPIC_API_KEY)", () => {
    setEnv("INGEST_TOKEN", "wiring-bearer-sentinel");
    setEnv("ACTRADECK_SESSION", "wiring-sess-sentinel");
    setEnv("ACTRADECK_DB", "/tmp/wiring-db");
    setEnv("ANTHROPIC_API_KEY", "sk-ant-wiring");
    setEnv("PATH", process.env.PATH ?? "/usr/bin");

    const { capturedEnv, session } = run();
    try {
      // leak ガード: 機密が spawn env に乗らない。
      expect(capturedEnv.INGEST_TOKEN).toBeUndefined();
      expect(capturedEnv.ACTRADECK_SESSION).toBeUndefined();
      expect(capturedEnv.ACTRADECK_DB).toBeUndefined();
      for (const k of Object.keys(capturedEnv)) {
        expect(k.startsWith("ACTRADECK_")).toBe(false);
      }
      expect(Object.values(capturedEnv)).not.toContain("wiring-bearer-sentinel");
      expect(Object.values(capturedEnv)).not.toContain("wiring-sess-sentinel");
      // 正当な env は通る。
      expect(capturedEnv.ANTHROPIC_API_KEY).toBe("sk-ant-wiring");
      expect(capturedEnv.PATH).toBe(process.env.PATH);
    } finally {
      session.dispose();
    }
  });
});
