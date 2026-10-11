/**
 * daemon-cli / daemon-state の制御ロジック (ADR 019ea476 D1/D5)。
 *
 * - parseDaemonArgs: attach=start 別名 / scope/token-mode/dry-run/yes / codex 明示エラー。
 * - resolveSettingsPath: scope → settings file。
 * - runStart/runStop/runStatus: 二重起動防止・stale 判定・settings 配線/detach・state file 0600・
 *   token 値を state に書かない。すべて temp HOME / temp cwd (実設定不可侵)。
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

import { AttachDaemon } from "../src/attach-daemon.js";
import {
  cleanupStaleWiring,
  CodexAttachUnsupportedError,
  type DaemonRuntime,
  type DeniedStatusFloor,
  isDeniedOutcome,
  parseDaemonArgs,
  resolveSettingsPath,
  isUsableHookToken,
  runStart,
  runStatus,
  runStop,
  scopeNeedsConfirm,
  scopeTarget,
  type StartOutcome,
  startOutcomeExitCode,
  tokenModeLeaksToTrackedFile,
} from "../src/daemon-cli.js";
import { generateHookToken } from "../src/settings-injection.js";
import { isActradeckEntry } from "../src/settings-merge.js";

let home: string;
let cwd: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "actradeck-home-"));
  cwd = mkdtempSync(join(tmpdir(), "actradeck-cwd-"));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});

describe("parseDaemonArgs", () => {
  it("attach is an alias for daemon start", () => {
    const a = parseDaemonArgs(["attach"], cwd);
    expect(a.action).toBe("start");
    expect(a.scope).toBe("project-local"); // 既定
    expect(a.tokenMode).toBe("literal"); // 既定
  });

  it("parses daemon start with flags", () => {
    const a = parseDaemonArgs(
      ["daemon", "start", "--scope", "user", "--token-mode", "env", "--dry-run", "--yes"],
      cwd,
    );
    expect(a.action).toBe("start");
    expect(a.scope).toBe("user");
    expect(a.tokenMode).toBe("env");
    expect(a.dryRun).toBe(true);
    expect(a.yes).toBe(true);
  });

  it("rejects codex attach with explicit error (D5)", () => {
    expect(() => parseDaemonArgs(["attach", "codex"], cwd)).toThrow(CodexAttachUnsupportedError);
    expect(() => parseDaemonArgs(["daemon", "start", "codex"], cwd)).toThrow(
      CodexAttachUnsupportedError,
    );
  });

  // TDA-1: エラーメッセージは Managed 起動 (ops-CLI ラッパ) の実際に打てる案内を指す
  //   (bare `agentmon` は既定 PATH に無いため `./scripts/actradeck codex "<task>"` を主導・内部実体併記)。
  it("codex attach error は ./scripts/actradeck codex を案内する (TDA-1)", () => {
    expect(() => parseDaemonArgs(["attach", "codex"], cwd)).toThrow(/\.\/scripts\/actradeck codex/);
    expect(() => parseDaemonArgs(["attach", "codex"], cwd)).toThrow(/agentmon codex/);
  });

  it("rejects invalid scope / token-mode / subcommand", () => {
    expect(() => parseDaemonArgs(["daemon", "start", "--scope", "global"], cwd)).toThrow();
    expect(() => parseDaemonArgs(["daemon", "start", "--token-mode", "jwt"], cwd)).toThrow();
    expect(() => parseDaemonArgs(["daemon", "restart"], cwd)).toThrow();
  });
});

describe("resolveSettingsPath", () => {
  it("maps scopes to settings files", () => {
    expect(resolveSettingsPath("project-local", cwd, home)).toBe(
      join(cwd, ".claude", "settings.local.json"),
    );
    expect(resolveSettingsPath("project", cwd, home)).toBe(join(cwd, ".claude", "settings.json"));
    expect(resolveSettingsPath("user", cwd, home)).toBe(join(home, ".claude", "settings.json"));
  });
});

/** 実 AttachDaemon を起動する runtime (到達不能 ws)。 */
function makeRuntime(logs: string[]): { rt: DaemonRuntime; daemons: AttachDaemon[] } {
  const daemons: AttachDaemon[] = [];
  const rt: DaemonRuntime = {
    home,
    log: (m) => logs.push(m),
    startDaemon: async (opts) => {
      const daemon = new AttachDaemon({
        wsUrl: opts.wsUrl,
        dbPath: opts.dbPath,
        ...(opts.hookToken !== undefined ? { hookToken: opts.hookToken } : {}),
        host: "127.0.0.1",
      });
      const { hookEndpoint } = await daemon.start();
      daemons.push(daemon);
      return { daemon, hookEndpoint, hookToken: daemon.hookAuthToken };
    },
  };
  return { rt, daemons };
}

