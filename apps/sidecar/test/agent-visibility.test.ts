import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  computeAgentVisibility,
  computeAgentVisibilityWire,
  firstInstalledScope,
  renderAgentVisibilityHuman,
  runAgentDoctorCli,
  toAgentVisibilityWire,
  type AgentVisibility,
  type HookScope,
} from "../src/agent-visibility.js";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "agent-vis-"));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

/** ActraDeck マーカー付き hook entry を持つ settings.json を書く。 */
function writeActradeckSettings(path: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(
    path,
    JSON.stringify({
      hooks: {
        PreToolUse: [
          { hooks: [{ type: "http", url: "http://127.0.0.1:1/hook", __actradeck: true }] },
        ],
      },
    }),
  );
}

/** ActraDeck でない (ユーザー独自) hook を持つ settings.json を書く。 */
function writeNonActradeckSettings(path: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(
    path,
    JSON.stringify({
      hooks: { PreToolUse: [{ hooks: [{ type: "command", command: "echo hi" }] }] },
    }),
  );
}

/** PATH に載せる実行可能ファイルを持つ bin dir を作り、その dir を返す。 */
function makeBinDir(names: readonly string[]): string {
  const bin = join(tmp, "bin");
  mkdirSync(bin, { recursive: true });
  for (const n of names) writeFileSync(join(bin, n), "#!/bin/sh\n", { mode: 0o755 });
  return bin;
}

describe("computeAgentVisibility — claude hook detection per scope", () => {
  it("detects ActraDeck hook in user scope only", () => {
    const home = join(tmp, "home");
    const cwd = join(tmp, "proj");
    writeActradeckSettings(join(home, ".claude", "settings.json"));
    const v = computeAgentVisibility({ home, cwd, env: { PATH: "" } });
    expect(v.claude.hookInstalled.user).toBe(true);
    expect(v.claude.hookInstalled.project).toBe(false);
    expect(v.claude.hookInstalled.projectLocal).toBe(false);
    expect(v.claude.anyHook).toBe(true);
    expect(firstInstalledScope(v.claude)).toBe<HookScope>("user");
  });

  it("detects ActraDeck hook in project scope only", () => {
    const home = join(tmp, "home");
    const cwd = join(tmp, "proj");
    writeActradeckSettings(join(cwd, ".claude", "settings.json"));
    const v = computeAgentVisibility({ home, cwd, env: { PATH: "" } });
    expect(v.claude.hookInstalled.project).toBe(true);
    expect(v.claude.hookInstalled.user).toBe(false);
    expect(v.claude.hookInstalled.projectLocal).toBe(false);
    expect(firstInstalledScope(v.claude)).toBe<HookScope>("project");
  });

  it("detects ActraDeck hook in projectLocal scope only", () => {
    const home = join(tmp, "home");
    const cwd = join(tmp, "proj");
    writeActradeckSettings(join(cwd, ".claude", "settings.local.json"));
    const v = computeAgentVisibility({ home, cwd, env: { PATH: "" } });
    expect(v.claude.hookInstalled.projectLocal).toBe(true);
    expect(v.claude.hookInstalled.user).toBe(false);
    expect(v.claude.hookInstalled.project).toBe(false);
    expect(firstInstalledScope(v.claude)).toBe<HookScope>("projectLocal");
  });

  it("missing settings.json → all scopes false (no throw)", () => {
    const v = computeAgentVisibility({
      home: join(tmp, "nohome"),
      cwd: join(tmp, "noproj"),
      env: { PATH: "" },
    });
    expect(v.claude.anyHook).toBe(false);
    expect(v.claude.hookInstalled.user).toBe(false);
    expect(firstInstalledScope(v.claude)).toBeUndefined();
  });

  it("a non-ActraDeck user hook is NOT counted as installed (strict distinction)", () => {
    const home = join(tmp, "home");
    writeNonActradeckSettings(join(home, ".claude", "settings.json"));
    const v = computeAgentVisibility({ home, cwd: join(tmp, "p"), env: { PATH: "" } });
    // Falsifiability: if detection ignored the marker and matched any hook group, this flips to true.
    expect(v.claude.hookInstalled.user).toBe(false);
    expect(v.claude.anyHook).toBe(false);
  });

  it("JSON-invalid settings.json → treated as not-installed (does not throw)", () => {
    const home = join(tmp, "home");
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(join(home, ".claude", "settings.json"), "{ this is : not json ");
    expect(() =>
      computeAgentVisibility({ home, cwd: join(tmp, "p"), env: { PATH: "" } }),
    ).not.toThrow();
    const v = computeAgentVisibility({ home, cwd: join(tmp, "p"), env: { PATH: "" } });
    expect(v.claude.hookInstalled.user).toBe(false);
  });
});

