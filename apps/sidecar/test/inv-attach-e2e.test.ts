/**
 * INV-ATTACH-E2E (QA-3) — 実 claude を managed ラッパ無しで起動し、Attach Mode の
 * **hook 後付け観測** を end-to-end で貫通させる (REAL DATA ONLY)。
 *
 * 既存 attach テストは全て in-process (fetch→AttachDaemon→SQLite) で、実 claude が
 * 配線済み settings 経由で daemon の hook endpoint を叩く経路が CI で未検証だった。
 * 本テストがその唯一の貫通ゲート:
 *   temp HOME + temp git repo + mergeAttachHooks で `.claude/settings.local.json` を literal
 *   token で配線 → 実 `claude -p` (headless) を temp repo cwd で実走 → claude が hook を
 *   daemon endpoint へ POST (token round-trip) → AttachDaemon → sink.redactDeep → SQLite。
 *
 * 必達 assertion:
 *  1. SQLite に `capture_mode="attach"` のイベントが 1 件以上着地する。
 *  2. canonical session_id が **claude 由来の実 id** (fallback 採番でない = registry の
 *     observeHook が hook session_id を即確定)。
 *  3. token round-trip: daemon が受けた hook は 200 (= settings の literal nonce が一致)。
 *     no-token 偽装は 403 (auth 健在)。
 *
 * 偽緑防止: claude 未到達は describe.skipIf で skip するが、CI では実走必須
 * (process.env.CI === "true" かつ未到達なら hard-fail)。既存 INV-CODEX-E2E と同規約。
 *
 * 🔴 安全制約: 実ユーザー settings / 本リポ .claude を絶対に触らない。HOME/cwd は temp のみ。
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { AttachDaemon } from "../src/attach-daemon.js";
import { mergeAttachHooks } from "../src/settings-merge.js";
import { EventStore } from "../src/store.js";

const CLAUDE_BIN = process.env.ACTRADECK_CLAUDE_BIN ?? "claude";

/** claude バイナリが実在するか (skipIf 用)。 */
function claudeReachable(): boolean {
  try {
    const out = execFileSync(CLAUDE_BIN, ["--version"], { encoding: "utf8", timeout: 10_000 });
    return /claude/i.test(out);
  } catch {
    return false;
  }
}

const reachable = claudeReachable();

// 偽緑防止: CI では実 claude 必須。未到達で無音 skip すると Attach 経路 (load-bearing) を
// 検証しないまま緑になる。ただし PUBLIC OSS CI は claude バイナリ + API キーを供給できない
// (インストール不可・秘匿コスト)。その環境は ACTRADECK_SKIP_REAL_BIN_E2E=1 を明示設定して
// graceful skip にオプトアウトする (silent でなく ci.yml で明示)。バイナリを持つ private/fork CI は
// 既定どおり fail-loud のまま。決定論 Attach 検証は run-hook-replay-e2e (実バイナリ不要) が e2e job で担う。
if (process.env.CI === "true" && !reachable && process.env.ACTRADECK_SKIP_REAL_BIN_E2E !== "1") {
  throw new Error(
    `CI requires a reachable claude binary for INV-ATTACH-E2E (ACTRADECK_CLAUDE_BIN=${CLAUDE_BIN}). ` +
      "Install claude-code or set ACTRADECK_CLAUDE_BIN (or set ACTRADECK_SKIP_REAL_BIN_E2E=1 to skip).",
  );
}