describe("runStart / runStop / runStatus", () => {
  it("dry-run previews without writing settings or starting a daemon", async () => {
    const logs: string[] = [];
    const { rt, daemons } = makeRuntime(logs);
    const args = parseDaemonArgs(["attach", "--dry-run"], cwd);
    const out = await runStart(
      args,
      { wsUrl: "ws://127.0.0.1:1/ingest/ws", dbPath: join(cwd, "x.db") },
      rt,
    );
    expect(out.status).toBe("dry-run");
    expect(daemons.length).toBe(0); // daemon 起動なし
    expect(existsSync(resolveSettingsPath("project-local", cwd, home))).toBe(false); // 書き込みなし
  });

  it("start wires settings (marker entry) + writes state file (0600, no token value), stop reverses it", async () => {
    const logs: string[] = [];
    const { rt, daemons } = makeRuntime(logs);
    const args = parseDaemonArgs(["attach"], cwd);
    const dbPath = join(cwd, "side.db");
    const out = await runStart(args, { wsUrl: "ws://127.0.0.1:1/ingest/ws", dbPath }, rt);
    expect(out.status).toBe("started");
    expect(out.hookEndpoint).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/hook$/);

    const settingsPath = resolveSettingsPath("project-local", cwd, home);
    expect(existsSync(settingsPath)).toBe(true);
    // settings に ActraDeck マーカー entry が配線され、literal nonce が daemon の実トークンと一致。
    const settings = JSON.parse(readFileSync(settingsPath, "utf8")) as {
      hooks: Record<string, Array<{ hooks: unknown[] }>>;
    };
    const entries = Object.values(settings.hooks)
      .flatMap((g) => g)
      .flatMap((x) => x.hooks)
      .filter(isActradeckEntry) as Array<{ headers?: Record<string, string> }>;
    expect(entries.length).toBeGreaterThan(0);
    const tok = daemons[0]?.hookAuthToken as string;
    expect(entries[0]?.headers?.["X-ActraDeck-Hook-Token"]).toBe(tok);

    // state file: 0600 + token 値を含まない。
    const statePath = out.statePath;
    expect(existsSync(statePath)).toBe(true);
    const mode = statSync(statePath).mode & 0o777;
    expect(mode).toBe(0o600);
    const stateRaw = readFileSync(statePath, "utf8");
    expect(stateRaw).not.toContain(tok); // token 値は state に書かない

    // stop: detach + state 削除。自プロセス pid なので kill しない。
    await daemons[0]?.shutdown();
    const stopOut = runStop(args, rt);
    expect(stopOut.status).toBe("stopped");
    expect(stopOut.detached).toBe(true);
    expect(existsSync(statePath)).toBe(false);
    // detach 後の settings に ActraDeck entry が残らない。
    const after = JSON.parse(readFileSync(settingsPath, "utf8")) as Record<string, unknown>;
    expect(JSON.stringify(after)).not.toContain("__actradeck");
  });

  it("double start is prevented (already-running) when pid is alive", async () => {
    const logs: string[] = [];
    const { rt, daemons } = makeRuntime(logs);
    const args = parseDaemonArgs(["attach"], cwd);
    const dbPath = join(cwd, "side.db");
    await runStart(args, { wsUrl: "ws://127.0.0.1:1/ingest/ws", dbPath }, rt);
    // 同 scope で再 start → 既存 (自 pid 生存) を検出し no-op。
    const out2 = await runStart(
      args,
      { wsUrl: "ws://127.0.0.1:1/ingest/ws", dbPath: join(cwd, "side2.db") },
      rt,
    );
    expect(out2.status).toBe("already-running");
    expect(daemons.length).toBe(1); // 2 個目の daemon は起動しない
    await daemons[0]?.shutdown();
    runStop(args, rt);
  });

  it("status reports running then not-running after stop", async () => {
    const logs: string[] = [];
    const { rt, daemons } = makeRuntime(logs);
    const args = parseDaemonArgs(["attach"], cwd);
    await runStart(args, { wsUrl: "ws://127.0.0.1:1/ingest/ws", dbPath: join(cwd, "side.db") }, rt);
    expect(runStatus(args, rt).running).toBe(true);
    await daemons[0]?.shutdown();
    runStop(args, rt);
    expect(runStatus(args, rt).running).toBe(false);
  });
});

