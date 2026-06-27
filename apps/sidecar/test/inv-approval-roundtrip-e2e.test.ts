/**
 * INV-APPROVAL-ROUNDTRIP — 承認往復 E2E (REAL DATA ONLY)。
 *
 * 段階④ (testing.md「主要導線 E2E 100%: 一覧→詳細→承認→replay」の **承認往復** 部分)。
 *
 * 既存の承認テストは「断片」を固定していた:
 *  - hook-approval-gate.test.ts  : HookReceiver の HTTP 応答形 (bridge を直接 resolve)。
 *  - inv-egress-e2e.test.ts (#2) : 生 WsClient ↔ backend で relay が emitter まで届く。
 *  - integration-realtime.test.ts: 生 sidecar WS ↔ backend で permission.requested→pending 投影。
 * しかし「**実 Sidecar の hook POST が承認応答を返すまで blocking し、UI の approve frame が
 * backend relay 経由で同一 sidecar の ApprovalBridge を resolve して hook 応答を解く**」一本の
 * 往復を、実 Sidecar クラス (HookReceiver + ApprovalBridge + WsClient + 内部 controlToken) で
 * 貫通する e2e は無かった。本テストがその唯一の貫通ゲートである。
 *
 * 往復 (load-bearing path):
 *   1. 高リスク PreToolUse hook を **実 Sidecar.HookReceiver** へ POST (hook auth token 付き)。
 *      → POST は応答を blocking で待つ (承認が来るまで返らない)。
 *   2. Sidecar が hook.session_id を canonical へ learn し、ApprovalBridge が request_id を採番、
 *      tool.permission.requested(request_id 付) を sink→WsClient→backend ingest。
 *   3. backend projection が pending_approvals に request_id を載せ、realtime detail に push。
 *   4. UI 役 WS が detail.pending_approvals から **その request_id を読み**、
 *      { type:"approve", session_id: canonical, request_id, decision } frame を送る。
 *   5. backend relayApprove → SidecarRegistry が hello で学習した **control_token を付与**して
 *      sidecar WsClient へ relay → WsClient.approval emit → Sidecar.on("approval") →
 *      ApprovalBridge.resolve → 1. の hook POST が permissionDecision を返して解ける。
 *
 * control_token 配線 (SEC-1):
 *   実 Sidecar は controlToken を **内部で randomBytes(32) 発行** し、WsClient が hello frame で
 *   backend へ送る (sidecar.ts:79,99 sessionIdsProvider)。backend は hello で control_token + 所有
 *   session を学習し、relayApprove がそれを載せ返す。WsClient は token 一致時のみ approval を emit
 *   する (fail-safe deny)。この経路が成立しないと relay が届かず往復が成立しない。本テストは UI が
 *   読んだ実 request_id で approve し、hook POST が実際に解けることで往復成立を end-to-end 実証する。
 *
 * 固定する往復ケース:
 *   (allow)             approve allow → permissionDecision "allow" + resolved(decision:allow)。
 *   (deny)              approve deny  → permissionDecision "deny"  + resolved(decision:deny)。
 *   (allow_for_session) approve allow_for_session → "allow"。以降の **同一署名** hook は UI を経ず
 *                       auto-allow され、新規 pending を出さない (over-allow でない exact-signature)。
 *   (cancel)            approve cancel → "deny" (安全側) + resolved(decision:cancel)。
 *   (timeout)           UI 無応答 → ApprovalBridge timeout → "deny" (force-allow しない)。
 *
 * REAL DATA ONLY: 実 Sidecar(全構成要素) + 実 buildIngestionServer + 実 PG + 実 ws。mock 無し。
 * DATABASE_URL 未到達時のみ describe.skipIf で skip するが、CI(verify job) では実走を保証する。
 * リソース (app/pool/sidecar/ui ws) は afterEach/afterAll で確実に close (leak 無し)。
 */
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import type { FastifyInstance } from "fastify";
import { Pool } from "pg";
import { WebSocket } from "ws";
import { buildIngestionServer } from "@actradeck/backend";

