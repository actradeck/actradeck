/**
 * INV-PROJECT-SCOPE — cwd 前方一致 allowlist による list 絞り込み (純ロジック + real PG)。
 *
 * 不変条件:
 *  - **off (空 scope) = 現行挙動を一切変えない** (全件返す)。
 *  - on = 一致セッションのみ。cwd NULL は除外 (fail-safe)。兄弟ディレクトリ (prefix を共有するが
 *    配下でないパス) は通さない。LIKE メタ文字 (`_ %`) を含む prefix は literal 一致 (誤ワイルドカードなし)。
 *  - narrows only: スコープは行を除外するだけで新たな情報を露出しない。
 *  - 3 list 経路すべて (realtime listSnapshot / approvalsSnapshot / audit rangeReport) で効く。
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";

import { AuditStore } from "../src/audit-store.js";
import { IngestStore } from "../src/ingest-store.js";
import { RealtimeStore } from "../src/realtime-store.js";
import { cwdScopeClause, parseProjectScope } from "../src/project-scope.js";
import { cleanupSessions, dbReachable, iso, makeEvent } from "./helpers.js";

const DATABASE_URL = process.env.DATABASE_URL;
const reachable = DATABASE_URL ? await dbReachable(DATABASE_URL) : false;

describe("project-scope 純ロジック (parseProjectScope / cwdScopeClause)", () => {
  it("parseProjectScope: 空/undefined は []、カンマ区切りを trim し空要素を捨てる", () => {
    expect(parseProjectScope(undefined)).toEqual([]);
    expect(parseProjectScope("")).toEqual([]);
    expect(parseProjectScope("   ")).toEqual([]);
    expect(parseProjectScope(",, ,")).toEqual([]);
    expect(parseProjectScope("/tmp/ad-demo")).toEqual(["/tmp/ad-demo"]);
    expect(parseProjectScope(" /tmp/ad-demo , /home/u/Files/X ,, ")).toEqual([
      "/tmp/ad-demo",
      "/home/u/Files/X",
    ]);
  });

  it("cwdScopeClause: 空 scope は no-op ({clause:'', params:[]})", () => {
    expect(cwdScopeClause([], "s.cwd", 2)).toEqual({ clause: "", params: [] });
  });

  it("cwdScopeClause: 非空は = ANY / LIKE ANY を startParam から採番し params を返す", () => {
    const { clause, params } = cwdScopeClause(["/tmp/ad-demo"], "s.cwd", 2);
    expect(clause).toBe("(s.cwd = ANY($2::text[]) OR s.cwd LIKE ANY($3::text[]))");
    expect(params).toEqual([["/tmp/ad-demo"], ["/tmp/ad-demo/%"]]);
  });

  it("cwdScopeClause: LIKE メタ文字 (_ % \\) を escape する (誤ワイルドカード防止)", () => {
    const { params } = cwdScopeClause(["/tmp/a_b%c"], "s.cwd", 1);
    // exact はそのまま、subdir パターンのみ escape + '/%'。
    expect(params[0]).toEqual(["/tmp/a_b%c"]);
    expect(params[1]).toEqual(["/tmp/a\\_b\\%c/%"]);
  });
});

describe.skipIf(!reachable)("INV-PROJECT-SCOPE: list 絞り込み (real PG)", () => {
  let pool: Pool;
  let store: IngestStore;

  // 共有 DB での干渉を避けるため遠未来ウィンドウ + 固有 prefix を使う。
  const BASE = Date.parse("2099-07-01T00:00:00.000Z");
  const TAG = `psco_${Date.now()}`;
  const CWD_IN = `/tmp/${TAG}-demo`; // scope 対象 (完全一致 + 配下)
  const CWD_SUB = `${CWD_IN}/pkg`; // scope 対象 (配下)
  const CWD_SIBLING = `/tmp/${TAG}-demo-other`; // 兄弟: prefix を共有するが配下でない → 除外されるべき
  const CWD_OUT = `/tmp/${TAG}-secret`; // scope 外
  const S_IN = `${TAG}_in`;
  const S_SUB = `${TAG}_sub`;
  const S_SIBLING = `${TAG}_sibling`;
  const S_OUT = `${TAG}_out`;
  const S_NULL = `${TAG}_nullcwd`;
  const all = [S_IN, S_SUB, S_SIBLING, S_OUT, S_NULL];

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL, max: 4 });
    store = new IngestStore({ pool });
    await cleanupSessions(pool, all);

    let t = 0;
    const ingest = async (sid: string, cwd: string | undefined): Promise<void> => {
      // heartbeat: セッション + cwd を投影 (cwd undefined は sessions.cwd NULL)。
      await store.ingest(
        makeEvent({
          session_id: sid,
          event_type: "heartbeat",
          timestamp: iso(BASE, (t += 1000)),
          ...(cwd !== undefined ? { cwd } : {}),
        }),
      );
    };
    await ingest(S_IN, CWD_IN);
    await ingest(S_SUB, CWD_SUB);
    await ingest(S_SIBLING, CWD_SIBLING);
    await ingest(S_OUT, CWD_OUT);
    await ingest(S_NULL, undefined);

    // S_IN と S_OUT に pending approval を立てる (approvalsSnapshot scope 検証用)。
    for (const [sid, cwd] of [
      [S_IN, CWD_IN],
      [S_OUT, CWD_OUT],
    ] as const) {
      await store.ingest(
        makeEvent({
          session_id: sid,
          event_type: "tool.permission.requested",
          state: "waiting.approval",
          timestamp: iso(BASE, (t += 1000)),
          cwd,
          payload: { request_id: `${sid}_r1`, tool_name: "Bash", risk_level: "high" },
        }),
      );
    }
  });

  afterAll(async () => {
    await cleanupSessions(pool, all);
    if (pool) await pool.end();
  });

  const ids = (rows: ReadonlyArray<{ session_id: string }>): Set<string> =>
    new Set(rows.map((r) => r.session_id));

  it("listSnapshot: scope 空は全件 (off = no-op・現行挙動不変)", async () => {
    const rt = new RealtimeStore(pool, []);
    const got = ids(await rt.listSnapshot(500, () => true));
    for (const sid of all) expect(got.has(sid)).toBe(true);
  });

  it("listSnapshot: scope は完全一致 + 配下のみ通し、兄弟/scope外/NULL cwd を除外", async () => {
    const rt = new RealtimeStore(pool, [CWD_IN]);
    const got = ids(await rt.listSnapshot(500, () => true));
    expect(got.has(S_IN)).toBe(true); // 完全一致
    expect(got.has(S_SUB)).toBe(true); // 配下
    expect(got.has(S_SIBLING)).toBe(false); // 兄弟 (prefix 共有だが配下でない)
    expect(got.has(S_OUT)).toBe(false); // scope 外
    expect(got.has(S_NULL)).toBe(false); // cwd NULL = fail-safe 除外
  });

  it("approvalsSnapshot: scope 内の pending のみ返し scope 外を除外", async () => {
    const inScope = new RealtimeStore(pool, [CWD_IN]);
    const got = ids(await inScope.approvalsSnapshot(() => true));
    expect(got.has(S_IN)).toBe(true);
    expect(got.has(S_OUT)).toBe(false);

    // off = no-op: 両方の pending が見える。
    const noScope = new RealtimeStore(pool, []);
    const all2 = ids(await noScope.approvalsSnapshot(() => true));
    expect(all2.has(S_IN)).toBe(true);
    expect(all2.has(S_OUT)).toBe(true);
  });

  it("rangeReport (audit): scope は完全一致 + 配下のみ、兄弟/scope外/NULL を除外", async () => {
    const now = iso(BASE, 100_000);
    const scoped = new AuditStore(pool, [CWD_IN]);
    const got = ids(
      (await scoped.rangeReport({ from: iso(BASE, 0), to: iso(BASE, 100_000), now })).sessions,
    );
    expect(got.has(S_IN)).toBe(true);
    expect(got.has(S_SUB)).toBe(true);
    expect(got.has(S_SIBLING)).toBe(false);
    expect(got.has(S_OUT)).toBe(false);
    expect(got.has(S_NULL)).toBe(false);

    // off = no-op: 全件 (本ウィンドウ内の作成分すべて)。
    const noScope = new AuditStore(pool, []);
    const all2 = ids(
      (await noScope.rangeReport({ from: iso(BASE, 0), to: iso(BASE, 100_000), now })).sessions,
    );
    for (const sid of all) expect(all2.has(sid)).toBe(true);
  });
});