describe("INV-ATTACH-CONFIRM-GATE (SEC-1): user/project scope は確認なしで設定 write しない", () => {
  it("scopeNeedsConfirm: user/project は確認必須、project-local は不要", () => {
    expect(scopeNeedsConfirm("user")).toBe(true);
    expect(scopeNeedsConfirm("project")).toBe(true);
    expect(scopeNeedsConfirm("project-local")).toBe(false);
  });

  it("user scope without --yes is DENIED (no daemon start, no settings write) — safe-side deny", async () => {
    const logs: string[] = [];
    const { rt, daemons } = makeRuntime(logs);
    const args = parseDaemonArgs(["attach", "--scope", "user"], cwd);
    const out = await runStart(
      args,
      { wsUrl: "ws://127.0.0.1:1/ingest/ws", dbPath: join(cwd, "u.db") },
      rt,
    );
    // mutation (ゲート除去) でここが「started + 無確認 write」になり赤化する。
    expect(out.status).toBe("denied-needs-confirm");
    expect(daemons.length).toBe(0); // daemon 未起動
    expect(existsSync(resolveSettingsPath("user", cwd, home))).toBe(false); // 設定未 write
  });

  it("project scope (env mode) without --yes is also DENIED for confirmation", async () => {
    const logs: string[] = [];
    const { rt, daemons } = makeRuntime(logs);
    // project + env token-mode は token-leak ゲートを通過するが、confirm ゲートで止まる。
    // env mode の token 必須ゲート (SEC-FC-2) を先に満たし、confirm ゲートだけを単独で検証する。
    const args = parseDaemonArgs(["attach", "--scope", "project", "--token-mode", "env"], cwd);
    const out = await runStart(
      args,
      {
        wsUrl: "ws://127.0.0.1:1/ingest/ws",
        dbPath: join(cwd, "p.db"),
        hookToken: "tok-confirm-gate-0123456789abcdef",
      },
      rt,
    );
    expect(out.status).toBe("denied-needs-confirm");
    expect(daemons.length).toBe(0);
    expect(existsSync(resolveSettingsPath("project", cwd, home))).toBe(false);
  });

  it("user scope WITH --yes proceeds (confirmed) and writes settings", async () => {
    const logs: string[] = [];
    const { rt, daemons } = makeRuntime(logs);
    const args = parseDaemonArgs(["attach", "--scope", "user", "--yes"], cwd);
    const out = await runStart(
      args,
      { wsUrl: "ws://127.0.0.1:1/ingest/ws", dbPath: join(cwd, "u2.db") },
      rt,
    );
    expect(out.status).toBe("started");
    expect(existsSync(resolveSettingsPath("user", cwd, home))).toBe(true);
    await daemons[0]?.shutdown();
    runStop(args, rt);
  });

  it("confirm() callback approval lets user scope proceed without --yes", async () => {
    const logs: string[] = [];
    const { rt, daemons } = makeRuntime(logs);
    rt.confirm = () => true; // 対話承認を模す。
    const args = parseDaemonArgs(["attach", "--scope", "user"], cwd);
    const out = await runStart(
      args,
      { wsUrl: "ws://127.0.0.1:1/ingest/ws", dbPath: join(cwd, "u3.db") },
      rt,
    );
    expect(out.status).toBe("started");
    await daemons[0]?.shutdown();
    runStop(args, rt);
  });
});