import { Sidecar } from "../src/sidecar.js";
import { HOOK_TOKEN_HEADER } from "../src/settings-injection.js";

const DATABASE_URL = process.env.DATABASE_URL;

async function dbReachable(connectionString: string): Promise<boolean> {
  const pool = new Pool({ connectionString, connectionTimeoutMillis: 2_000, max: 1 });
  try {
    const c = await pool.connect();
    c.release();
    return true;
  } catch {
    return false;
  } finally {
    await pool.end().catch(() => {});
  }
}

const reachable = DATABASE_URL ? await dbReachable(DATABASE_URL) : false;

// 偽緑防止: CI では DB 必須。到達不能で無音 skip すると承認往復 (load-bearing) を
// 検証しないまま緑になる。CI=true かつ未到達なら明示 fail (既存 webui int テストと同規約)。
if (process.env.CI === "true" && !reachable) {
  throw new Error(
    "CI requires a reachable DATABASE_URL for INV-APPROVAL-ROUNDTRIP e2e " +
      "(approval round-trip assertions must not be silently skipped).",
  );
}

const INGEST_TOKEN = "approval-rt-ingest-token-1234567890";
const REALTIME_TOKEN = "approval-rt-realtime-token-09876543210";

type ApprovalDecision = "allow" | "allow_for_session" | "deny" | "cancel";

/** 条件が真になるまで poll する (固定 sleep を避け flaky を防ぐ)。 */
async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  { timeoutMs = 8_000, stepMs = 20 }: { timeoutMs?: number; stepMs?: number } = {},
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

/** canonical = 実 claude hook session_id 相当 (UUID。redactor が UUID 形を保持する)。 */
function canonicalSession(): string {
  return randomUUID();
}

interface PreToolUseOutput {
  hookSpecificOutput?: {
    hookEventName?: string;
    permissionDecision?: string;
    permissionDecisionReason?: string;
  };
}

interface ServerDetailFrame {
  type?: string;
  session_id?: string;
  detail?: {
    pending_approvals?: Array<{
      request_id?: string;
      tool_name?: string;
      command?: string;
      risk_level?: string;
    }>;
  };
}