describe("computeAgentVisibility — malformed hooks shape (SEC-1≡QA-1: must not throw)", () => {
  // valid JSON だが hooks の構造が想定外のケース。doctor は完走必須ゆえ throw せず not-installed に
  // 縮退する契約 (settings-merge.ts docstring)。修正前コードは groups.some / group.hooks で TypeError を
  // uncaught throw する → 本 describe は修正前に RED (falsifiability)。
  const MALFORMED: ReadonlyArray<readonly [string, string]> = [
    // SEC-R1: null は修正前 `Object.keys(null)` で throw する → `hooks === null` ガードを回帰固定。
    ["hooks is null", '{"hooks":null}'],
    ["hooks is an array", '{"hooks":[1,2,3]}'],
    ["hooks is a string", '{"hooks":"nope"}'],
    // 境界 (no-throw): Object.keys(primitive) === [] ゆえ修正前でも throw しない無害ケース
    // (この bug に対し非 falsifying・QA-RA-2/SEC-R1。number/boolean を明示し意図を docs 化)。
    ["hooks is a number", '{"hooks":123}'],
    ["hooks is a boolean", '{"hooks":true}'],
    ["event value is a string", '{"hooks":{"PreToolUse":"x"}}'],
    ["event value is a number", '{"hooks":{"PreToolUse":5}}'],
    ["event value is a non-array object", '{"hooks":{"PreToolUse":{}}}'],
    ["group member is null", '{"hooks":{"PreToolUse":[null]}}'],
  ];
  for (const [label, raw] of MALFORMED) {
    it(`${label} → not-installed, no throw`, () => {
      const home = join(tmp, "home");
      mkdirSync(join(home, ".claude"), { recursive: true });
      writeFileSync(join(home, ".claude", "settings.json"), raw);
      const opts = { home, cwd: join(tmp, "p"), env: { PATH: "" } };
      expect(() => computeAgentVisibility(opts)).not.toThrow();
      const v = computeAgentVisibility(opts);
      expect(v.claude.hookInstalled.user).toBe(false);
      expect(v.claude.anyHook).toBe(false);
    });
  }

  it("empty settings.json file → not-installed, no throw (QA-4 boundary)", () => {
    const home = join(tmp, "home");
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(join(home, ".claude", "settings.json"), "");
    const opts = { home, cwd: join(tmp, "p"), env: { PATH: "" } };
    expect(() => computeAgentVisibility(opts)).not.toThrow();
    expect(computeAgentVisibility(opts).claude.anyHook).toBe(false);
  });

  it('CODEX_HOME="" falls back to <home>/.codex/sessions (QA-4 boundary)', () => {
    const home = join(tmp, "h3");
    mkdirSync(join(home, ".codex", "sessions"), { recursive: true });
    const v = computeAgentVisibility({ home, cwd: tmp, env: { PATH: "", CODEX_HOME: "" } });
    expect(v.codex.rolloutDirResolved).toBe(true);
  });
});

describe("computeAgentVisibility — binary on PATH", () => {
  it("binaryOnPath true when executable present on PATH, false otherwise", () => {
    const bin = makeBinDir(["claude"]);
    const v = computeAgentVisibility({ home: tmp, cwd: tmp, env: { PATH: bin } });
    expect(v.claude.binaryOnPath).toBe(true);
    // codex not in bin dir → false (strict distinction = falsifiable).
    expect(v.codex.binaryOnPath).toBe(false);
  });

  it("empty PATH → both binaries false", () => {
    const v = computeAgentVisibility({ home: tmp, cwd: tmp, env: { PATH: "" } });
    expect(v.claude.binaryOnPath).toBe(false);
    expect(v.codex.binaryOnPath).toBe(false);
  });
});

describe("computeAgentVisibility — codex rollout dir", () => {
  it("rolloutDirResolved true when <CODEX_HOME>/sessions exists", () => {
    const codexHome = join(tmp, "codex");
    mkdirSync(join(codexHome, "sessions"), { recursive: true });
    const v = computeAgentVisibility({ home: tmp, cwd: tmp, env: { CODEX_HOME: codexHome } });
    expect(v.codex.rolloutDirResolved).toBe(true);
  });

  it("rolloutDirResolved false when sessions dir absent", () => {
    const codexHome = join(tmp, "codex-empty");
    mkdirSync(codexHome, { recursive: true }); // home exists but no sessions/
    const v = computeAgentVisibility({ home: tmp, cwd: tmp, env: { CODEX_HOME: codexHome } });
    expect(v.codex.rolloutDirResolved).toBe(false);
  });

  it("falls back to <home>/.codex/sessions when CODEX_HOME unset", () => {
    const home = join(tmp, "h2");
    mkdirSync(join(home, ".codex", "sessions"), { recursive: true });
    const v = computeAgentVisibility({ home, cwd: tmp, env: { PATH: "" } });
    expect(v.codex.rolloutDirResolved).toBe(true);
  });
});