describe("INV-ATTACH-TOKEN-LEAK (SEC-2): tracked file に nonce 平文を着地させない", () => {
  it("tokenModeLeaksToTrackedFile: project+literal のみ true", () => {
    expect(tokenModeLeaksToTrackedFile("project", "literal")).toBe(true);
    expect(tokenModeLeaksToTrackedFile("project", "env")).toBe(false);
    expect(tokenModeLeaksToTrackedFile("project-local", "literal")).toBe(false);
    expect(tokenModeLeaksToTrackedFile("user", "literal")).toBe(false);
  });

  it("project scope + literal token-mode is DENIED (no nonce ever written to tracked settings.json)", async () => {
    const logs: string[] = [];
    const { rt, daemons } = makeRuntime(logs);
    // project + literal (既定 token-mode) → tracked file に nonce 平文を書こうとする。
    const args = parseDaemonArgs(["attach", "--scope", "project"], cwd);
    expect(args.tokenMode).toBe("literal"); // 既定
    const out = await runStart(
      args,
      { wsUrl: "ws://127.0.0.1:1/ingest/ws", dbPath: join(cwd, "p2.db") },
      rt,
    );
    // mutation (token-leak ゲート除去) でここが started + nonce 平文 write になり赤化。
    expect(out.status).toBe("denied-token-leak");
    expect(daemons.length).toBe(0);
    const settingsPath = resolveSettingsPath("project", cwd, home);
    expect(existsSync(settingsPath)).toBe(false); // tracked file は未作成 = nonce 不在
  });

  it("project scope + env token-mode does NOT write any literal nonce into the tracked file", async () => {
    const logs: string[] = [];
    const { rt, daemons } = makeRuntime(logs);
    // env mode は confirm ゲートで止まるため --yes で通す。
    const args = parseDaemonArgs(
      ["attach", "--scope", "project", "--token-mode", "env", "--yes"],
      cwd,
    );
    const out = await runStart(
      args,
      {
        wsUrl: "ws://127.0.0.1:1/ingest/ws",
        dbPath: join(cwd, "p3.db"),
        // env mode は daemon 側の ACTRADECK_HOOK_TOKEN が必須 (SEC-FC-2)。
        hookToken: "tok-env-mode-project-scope-0123456789",
      },
      rt,
    );
    expect(out.status).toBe("started");
    const settingsPath = resolveSettingsPath("project", cwd, home);
    const raw = readFileSync(settingsPath, "utf8");
    const tok = daemons[0]?.hookAuthToken as string;
    expect(tok).toBe("tok-env-mode-project-scope-0123456789");
    // tracked settings.json に nonce 平文が無い ($VAR 参照 + allowedEnvVars のみ)。
    expect(raw).not.toContain(tok);
    expect(raw).toContain("$ACTRADECK_HOOK_TOKEN");
    expect(raw).toContain("allowedEnvVars");
    await daemons[0]?.shutdown();
    runStop(args, rt);
  });
});

/**
 * SEC-FC-2 (task 01a107b4-8e9b): env token-mode の**往復**。settings に書いた entry を、上流の HTTP hook と
 * 同じ規則で補間 (`$VAR` / `${VAR}` は allowedEnvVars に列挙された変数だけ CC プロセス env から解決・
 * それ以外は空文字 — code.claude.com/docs/en/hooks 2026-10-05 確認) してから、実 daemon の受信口へ送る。
 *
 * 旧実装は env mode で `Authorization: Bearer $ACTRADECK_HOOK_TOKEN` を書き、受信側は
 * `X-ActraDeck-Hook-Token` しか照合しないため全 hook が 403 = 上流では non-blocking で承認ゲートが
 * 働かなかった。書く側と照合する側を**同じテストで突き合わせる**ことで、片側だけの変更を落とす。
 */
function interpolateHookHeaders(
  entry: { headers?: Record<string, string>; allowedEnvVars?: string[] },
  ccEnv: Record<string, string>,
): Record<string, string> {
  const allowed = new Set(entry.allowedEnvVars ?? []);
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(entry.headers ?? {})) {
    out[name] = value.replace(
      /\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g,
      (_m, a, b) => {
        const key = (a ?? b) as string;
        return allowed.has(key) ? (ccEnv[key] ?? "") : "";
      },
    );
  }
  return out;
}

async function postHookWith(
  endpoint: string,
  headers: Record<string, string>,
  body: unknown,
): Promise<{ status: number; body: unknown }> {
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text.length > 0 ? JSON.parse(text) : {} };
}