describe.skipIf(!reachable)(
  "INV-ATTACH-E2E: real claude (no managed wrapper) → hooks → daemon → SQLite",
  () => {
    const cleanups: Array<() => Promise<void> | void> = [];

    afterEach(async () => {
      for (const c of cleanups.splice(0).reverse()) await c();
    });

    it("wires settings, real claude fires hooks at daemon, events land with capture_mode=attach + real canonical + token round-trip", async () => {
      const root = mkdtempSync(join(tmpdir(), "attach-e2e-"));
      const home = join(root, "home");
      const repo = join(root, "repo");
      const dbPath = join(root, "sidecar.db");
      cleanups.push(() => rmSync(root, { recursive: true, force: true }));

      // temp git repo (GitWatcher の repo root 特定 + 実差分)。
      execFileSync("git", ["init", "-q", repo]);
      execFileSync("git", ["-C", repo, "config", "user.email", "t@t.t"]);
      execFileSync("git", ["-C", repo, "config", "user.name", "t"]);
      writeFileSync(join(repo, "README.md"), "# e2e\n");

      // 到達不能 ws (backend 不要)。hook 観測 → SQLite choke までを貫通する。
      const daemon = new AttachDaemon({
        wsUrl: "ws://127.0.0.1:1/ingest/ws",
        dbPath,
        host: "127.0.0.1",
        onHook: () => {},
      });
      cleanups.push(() => daemon.shutdown());
      const { hookEndpoint } = await daemon.start();

      // literal token で project-local settings を配線 (実 nonce = daemon.hookAuthToken)。
      const settingsPath = join(repo, ".claude", "settings.local.json");
      mergeAttachHooks({
        settingsPath,
        endpoint: hookEndpoint,
        tokenMode: "literal",
        token: daemon.hookAuthToken,
      });

      // token round-trip の確認: 正 token=200 / no-token=403 (auth 健在)。
      const port = new URL(hookEndpoint).port;
      const okStatus = await postHook(port, daemon.hookAuthToken, {
        session_id: "probe",
        hook_event_name: "SessionStart",
        cwd: repo,
        source: "startup",
      });
      const noTokStatus = await postHook(port, undefined, {
        session_id: "probe2",
        hook_event_name: "SessionStart",
      });
      expect(okStatus).toBe(200);
      expect(noTokStatus).toBe(403);

      // 実 claude を headless 実走 (managed ラッパ無し)。HOME=temp で実ユーザー設定を触らない。
      // `-p` print mode は非対話で hook を発火する。--permission-mode bypassPermissions で
      // 承認待ちで止まらないようにする (観測のみ目的)。
      try {
        execFileSync(
          CLAUDE_BIN,
          ["-p", "say hi and stop", "--permission-mode", "bypassPermissions"],
          {
            cwd: repo,
            env: {
              ...process.env,
              HOME: home,
              CLAUDE_CONFIG_DIR: join(home, ".claude"),
            },
            timeout: 90_000,
            stdio: "ignore",
          },
        );
      } catch {
        // claude の exit code 非ゼロ (API 未設定等) でも、SessionStart/Stop hook は発火しうる。
        // hook 着地を下で検証するため、ここでは exit を握り潰す。
      }

      // hook の非同期 emit を待って SQLite を確認。
      const events = await waitForEvents(dbPath, (rows) =>
        rows.some((e) => e.capture_mode === "attach" && e.session_id !== "probe"),
      );

      // 1. capture_mode=attach が着地。
      const attachEvents = events.filter((e) => e.capture_mode === "attach");
      expect(attachEvents.length).toBeGreaterThan(0);

      // 2. claude 由来の実 canonical (probe/sidecar 採番でない実 session id)。
      const claudeSessions = new Set(
        attachEvents.map((e) => e.session_id as string).filter((s) => s !== "probe"),
      );
      expect(claudeSessions.size).toBeGreaterThan(0);
      for (const sid of claudeSessions) {
        expect(typeof sid).toBe("string");
        expect((sid as string).length).toBeGreaterThan(0);
        expect(sid).not.toBe("probe");
      }

      // 3. registry が実 session を観測した (multiplex entry 生成)。
      expect(daemon.observedSessionCount).toBeGreaterThan(0);
    }, 120_000);
  },
);

async function postHook(port: string, token: string | undefined, body: unknown): Promise<number> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token !== undefined) headers["X-ActraDeck-Hook-Token"] = token;
  const res = await fetch(`http://127.0.0.1:${port}/hook`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  await res.text();
  return res.status;
}

/** SQLite を poll し predicate を満たすまで待つ (固定 sleep を避け flaky を防ぐ)。 */
async function waitForEvents(
  dbPath: string,
  predicate: (rows: Array<Record<string, unknown>>) => boolean,
  { timeoutMs = 8_000, stepMs = 100 }: { timeoutMs?: number; stepMs?: number } = {},
): Promise<Array<Record<string, unknown>>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const rows = readEvents(dbPath);
    if (predicate(rows)) return rows;
    if (Date.now() >= deadline) return rows;
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

function readEvents(dbPath: string): Array<Record<string, unknown>> {
  let store: EventStore | undefined;
  try {
    store = new EventStore(dbPath);
    return store
      .allRows()
      .map((r) => JSON.parse(r.event_json as string) as Record<string, unknown>);
  } catch {
    return [];
  } finally {
    store?.close();
  }
}