describe.skipIf(!reachable)(
  "INV-APPROVAL-ROUNDTRIP: real Sidecar hook ↔ backend ↔ PG ↔ UI approve frame",
  () => {
    let pool: Pool;
    let app: FastifyInstance;
    let port: number;
    const createdSessions: string[] = [];
    /** 各テストの Sidecar / temp dir / UI ws を teardown で確実に解放 (leak 無し)。 */
    const disposers: Array<() => void | Promise<void>> = [];

    beforeAll(async () => {
      pool = new Pool({ connectionString: DATABASE_URL, max: 5 });
      // realtimeToken を設定し /realtime/ws を mount。relay は backend 内部 SidecarRegistry を
      // realtime ルート越しに駆動する (production 非変更)。
      app = await buildIngestionServer({
        pool,
        ingestToken: INGEST_TOKEN,
        realtimeToken: REALTIME_TOKEN,
        maxPayloadBytes: 256 * 1024,
      });
      await app.listen({ port: 0, host: "127.0.0.1" });
      const addr = app.server.address();
      if (addr === null || typeof addr === "string") throw new Error("no ephemeral port");
      port = addr.port;
    });

    afterEach(async () => {
      // LIFO: 後から積んだものを先に閉じる (UI ws → sidecar → temp dir)。
      for (const d of disposers.splice(0).reverse()) {
        try {
          await d();
        } catch {
          /* teardown best-effort */
        }
      }
    });

    afterAll(async () => {
      if (createdSessions.length > 0) {
        await pool
          .query(`DELETE FROM sessions WHERE session_id = ANY($1::text[])`, [createdSessions])
          .catch(() => {});
      }
      if (app) await app.close();
      if (pool) await pool.end();
    });

    /**
     * 実 Sidecar を起動する (HookReceiver + ApprovalBridge + WsClient + 内部 controlToken)。
     * cwd は非 repo の temp dir にして GitWatcher 起動の副作用を避ける (承認往復の関心外)。
     * approvalTimeoutMs はテスト用に短め (timeout ケース以外は UI が即応するため影響しない)。
     */
    async function startSidecar(opts?: { approvalTimeoutMs?: number }): Promise<Sidecar> {
      const dir = mkdtempSync(join(tmpdir(), "approval-rt-"));
      // session の fallback id (canonical 確定前の暫定)。learn-wait モード (explicitSession 未指定)。
      const fallbackId = `sess_approval_rt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      createdSessions.push(fallbackId);
      const sidecar = new Sidecar({
        sessionId: fallbackId,
        wsUrl: `ws://127.0.0.1:${port}/ingest/ws`,
        dbPath: join(dir, "sidecar.db"),
        cwd: dir, // 非 repo → GitWatcher は起動しない。
        ingestToken: INGEST_TOKEN,
        ...(opts?.approvalTimeoutMs !== undefined
          ? { approvalTimeoutMs: opts.approvalTimeoutMs }
          : {}),
      });
      disposers.push(async () => {
        await sidecar.shutdown();
        rmSync(dir, { recursive: true, force: true });
      });
      const { hookEndpoint } = await sidecar.start();
      // WsClient が backend へ接続し hello (control_token + session) を送るまで待つ。
      expect(await waitFor(() => sidecar.wsClient.connected)).toBe(true);
      // hookEndpoint は http://host:port/hook 形。
      expect(hookEndpoint).toMatch(/\/hook$/);
      return sidecar;
    }

    /** 高リスク PreToolUse hook を実 HookReceiver へ POST (hook auth token 付き)。応答 Promise を返す。 */
    function postHighRiskHook(
      sidecar: Sidecar,
      sessionId: string,
      command = "rm -rf /tmp/actradeck-approval-rt",
    ): Promise<PreToolUseOutput> {
      return fetch(sidecar.hookReceiver.endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          // keep-alive を無効化: blocking hook の socket が teardown 後に reuse され
          // ECONNREFUSED unhandled rejection を出すのを防ぐ (各 POST は単発接続)。
          connection: "close",
          [HOOK_TOKEN_HEADER]: sidecar.hookAuthToken,
        },
        body: JSON.stringify({
          session_id: sessionId,
          hook_event_name: "PreToolUse",
          tool_name: "Bash",
          tool_input: { command },
        }),
      }).then(async (res) => {
        const text = await res.text();
        return (text.length > 0 ? JSON.parse(text) : {}) as PreToolUseOutput;
      });
    }

    /**
     * 実 UI realtime WS を開き、対象 session を subscribe し、detail.pending_approvals に
     * 当該操作の request_id が現れるまで待つ。request_id は **backend 投影由来の実値**を読む
     * (UI が突合キーを自前生成しない = 実配信を貫通する)。返り値 = ハンドル (approve 送信 + close)。
     */
    function openUi(sessionId: string): Promise<{
      waitForPending: (opts?: { exclude?: Set<string>; timeoutMs?: number }) => Promise<string>;
      sendApprove: (requestId: string, decision: ApprovalDecision, reason?: string) => void;
      sendApproveRaw: (frame: Record<string, unknown>) => void;
      close: () => void;
    }> {
      return new Promise((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/realtime/ws`, {
          headers: { authorization: `Bearer ${REALTIME_TOKEN}` },
        });
        const detailFrames: ServerDetailFrame[] = [];
        let snapshotListSeen = false;
        const t = setTimeout(() => {
          ws.terminate();
          reject(new Error("ui realtime connect timeout"));
        }, 5_000);

        ws.on("open", () => {
          clearTimeout(t);
          const handle = {
            waitForPending: async (
              opts: { exclude?: Set<string>; timeoutMs?: number } = {},
            ): Promise<string> => {
              const exclude = opts.exclude ?? new Set<string>();
              let found: string | undefined;
              // detail フレーム履歴を走査するため、再ゲート時に同一 request_id を拾わないよう
              // exclude (既に処理済みの request_id) を除外して **新規** pending を待つ。
              const ok = await waitFor(
                () => {
                  for (const f of detailFrames) {
                    if (f.session_id !== sessionId) continue;
                    for (const p of f.detail?.pending_approvals ?? []) {
                      if (
                        typeof p.request_id === "string" &&
                        p.request_id.length > 0 &&
                        !exclude.has(p.request_id)
                      ) {
                        found = p.request_id;
                        return true;
                      }
                    }
                  }
                  return false;
                },
                { timeoutMs: opts.timeoutMs ?? 8_000 },
              );
              if (!ok || found === undefined) {
                throw new Error("pending approval (with request_id) did not appear in detail");
              }
              return found;
            },
            sendApprove: (requestId: string, decision: ApprovalDecision, reason?: string): void => {
              ws.send(
                JSON.stringify({
                  type: "approve",
                  session_id: sessionId,
                  request_id: requestId,
                  decision,
                  ...(reason !== undefined ? { reason } : {}),
                }),
              );
            },
            sendApproveRaw: (frame: Record<string, unknown>): void => {
              ws.send(JSON.stringify(frame));
            },
            close: () => ws.close(),
          };
          // snapshot.list を受けてから subscribe する (backend が detail 配信を開始する契機)。
          const subscribeWhenReady = (): void => {
            if (snapshotListSeen)
              ws.send(JSON.stringify({ type: "subscribe", session_id: sessionId }));
          };
          // open 直後に来る snapshot.list を待って subscribe を投げる。
          void waitFor(() => snapshotListSeen, { timeoutMs: 5_000 }).then(subscribeWhenReady);
          resolve(handle);
        });
        ws.on("message", (data: Buffer) => {
          let msg: ServerDetailFrame & { type?: string };
          try {
            msg = JSON.parse(data.toString("utf8")) as typeof msg;
          } catch {
            return;
          }
          if (msg.type === "snapshot.list") snapshotListSeen = true;
          if (msg.type === "snapshot.detail" || msg.type === "delta.detail") {
            detailFrames.push(msg);
          }
        });
        ws.on("error", (e) => {
          clearTimeout(t);
          reject(e);
        });
        disposers.push(() => ws.close());
      });
    }

    /** PG の events に当該 session の resolved(decision) 行が現れるまで待つ。 */
    async function waitResolvedDecision(sessionId: string, decision: string): Promise<boolean> {
      return waitFor(async () => {
        const { rows } = await pool.query<{ n: string }>(
          `SELECT count(*)::int AS n FROM events
             WHERE session_id = $1 AND event_type = 'tool.permission.resolved'
               AND payload->>'decision' = $2`,
          [sessionId, decision],
        );
        return Number(rows[0]?.n ?? 0) >= 1;
      });
    }

    // --- (allow) 承認往復: UI allow → hook permissionDecision allow ----------
    it("(allow) UI approve(allow) round-trips to hook permissionDecision=allow + resolved(allow) in PG", async () => {
      const sidecar = await startSidecar();
      const canonical = canonicalSession();
      createdSessions.push(canonical);
      const ui = await openUi(canonical);

      // 1. 高リスク hook POST (blocking) を発火。
      const hookResp = postHighRiskHook(sidecar, canonical);

      // 2→3→4. backend 投影 detail に現れた **実 request_id** を読む。
      const requestId = await ui.waitForPending();
      expect(requestId).toMatch(/:apr-/); // bridge 採番形 (sessionId:apr-<base64url>)。

      // 5. UI が approve(allow) → relay(control_token) → resolve → hook 応答が解ける。
      ui.sendApprove(requestId, "allow");
      const out = await hookResp;
      expect(out.hookSpecificOutput?.hookEventName).toBe("PreToolUse");
      expect(out.hookSpecificOutput?.permissionDecision).toBe("allow");

      // resolved(allow) が backend(PG) まで往復確定したこと。
      expect(await waitResolvedDecision(canonical, "allow")).toBe(true);
      ui.close();
    });

    // --- (deny) 承認往復: UI deny → hook permissionDecision deny --------------
    it("(deny) UI approve(deny) round-trips to hook permissionDecision=deny + resolved(deny) in PG", async () => {
      const sidecar = await startSidecar();
      const canonical = canonicalSession();
      createdSessions.push(canonical);
      const ui = await openUi(canonical);

      const hookResp = postHighRiskHook(sidecar, canonical);
      const requestId = await ui.waitForPending();
      ui.sendApprove(requestId, "deny", "rejected by reviewer");

      const out = await hookResp;
      expect(out.hookSpecificOutput?.permissionDecision).toBe("deny");
      expect(await waitResolvedDecision(canonical, "deny")).toBe(true);
      ui.close();
    });

    // --- (cancel) 承認往復: UI cancel → 安全側 deny (resolved decision=cancel) -
    it("(cancel) UI approve(cancel) round-trips to hook permissionDecision=deny + resolved(cancel) in PG", async () => {
      const sidecar = await startSidecar();
      const canonical = canonicalSession();
      createdSessions.push(canonical);
      const ui = await openUi(canonical);

      const hookResp = postHighRiskHook(sidecar, canonical);
      const requestId = await ui.waitForPending();
      ui.sendApprove(requestId, "cancel");

      const out = await hookResp;
      // cancel は hook には安全側 deny を返す (ApprovalBridge.resolve: cancel→deny)。
      expect(out.hookSpecificOutput?.permissionDecision).toBe("deny");
      // ただし resolved の decision は UI が選んだ 4 値 (cancel) を保つ (表示で区別)。
      expect(await waitResolvedDecision(canonical, "cancel")).toBe(true);
      ui.close();
    });

    // --- (allow_for_session) 承認往復 + 同一署名 auto-allow (over-allow でない) -
    it("(allow_for_session) round-trips allow, then SAME-signature hook auto-allows WITHOUT a new pending card", async () => {
      const sidecar = await startSidecar();
      const canonical = canonicalSession();
      createdSessions.push(canonical);
      const ui = await openUi(canonical);

      const cmd = "rm -rf /tmp/actradeck-afs";

      // 1 回目: ゲートされ pending → UI が allow_for_session で許可 → hook allow。
      const hookResp1 = postHighRiskHook(sidecar, canonical, cmd);
      const requestId1 = await ui.waitForPending();
      ui.sendApprove(requestId1, "allow_for_session");
      const out1 = await hookResp1;
      expect(out1.hookSpecificOutput?.permissionDecision).toBe("allow");
      expect(await waitResolvedDecision(canonical, "allow_for_session")).toBe(true);

      // pending が空に戻る (resolved で reducer が当該 request_id を除去) のを待つ。
      // pendingCount(ApprovalBridge in-memory) で「未解決承認が滞留していない」ことも確認。
      expect(await waitFor(() => sidecar.approvalBridge.pendingCount === 0)).toBe(true);

      // 2 回目: **同一署名** (同一 tool+risk+command) → UI を経ず即 allow。
      // 新たな pending card / 新たな request_id は emit されない (exact-signature scope)。
      const out2 = await postHighRiskHook(sidecar, canonical, cmd);
      expect(out2.hookSpecificOutput?.permissionDecision).toBe("allow");
      // auto-allow は UI 承認を経ないため pendingCount は 0 のまま (新規ゲート無し)。
      expect(sidecar.approvalBridge.pendingCount).toBe(0);

      // PG: auto_allowed マーカー付き command.started が記録される (over-allow でなく人間同意の再適用)。
      expect(
        await waitFor(async () => {
          const { rows } = await pool.query<{ n: string }>(
            `SELECT count(*)::int AS n FROM events
               WHERE session_id = $1 AND event_type = 'command.started'
                 AND payload->>'auto_allowed' = 'true'`,
            [canonical],
          );
          return Number(rows[0]?.n ?? 0) >= 1;
        }),
      ).toBe(true);
      ui.close();
    });

    // --- (allow_for_session scope) 別署名は auto-allow されず再度ゲートされる ---
    it("(allow_for_session scope) a DIFFERENT command after allow_for_session is RE-GATED (no over-allow)", async () => {
      const sidecar = await startSidecar();
      const canonical = canonicalSession();
      createdSessions.push(canonical);
      const ui = await openUi(canonical);

      // allow_for_session で 1 つのコマンドを許可。
      const hookResp1 = postHighRiskHook(sidecar, canonical, "rm -rf /tmp/scope-a");
      const requestId1 = await ui.waitForPending();
      ui.sendApprove(requestId1, "allow_for_session");
      expect((await hookResp1).hookSpecificOutput?.permissionDecision).toBe("allow");
      expect(await waitFor(() => sidecar.approvalBridge.pendingCount === 0)).toBe(true);

      // **別コマンド** → 別署名 → 再度ゲートされ pending card が出る (auto-allow しない)。
      const hookResp2 = postHighRiskHook(sidecar, canonical, "rm -rf /tmp/scope-DIFFERENT");
      // requestId1 は detail 履歴に残るため、それを除外して **新規** pending を待つ。
      const requestId2 = await ui.waitForPending({ exclude: new Set([requestId1]) });
      expect(requestId2).not.toBe(requestId1); // 新規 request_id = 再ゲートされた証跡。
      // 再ゲートされたものを deny して締める (リーク無く resolve)。
      ui.sendApprove(requestId2, "deny");
      expect((await hookResp2).hookSpecificOutput?.permissionDecision).toBe("deny");
      ui.close();
    });

    // --- (timeout) UI 無応答 → ApprovalBridge timeout → 安全側 deny ----------
    it("(timeout) no UI response times out to permissionDecision=deny (force-allow されない)", async () => {
      // approvalTimeoutMs を短くし、UI を **開くが approve を送らない**。
      const sidecar = await startSidecar({ approvalTimeoutMs: 600 });
      const canonical = canonicalSession();
      createdSessions.push(canonical);
      // UI は detail を購読するが approve frame を送らない (無応答 = タイムアウト)。
      const ui = await openUi(canonical);

      const hookResp = postHighRiskHook(sidecar, canonical, "rm -rf /tmp/timeout-case");
      // pending が一旦投影されること (UI には承認カードが見えていた = 無応答での timeout)。
      const requestId = await ui.waitForPending();
      expect(requestId).toMatch(/:apr-/);

      // approve を送らない → bridge timeout → 安全側 deny。
      const out = await hookResp;
      expect(out.hookSpecificOutput?.permissionDecision).toBe("deny");
      // timeout は decision を載せない (effective deny) → resolved(deny) が PG へ。
      expect(await waitResolvedDecision(canonical, "deny")).toBe(true);
      ui.close();
    });

    // --- (foreign request_id) 他 session の approve は relay されず往復不成立 ----
    // SEC-2 の自セッションスコープを実機で固定する (over-relay でないことの証跡)。
    it("(foreign) approve for a NON-OWNED session_id does NOT resolve this sidecar's pending", async () => {
      const sidecar = await startSidecar({ approvalTimeoutMs: 1_200 });
      const canonical = canonicalSession();
      createdSessions.push(canonical);
      const ui = await openUi(canonical);

      const hookResp = postHighRiskHook(sidecar, canonical, "rm -rf /tmp/foreign-case");
      const requestId = await ui.waitForPending();

      // 他 session_id を詐称した approve frame を送る → backend は当該 session の所有 sidecar が
      // 居ない (canRelay=false) ため relay されず、この sidecar の pending は解けない。
      ui.sendApproveRaw({
        type: "approve",
        session_id: `${canonical}_FOREIGN`,
        request_id: requestId,
        decision: "allow",
      });

      // foreign approve では解けず、bridge timeout で deny に倒れる (force-allow されない)。
      const out = await hookResp;
      expect(out.hookSpecificOutput?.permissionDecision).toBe("deny");
      ui.close();
    });
  },
);