describe("INV-ATTACH-HOOK-AUTH-ENV: env token-mode の書込と受信側の照合が往復で一致する (SEC-FC-2)", () => {
  const TOKEN = "tok-env-roundtrip-abcdef0123456789";
  const LOW_RISK_PRE_TOOL_USE = {
    session_id: "s-env-roundtrip",
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command: "ls -la" },
  };

  it("CC と daemon が同じ ACTRADECK_HOOK_TOKEN を持てば、承認フックが 403 でなく認証を通る", async () => {
    const logs: string[] = [];
    const { rt, daemons } = makeRuntime(logs);
    const args = parseDaemonArgs(["attach", "--token-mode", "env"], cwd);
    const out = await runStart(
      args,
      { wsUrl: "ws://127.0.0.1:1/ingest/ws", dbPath: join(cwd, "env-rt.db"), hookToken: TOKEN },
      rt,
    );
    try {
      expect(out.status).toBe("started");
      const settings = JSON.parse(
        readFileSync(resolveSettingsPath("project-local", cwd, home), "utf8"),
      ) as { hooks: Record<string, Array<{ hooks: unknown[] }>> };
      const entries = Object.values(settings.hooks)
        .flatMap((g) => g)
        .flatMap((x) => x.hooks)
        .filter(isActradeckEntry) as Array<{
        url: string;
        headers?: Record<string, string>;
        allowedEnvVars?: string[];
      }>;
      expect(entries.length).toBeGreaterThan(0);
      // 平文 token は settings に書かれない (env 参照のみ)。
      expect(JSON.stringify(settings)).not.toContain(TOKEN);

      for (const entry of entries) {
        const ccHeaders = interpolateHookHeaders(entry, { ACTRADECK_HOOK_TOKEN: TOKEN });
        // 補間後に token が実際に載っている (= allowedEnvVars と参照名が一致している)。
        expect(Object.values(ccHeaders)).toContain(TOKEN);
        const ok = await postHookWith(entry.url, ccHeaders, LOW_RISK_PRE_TOOL_USE);
        expect(ok.status, "env-mode hook was rejected by the receiver").toBe(200);
        expect(ok.body).toEqual({}); // 認証を通った (200)。承認経路への到達はここでは判別しない (hook-approval-gate 側の INV が担う)
      }

      // 対照: CC 側の値が違えば同じ entry でも 403 (照合が実際に効いている)。
      const first = entries[0];
      if (first === undefined) throw new Error("no ActraDeck entry");
      const wrong = interpolateHookHeaders(first, { ACTRADECK_HOOK_TOKEN: "tok-wrong" });
      expect((await postHookWith(first.url, wrong, LOW_RISK_PRE_TOOL_USE)).status).toBe(403);
      // 対照: CC 側で未 export (空文字に補間) でも 403。
      const unset = interpolateHookHeaders(first, {});
      expect((await postHookWith(first.url, unset, LOW_RISK_PRE_TOOL_USE)).status).toBe(403);
    } finally {
      await daemons[0]?.shutdown();
      runStop(args, rt);
    }
  });
});

/**
 * INV-ATTACH-HOOK-AUTH-ENV の起動前ゲート (裁定 01a10814)。どれも daemon を起動せず settings も書かない
 * 値ベースの拒否で、拒否は CLI の終了コード 1 になる。
 */
