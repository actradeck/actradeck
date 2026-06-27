/**
 * daemon-cli / daemon-state の制御ロジック (ADR 019ea476 D1/D5)。
 *
 * - parseDaemonArgs: attach=start 別名 / scope/token-mode/dry-run/yes / codex 明示エラー。
 * - resolveSettingsPath: scope → settings file。
 * - runStart/runStop/runStatus: 二重起動防止・stale 掃除・settings 配線/detach・state file 0600・
 *   token 値を state に書かない。すべて temp HOME / temp cwd (実設定不可侵)。
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AttachDaemon } from "../src/attach-daemon.js";
import {
  CodexAttachUnsupportedError,
  type DaemonRuntime,
  parseDaemonArgs,
  resolveSettingsPath,
  runStart,
  runStatus,
  runStop,
  scopeNeedsConfirm,
  tokenModeLeaksToTrackedFile,
} from "../src/daemon-cli.js";
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
    const args = parseDaemonArgs(["attach", "--scope", "project", "--token-mode", "env"], cwd);
    const out = await runStart(
      args,
      { wsUrl: "ws://127.0.0.1:1/ingest/ws", dbPath: join(cwd, "p.db") },
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
      { wsUrl: "ws://127.0.0.1:1/ingest/ws", dbPath: join(cwd, "p3.db") },
      rt,
    );
    expect(out.status).toBe("started");
    const settingsPath = resolveSettingsPath("project", cwd, home);
    const raw = readFileSync(settingsPath, "utf8");
    const tok = daemons[0]?.hookAuthToken as string;
    // tracked settings.json に nonce 平文が無い ($VAR 参照 + allowedEnvVars のみ)。
    expect(raw).not.toContain(tok);
    expect(raw).toContain("$ACTRADECK_HOOK_TOKEN");
    expect(raw).toContain("allowedEnvVars");
    await daemons[0]?.shutdown();
    runStop(args, rt);
  });
});
