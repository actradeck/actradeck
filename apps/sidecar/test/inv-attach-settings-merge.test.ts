/**
 * INV-ATTACH-SETTINGS-MERGE / INV-ATTACH-DETACH-REVERSIBLE (ADR 019ea476 D2)。
 *
 * - merge: 既存ユーザー hooks を保持しつつ ActraDeck マーカー entry を append (置換しない)。
 *   mutation (append→replace) で「ユーザー hooks 消失」を赤化する。
 * - 冪等: 2 回 merge で entry が重複しない。
 * - detach: マーカー entry **のみ** 除去しユーザー hooks を温存。detach 後に足したユーザー hooks も残す。
 *   mutation (全 hooks 削除) で赤化する。
 *
 * 🔴 安全制約: 実ユーザー settings / 本リポ .claude を絶対に触らない。すべて os.tmpdir() 配下。
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  ACTRADECK_MARKER,
  computeDetachedSettings,
  computeMergedSettings,
  detachAttachHooks,
  HOOK_TOKEN_ENV_VAR,
  isActradeckEntry,
  mergeAttachHooks,
  previewAttachHooks,
  type MergeOptions,
} from "../src/settings-merge.js";
import { HOOK_TOKEN_HEADER } from "../src/settings-injection.js";

let dir: string;
let settingsPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "actradeck-attach-merge-"));
  settingsPath = join(dir, "settings.local.json");
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const ENDPOINT = "http://127.0.0.1:54321/hook";
const opts = (over: Partial<MergeOptions> = {}): MergeOptions => ({
  settingsPath,
  endpoint: ENDPOINT,
  tokenMode: "literal",
  token: "nonce-abc",
  events: ["SessionStart", "PreToolUse"],
  ...over,
});

function readJson(p: string): Record<string, unknown> {
  return JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>;
}

describe("INV-ATTACH-SETTINGS-MERGE: 既存ユーザー hooks を保持して append する", () => {
  it("preserves existing user hooks when merging (append, not replace)", () => {
    // 既存ユーザー hooks (別 command hook) を仕込む。
    const userHook = { type: "command", command: "echo user-hook" };
    writeFileSync(
      settingsPath,
      JSON.stringify({
        hooks: { SessionStart: [{ hooks: [userHook] }] },
        permissions: { allow: ["Bash(ls:*)"] },
      }),
    );

    const res = mergeAttachHooks(opts());
    expect(res.wired).toBe(true);
    const after = readJson(settingsPath);
    const hooks = after.hooks as Record<string, Array<{ hooks: unknown[] }>>;

    // ユーザー hook が温存されている (INV: mutation append→replace でここが赤化)。
    const allSessionStartHooks = hooks.SessionStart.flatMap((g) => g.hooks);
    expect(allSessionStartHooks).toContainEqual(userHook);
    // ActraDeck マーカー entry が追加されている。
    expect(allSessionStartHooks.some(isActradeckEntry)).toBe(true);
    // hooks 以外のユーザー設定 (permissions) も温存。
    expect(after.permissions).toEqual({ allow: ["Bash(ls:*)"] });
  });

  it("computeMergedSettings keeps user hook AND adds marker entry (pure)", () => {
    const userHook = { type: "command", command: "x" };
    const current = { hooks: { PreToolUse: [{ matcher: "Bash", hooks: [userHook] }] } };
    const { settings } = computeMergedSettings(current, opts());
    const group = (settings.hooks as Record<string, Array<{ hooks: unknown[] }>>).PreToolUse;
    const flat = group.flatMap((g) => g.hooks);
    expect(flat).toContainEqual(userHook); // ユーザー hook 温存
    expect(flat.filter(isActradeckEntry)).toHaveLength(1); // ActraDeck entry 1 つ
  });

  it("is idempotent: merging twice does not duplicate the marker entry", () => {
    mergeAttachHooks(opts());
    const first = readJson(settingsPath);
    const res2 = mergeAttachHooks(opts());
    expect(res2.wired).toBe(false); // 変化なし
    const second = readJson(settingsPath);
    expect(second).toEqual(first);
    // 各 event に ActraDeck entry はちょうど 1 つ。
    const hooks = second.hooks as Record<string, Array<{ hooks: unknown[] }>>;
    for (const ev of ["SessionStart", "PreToolUse"]) {
      const count = hooks[ev].flatMap((g) => g.hooks).filter(isActradeckEntry).length;
      expect(count).toBe(1);
    }
  });

  it("creates a backup before modifying an existing settings file", () => {
    writeFileSync(settingsPath, JSON.stringify({ hooks: {} }));
    const res = mergeAttachHooks(opts());
    expect(res.backupPath).toBeDefined();
    expect(existsSync(res.backupPath as string)).toBe(true);
    // backup は改変前の原本。
    expect(readFileSync(res.backupPath as string, "utf8")).toContain('"hooks"');
  });

  it("literal token-mode writes the nonce header literally", () => {
    mergeAttachHooks(opts({ tokenMode: "literal", token: "nonce-xyz" }));
    const after = readJson(settingsPath);
    const entries = Object.values(after.hooks as Record<string, Array<{ hooks: unknown[] }>>)
      .flatMap((g) => g)
      .flatMap((x) => x.hooks)
      .filter(isActradeckEntry) as Array<{ headers?: Record<string, string> }>;
    expect(entries.length).toBeGreaterThan(0);
    for (const e of entries) {
      expect(e.headers?.[HOOK_TOKEN_HEADER]).toBe("nonce-xyz");
    }
  });

  it("env token-mode writes $VAR + allowedEnvVars (no literal token)", () => {
    mergeAttachHooks(opts({ tokenMode: "env", token: undefined }));
    const after = readJson(settingsPath);
    const raw = JSON.stringify(after);
    // 平文 nonce は書かれない。
    expect(raw).not.toContain("nonce-abc");
    const entries = Object.values(after.hooks as Record<string, Array<{ hooks: unknown[] }>>)
      .flatMap((g) => g)
      .flatMap((x) => x.hooks)
      .filter(isActradeckEntry) as Array<{
      headers?: Record<string, string>;
      allowedEnvVars?: string[];
    }>;
    for (const e of entries) {
      expect(e.headers?.Authorization).toBe(`Bearer $${HOOK_TOKEN_ENV_VAR}`);
      expect(e.allowedEnvVars).toEqual([HOOK_TOKEN_ENV_VAR]);
    }
  });

  it("previewAttachHooks (dry-run) does NOT write the file", () => {
    const res = previewAttachHooks(opts());
    expect(res.wired).toBe(false);
    expect(existsSync(settingsPath)).toBe(false); // 書き込まない
    expect(res.events).toEqual(["SessionStart", "PreToolUse"]);
  });
});

describe("INV-ATTACH-DETACH-REVERSIBLE: マーカー entry のみ除去しユーザー hooks 温存", () => {
  it("merge then detach restores settings to an equivalent of the original", () => {
    const original = {
      hooks: { SessionStart: [{ hooks: [{ type: "command", command: "echo u" }] }] },
      permissions: { allow: ["Bash(ls:*)"] },
    };
    writeFileSync(settingsPath, JSON.stringify(original));
    mergeAttachHooks(opts());
    const det = detachAttachHooks(settingsPath);
    expect(det.removed).toBe(true);
    const after = readJson(settingsPath);
    // ユーザー hook + permissions が原状どおり残る (ActraDeck entry は消える)。
    expect(after).toEqual(original);
  });

  it("detach removes ONLY the marker entry, keeping user hooks (mutation: delete-all would fail this)", () => {
    const userHook = { type: "command", command: "keep-me" };
    const merged = computeMergedSettings(
      { hooks: { PreToolUse: [{ hooks: [userHook] }] } },
      opts(),
    );
    const { settings, removed } = computeDetachedSettings(merged.settings);
    expect(removed).toBe(true);
    const flat = (settings.hooks as Record<string, Array<{ hooks: unknown[] }>>).PreToolUse.flatMap(
      (g) => g.hooks,
    );
    expect(flat).toContainEqual(userHook); // ユーザー hook 温存
    expect(flat.some(isActradeckEntry)).toBe(false); // ActraDeck entry 除去
  });

  it("detach keeps user hooks the user added into the SAME actradeck group", () => {
    // merge 後、ユーザーが ActraDeck group に自分の hook を足したケース。
    writeFileSync(settingsPath, "{}");
    mergeAttachHooks(opts({ events: ["SessionStart"] }));
    const merged = readJson(settingsPath);
    const groups = (merged.hooks as Record<string, Array<{ hooks: unknown[] }>>).SessionStart;
    // ActraDeck group に user hook を後付け (同 group 内に混在)。
    groups[0].hooks.push({ type: "command", command: "user-added" });
    writeFileSync(settingsPath, JSON.stringify(merged));

    detachAttachHooks(settingsPath);
    const after = readJson(settingsPath);
    const remaining = (after.hooks as Record<string, Array<{ hooks: unknown[] }>> | undefined)
      ?.SessionStart;
    // user-added hook は残り、ActraDeck entry は消えている。
    const flat = (remaining ?? []).flatMap((g) => g.hooks);
    expect(flat).toContainEqual({ type: "command", command: "user-added" });
    expect(flat.some(isActradeckEntry)).toBe(false);
  });

  it("detach on a settings without actradeck entries is a no-op", () => {
    writeFileSync(
      settingsPath,
      JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "x" }] }] } }),
    );
    const before = readFileSync(settingsPath, "utf8");
    const res = detachAttachHooks(settingsPath);
    expect(res.removed).toBe(false);
    expect(readFileSync(settingsPath, "utf8")).toBe(before); // 書き込まない
  });

  it("marker key is the stable ACTRADECK_MARKER constant", () => {
    expect(ACTRADECK_MARKER).toBe("__actradeck");
  });
});