describe("INV-ATTACH-HOOK-AUTH-ENV: 使えないトークンでは起動しない", () => {
  const WS = "ws://127.0.0.1:1/ingest/ws";
  const SCOPES = [
    { scope: "project-local", flags: [] as string[] },
    { scope: "project", flags: ["--yes"] },
    { scope: "user", flags: ["--yes"] },
  ] as const;
  const MISSING: readonly (string | undefined)[] = [undefined, ""];
  let missingCasesExecuted = 0;
  afterAll(() => {
    expect(missingCasesExecuted).toBe(SCOPES.length * MISSING.length);
  });

  // QA-ENV-2: docs が env mode へ誘導する project scope を含む 3 scope すべてで固定する。
  for (const { scope, flags } of SCOPES) {
    for (const value of MISSING) {
      it(`env mode × ${scope} × ${value === undefined ? "未設定" : "空文字"} は denied-env-token-missing`, async () => {
        const logs: string[] = [];
        const { rt, daemons } = makeRuntime(logs);
        const args = parseDaemonArgs(
          ["attach", "--scope", scope, "--token-mode", "env", ...flags],
          cwd,
        );
        const out = await runStart(
          args,
          {
            wsUrl: WS,
            dbPath: join(cwd, `missing-${scope}.db`),
            ...(value !== undefined ? { hookToken: value } : {}),
          },
          rt,
        );
        expect(out.status).toBe("denied-env-token-missing");
        expect(daemons.length).toBe(0);
        expect(existsSync(resolveSettingsPath(scope, cwd, home))).toBe(false);
        expect(logs.join("\n")).toContain("ACTRADECK_HOOK_TOKEN");
        missingCasesExecuted += 1;
      });
    }
  }

  // SEC-ENV-1 ≡ TDA-ENV-4 / SEC-ENV-3: 監査 R1 が実測した「起動はするが全 hook が 403 になる / 推測で
  // 破れる」値を逐語で持つ。env mode と literal mode の上書きの両方で拒否する。
  const INVALID: readonly [string, string][] = [
    ["空白 1 字", " "],
    ["TAB", "\t"],
    ["前後空白", " tok-surrounded-by-spaces-0123456789abcdef "],
    // 先頭側と末尾側は対称に置く (片側だけだとアンカーの片方を外す変異が素通りする)。
    ["先頭空白", " tok-leading-space-0123456789abcdefghij"],
    ["末尾空白", "tok-trailing-space-0123456789abcdefghij "],
    ["先頭 CR", "\rtok-leading-carriage-return-0123456789"],
    ["末尾 CR", "tok-trailing-carriage-return-0123456789\r"],
    ["先頭 LF", "\ntok-leading-line-feed-0123456789abcdef"],
    ["末尾 LF", "tok-trailing-line-feed-0123456789abcdef\n"],
    ["非 ASCII (U+20AC)", "tok-euro-sign-\u20ac-0123456789abcdef"],
    ["1 文字", "a"],
    ["31 文字", "a".repeat(31)],
    // 上流は header 値の $VAR / ${VAR} を補間するので、literal で書いた値が送信時に変わる。
    ["$VAR 綴り", "tok$HOME-0123456789abcdefghijklmnopq"],
    ["${VAR} 綴り", "tok${HOME}-0123456789abcdefghijklmnop"],
    ["1025 文字", "a".repeat(1025)],
    // 許容集合 (docs に逐語で書いた ASCII 英数字と . _ ~ + / = -) の外側の記号。
    ["波括弧", "tok{brace}-0123456789abcdefghijklmnopq"],
    ["感嘆符", "tok!bang-0123456789abcdefghijklmnopqr"],
  ];
  for (const mode of ["env", "literal"] as const) {
    for (const [label, value] of INVALID) {
      it(`${mode} mode × ${label} は denied-hook-token-invalid (値はログに出さない)`, async () => {
        const logs: string[] = [];
        const { rt, daemons } = makeRuntime(logs);
        const args = parseDaemonArgs(["attach", "--token-mode", mode], cwd);
        const out = await runStart(
          args,
          { wsUrl: WS, dbPath: join(cwd, "invalid.db"), hookToken: value },
          rt,
        );
        expect(out.status).toBe("denied-hook-token-invalid");
        expect(daemons.length).toBe(0);
        expect(existsSync(resolveSettingsPath("project-local", cwd, home))).toBe(false);
        // POSITIVE 対: 拒否文言はログに出ている (ログが空で negative が恒真になるのを防ぐ)。
        expect(logs.join("\n")).toContain("ACTRADECK_HOOK_TOKEN");
        if (value.trim().length > 1) expect(logs.join("\n")).not.toContain(value.trim());
      });
    }
  }

  it("述語: ヘッダで往復できる 32 文字以上だけを受理する (合格の対照つき)", () => {
    for (const [, value] of INVALID)
      expect(isUsableHookToken(value), JSON.stringify(value)).toBe(false);
    // 合格: 32 文字ちょうど / openssl rand -hex 32 形 / daemon 自前の base64url nonce 形。
    expect(isUsableHookToken("a".repeat(32))).toBe(true);
    expect(isUsableHookToken("a".repeat(1024))).toBe(true);
    expect(isUsableHookToken("0123456789abcdef".repeat(4))).toBe(true);
    expect(isUsableHookToken(generateHookToken())).toBe(true);
    expect(isUsableHookToken("Abc-def_ghi.jkl~mno+pqr/stu=vwxyz0")).toBe(true);
  });

  it("daemon が渡した値と違うトークンで起動したら止めて denied-env-token-mismatch (QA-ENV-1 ≡ TDA-ENV-1)", async () => {
    const logs: string[] = [];
    const started: AttachDaemon[] = [];
    // 本番 runtime の受け渡しが壊れた形: hookToken を無視し daemon 自前の nonce で起動する。
    const rt: DaemonRuntime = {
      home,
      log: (m) => logs.push(m),
      startDaemon: async (opts) => {
        const daemon = new AttachDaemon({
          wsUrl: opts.wsUrl,
          dbPath: opts.dbPath,
          host: "127.0.0.1",
        });
        const { hookEndpoint } = await daemon.start();
        started.push(daemon);
        return { daemon, hookEndpoint, hookToken: daemon.hookAuthToken };
      },
    };
    const args = parseDaemonArgs(["attach", "--token-mode", "env"], cwd);
    const out = await runStart(
      args,
      {
        wsUrl: WS,
        dbPath: join(cwd, "mismatch.db"),
        hookToken: "tok-mismatch-0123456789abcdef0123",
      },
      rt,
    );
    expect(out.status).toBe("denied-env-token-mismatch");
    expect(started.length).toBe(1);
    // 拒否文言は出す (POSITIVE 対)・渡した値と daemon 側の値はどちらもログに出さない。
    expect(logs.join("\n")).toContain("ACTRADECK_HOOK_TOKEN");
    expect(logs.join("\n")).not.toContain("tok-mismatch-0123456789abcdef0123");
    expect(logs.join("\n")).not.toContain(started[0]?.hookAuthToken ?? "<no-daemon>");
    // settings は書かない・daemon は止めた (受信口がもう応答しない)。
    expect(existsSync(resolveSettingsPath("project-local", cwd, home))).toBe(false);
    const endpoint = started[0]?.hookEndpoint ?? "http://127.0.0.1:1/hook";
    await expect(
      fetch(endpoint, {
        method: "POST",
        body: "{}",
        headers: { "content-type": "application/json" },
      }),
    ).rejects.toThrow();
    // 対照: 受け渡しが正しい runtime なら同じ値で started。
    const ok = makeRuntime([]);
    const out2 = await runStart(
      args,
      { wsUrl: WS, dbPath: join(cwd, "match.db"), hookToken: "tok-mismatch-0123456789abcdef0123" },
      ok.rt,
    );
    expect(out2.status).toBe("started");
    await ok.daemons[0]?.shutdown();
    runStop(args, ok.rt);
  });

  it("終了コード: 拒否はすべて 1・それ以外は 0 (TDA-ENV-3 ≡ QA-ENV-4)・status の綴りでなく union の所属で決まる (TDA-TD-6 ≡ QA-TD-4)", () => {
    // 拒否の結果は cleanupStaleWiring が返した後始末の結果を持つ (DeniedOutcome)。
    const target = scopeTarget("project-local", cwd, home);
    const cleanup = cleanupStaleWiring({ target, writeApproved: true, log: () => undefined });
    const base = { settingsPath: target.settingsPath, statePath: target.artifacts.statePath };
    const table: readonly [StartOutcome, 0 | 1][] = [
      [{ ...base, status: "started" }, 0],
      [{ ...base, status: "already-running" }, 0],
      [{ ...base, status: "dry-run" }, 0],
      [{ ...base, status: "denied-needs-confirm", cleanup }, 1],
      [{ ...base, status: "denied-token-leak", cleanup }, 1],
      [{ ...base, status: "denied-env-token-missing", cleanup }, 1],
      [{ ...base, status: "denied-hook-token-invalid", cleanup }, 1],
      [{ ...base, status: "denied-env-token-mismatch", cleanup }, 1],
    ];
    for (const [outcome, code] of table) {
      expect(startOutcomeExitCode(outcome), outcome.status).toBe(code);
      expect(isDeniedOutcome(outcome), outcome.status).toBe(code === 1);
    }
    expect(new Set(table.map(([o]) => o.status)).size).toBe(table.length);
    // 綴りに依存しない: 拒否の status を持たない形でも cleanup を持てば 1 (型の外から作った値で挙動を確かめる)。
    const unnamedDenial = { ...base, status: "started", cleanup } as unknown as StartOutcome;
    expect(startOutcomeExitCode(unnamedDenial)).toBe(1);
    // DeniedStatusFloor は型として残す (この参照を消すと型検査で落ちる・floor の削除は無音にならない)。
    const floor: DeniedStatusFloor = true;
    expect(floor).toBe(true);
  });
});