describe("NO-RAW output contract", () => {
  it("JSON output contains no absolute path / settings content / token / home", () => {
    const home = join(tmp, "secret-home");
    const cwd = join(tmp, "secret-proj");
    const codexHome = join(tmp, "secret-codex");
    mkdirSync(join(codexHome, "sessions"), { recursive: true });
    // settings.json carrying a token-like secret value (must NOT surface in output).
    mkdirSync(join(home, ".claude"), { recursive: true });
    const SECRET = "glpat-SUPERSECRETTOKEN1234567890";
    writeFileSync(
      join(home, ".claude", "settings.json"),
      JSON.stringify({
        hooks: {
          PreToolUse: [
            {
              hooks: [
                {
                  type: "http",
                  url: "http://127.0.0.1:1/hook",
                  headers: { "X-Secret": SECRET },
                  __actradeck: true,
                },
              ],
            },
          ],
        },
      }),
    );
    const bin = makeBinDir(["claude", "codex"]);
    const v = computeAgentVisibility({
      home,
      cwd,
      env: { PATH: bin, CODEX_HOME: codexHome },
    });
    const json = JSON.stringify(v);

    // Sanity: this is the populated/positive case.
    expect(v.claude.anyHook).toBe(true);
    expect(v.codex.rolloutDirResolved).toBe(true);
    expect(v.claude.binaryOnPath).toBe(true);

    // NO-RAW: no secret, no absolute paths, no home/cwd/codexHome leakage.
    expect(json).not.toContain(SECRET);
    expect(json).not.toContain(home);
    expect(json).not.toContain(cwd);
    expect(json).not.toContain(codexHome);
    expect(json).not.toContain(bin);
    expect(json).not.toContain(tmp);
    // No path separators implying a leaked absolute path (tmp dirs always under an absolute root).
    expect(json).not.toMatch(/\/[^"]*\/(?:\.claude|sessions|home)/);
    // Only the expected closed-enum keys appear.
    const parsed = JSON.parse(json) as unknown;
    expect(parsed).toEqual({
      claude: {
        binaryOnPath: true,
        hookInstalled: { user: true, project: false, projectLocal: false },
        anyHook: true,
      },
      codex: { binaryOnPath: true, rolloutDirResolved: true },
    });
  });
});

describe("runAgentDoctorCli", () => {
  it("--json emits a single parseable JSON line and returns 0", () => {
    let out = "";
    let err = "";
    const code = runAgentDoctorCli(["--json"], {
      out: (s) => (out += s),
      err: (s) => (err += s),
    });
    expect(code).toBe(0);
    expect(err).toBe("");
    const parsed = JSON.parse(out.trim()) as { claude: unknown; codex: unknown };
    expect(parsed).toHaveProperty("claude");
    expect(parsed).toHaveProperty("codex");
  });

  it("human mode writes Japanese verdict to err (no JSON to stdout)", () => {
    let out = "";
    let err = "";
    const code = runAgentDoctorCli([], { out: (s) => (out += s), err: (s) => (err += s) });
    expect(code).toBe(0);
    expect(out).toBe("");
    expect(err).toContain("connectivity");
  });
});

describe("renderAgentVisibilityHuman", () => {
  it("hook installed → observable message names the scope", () => {
    const text = renderAgentVisibilityHuman({
      claude: {
        binaryOnPath: true,
        hookInstalled: { user: true, project: false, projectLocal: false },
        anyHook: true,
      },
      codex: { binaryOnPath: true, rolloutDirResolved: true },
    });
    expect(text).toContain("hook 注入済(user)");
    expect(text).toContain("観測できます");
  });

  it("binary present but hook absent → next-action wiring hint (strict, falsifiable)", () => {
    const text = renderAgentVisibilityHuman({
      claude: {
        binaryOnPath: true,
        hookInstalled: { user: false, project: false, projectLocal: false },
        anyHook: false,
      },
      codex: { binaryOnPath: false, rolloutDirResolved: false },
    });
    expect(text).toContain("hook 未注入");
    expect(text).toContain("actradeck up");
    expect(text).toContain("codex 未導入");
  });

  it("NO-RAW: 全状態の human 出力に絶対パス/home/secret 様文字列が出ない (belt-and-suspenders・SEC-2/QA-2)", () => {
    // 入力は boolean+enum ゆえ構造的に path/secret を持てないが、出力書式が将来それらを混ぜないことを固定する。
    // TDA-1 で bash doctor は本 renderer を単一出所として直呼びするため、bash 接続証明の NO-RAW もこれで担保。
    const states: AgentVisibility[] = [
      {
        claude: {
          binaryOnPath: true,
          hookInstalled: { user: true, project: false, projectLocal: false },
          anyHook: true,
        },
        codex: { binaryOnPath: true, rolloutDirResolved: true },
      },
      {
        claude: {
          binaryOnPath: true,
          hookInstalled: { user: false, project: false, projectLocal: false },
          anyHook: false,
        },
        codex: { binaryOnPath: true, rolloutDirResolved: false },
      },
      {
        claude: {
          binaryOnPath: false,
          hookInstalled: { user: false, project: false, projectLocal: false },
          anyHook: false,
        },
        codex: { binaryOnPath: false, rolloutDirResolved: false },
      },
    ];
    for (const v of states) {
      const text = renderAgentVisibilityHuman(v);
      expect(text).not.toContain("/home/");
      expect(text).not.toContain("settings.json");
      expect(text).not.toMatch(/glpat-|xoxb-|sk_live_|Bearer /);
      // 唯一許される '/' は相対コマンドヒント (./scripts/…) のみ。絶対 filesystem path 様は出ない。
      expect(text).not.toMatch(/(?:^|\s)\/(?:home|Users|root|tmp|var|etc)\b/);
    }
  });
});

describe("toAgentVisibilityWire — NO-RAW wire projection (ADR 019f1972 §2b)", () => {
  // per-scope hookInstalled に絶対パス様の値を仕込み、wire 射影がそれを **落とす** ことを確認する。
  const full: AgentVisibility = {
    claude: {
      binaryOnPath: true,
      hookInstalled: { user: true, project: true, projectLocal: false },
      anyHook: true,
    },
    codex: { binaryOnPath: true, rolloutDirResolved: true },
  };

  it("projects exactly the 4 booleans (drops per-scope hookInstalled detail)", () => {
    const wire = toAgentVisibilityWire(full);
    expect(wire).toEqual({
      claude: { binaryOnPath: true, anyHook: true },
      codex: { binaryOnPath: true, rolloutDirResolved: true },
    });
    // 表面最小化: per-scope 詳細キーは wire に存在しない。
    expect("hookInstalled" in wire.claude).toBe(false);
    expect(Object.keys(wire.claude).sort()).toEqual(["anyHook", "binaryOnPath"]);
    expect(Object.keys(wire.codex).sort()).toEqual(["binaryOnPath", "rolloutDirResolved"]);
  });

  it("carries each boolean faithfully (false stays false — no false-positive)", () => {
    const wire = toAgentVisibilityWire({
      claude: {
        binaryOnPath: false,
        hookInstalled: { user: false, project: false, projectLocal: false },
        anyHook: false,
      },
      codex: { binaryOnPath: true, rolloutDirResolved: false },
    });
    expect(wire).toEqual({
      claude: { binaryOnPath: false, anyHook: false },
      codex: { binaryOnPath: true, rolloutDirResolved: false },
    });
  });

  it("computeAgentVisibilityWire returns a parseable wire for the real machine (fail-safe)", () => {
    // 純ローカル検査 → throw せず undefined でない wire を返す (boolean 4 個)。
    const wire = computeAgentVisibilityWire();
    expect(wire).toBeDefined();
    expect(typeof wire?.claude.binaryOnPath).toBe("boolean");
    expect(typeof wire?.claude.anyHook).toBe("boolean");
    expect(typeof wire?.codex.binaryOnPath).toBe("boolean");
    expect(typeof wire?.codex.rolloutDirResolved).toBe("boolean");
  });

  it("computeAgentVisibilityWire honors injected opts (CODEX_HOME → rolloutDirResolved)", () => {
    const codexHome = join(tmp, "codex-here");
    mkdirSync(join(codexHome, "sessions"), { recursive: true });
    const wire = computeAgentVisibilityWire({
      home: tmp,
      cwd: tmp,
      env: { PATH: "", CODEX_HOME: codexHome },
    });
    expect(wire?.codex.rolloutDirResolved).toBe(true);
    expect(wire?.claude.binaryOnPath).toBe(false); // PATH 空。
  });
});
