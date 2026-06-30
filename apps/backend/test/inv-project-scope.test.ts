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
import {
  cwdScopeClause,
  isPathWithinProjectScope,
  parseProjectScope,
} from "../src/project-scope.js";
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

  // ADR 019f0eca 方式B: resolve endpoint の path 封じ込め (cwdScopeClause と同一意味論を JS で)。
  describe("isPathWithinProjectScope (方式B resolve 封じ込め)", () => {
    const SCOPE = ["/home/me/work", "/tmp/ad-demo"];
    it("scope 空は無制限 (default-off・他経路と整合)", () => {
      expect(isPathWithinProjectScope("/anywhere/at/all", [])).toBe(true);
      expect(isPathWithinProjectScope("/etc/passwd", [])).toBe(true);
    });
    it("完全一致 + 配下のみ true (兄弟/scope外は false)", () => {
      expect(isPathWithinProjectScope("/home/me/work", SCOPE)).toBe(true);
      expect(isPathWithinProjectScope("/home/me/work/repo", SCOPE)).toBe(true);
      expect(isPathWithinProjectScope("/tmp/ad-demo/x/y", SCOPE)).toBe(true);
      // 兄弟 (prefix を共有するが配下でない) は false。
      expect(isPathWithinProjectScope("/home/me/work-other", SCOPE)).toBe(false);
      expect(isPathWithinProjectScope("/home/me/workshop", SCOPE)).toBe(false);
      // scope 外。
      expect(isPathWithinProjectScope("/home/me/secret", SCOPE)).toBe(false);
      expect(isPathWithinProjectScope("/etc", SCOPE)).toBe(false);
    });
    it("`..` traversal を normalize で畳んでから判定する (scope 脱出を防ぐ)", () => {
      // /home/me/work/../secret → /home/me/secret (scope 外) → false。
      expect(isPathWithinProjectScope("/home/me/work/../secret", SCOPE)).toBe(false);
      // /home/me/work/sub/.. → /home/me/work (一致) → true。
      expect(isPathWithinProjectScope("/home/me/work/sub/..", SCOPE)).toBe(true);
      // 末尾スラッシュ・重複スラッシュは正規化して一致。
      expect(isPathWithinProjectScope("/home/me/work/", SCOPE)).toBe(true);
      expect(isPathWithinProjectScope("/tmp/ad-demo//pkg", SCOPE)).toBe(true);
    });
    it("非絶対 / 空 / 非 string / NUL 含みは false (安全側)", () => {
      expect(isPathWithinProjectScope("relative/path", SCOPE)).toBe(false);
      expect(isPathWithinProjectScope("", SCOPE)).toBe(false);
      expect(isPathWithinProjectScope(undefined, SCOPE)).toBe(false);
      expect(isPathWithinProjectScope(123, SCOPE)).toBe(false);
      expect(isPathWithinProjectScope("/home/me/work\0/etc", SCOPE)).toBe(false);
    });
  });

  // TDA-6 / QA-5 (decision 019f0f2f): JS (isPathWithinProjectScope) ↔ SQL (cwdScopeClause) の封じ込め契約を
  // 共有 fixture で pin する。cwdScopeClause の実 params から Postgres LIKE 意味論を忠実にエミュレートし、
  // **canonical 入力で両者が一致**することを固定する (parseProjectScope の prefix canonical 化が SQL へ流れる)。
  describe("INV-SCOPE-JS-SQL-AGREEMENT (TDA-6): JS と SQL 封じ込めが canonical 入力で一致", () => {
    // Postgres LIKE (default escape `\`) を正規表現で忠実にエミュレートする。
    function likeToRegex(pattern: string): RegExp {
      let re = "^";
      for (let i = 0; i < pattern.length; i += 1) {
        const ch = pattern[i]!;
        if (ch === "\\") {
          i += 1;
          re += pattern[i]!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        } else if (ch === "%") {
          re += "[\\s\\S]*";
        } else if (ch === "_") {
          re += "[\\s\\S]";
        } else {
          re += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        }
      }
      return new RegExp(re + "$");
    }
    // cwdScopeClause の params (= ANY exact / LIKE ANY subdir) を実際に評価する SQL 等価判定。
    function sqlMatches(scope: string[], cwd: string): boolean {
      const { params } = cwdScopeClause(scope, "cwd", 1);
      if (params.length === 0) return true; // 空 scope → clause 無し → 全通し。
      const [exact, subdir] = params;
      if (exact!.includes(cwd)) return true;
      return subdir!.some((pat) => likeToRegex(pat).test(cwd));
    }

    it("canonical な (scope, cwd) 組で JS と SQL が完全一致する", () => {
      const scope = parseProjectScope("/home/me/work,/tmp/a_b%c"); // メタ文字込み + canonical 化。
      // すべて canonical (末尾スラッシュ/.. 無し) な cwd — 実 cwd はこの形 (物理絶対パス)。
      const cwds = [
        "/home/me/work", // 完全一致
        "/home/me/work/repo/src", // 配下
        "/home/me/work-other", // 兄弟
        "/home/me", // 上位
        "/tmp/a_b%c/pkg", // メタ文字 prefix の配下 (literal 一致)
        "/tmp/aXbYc/pkg", // メタ文字を誤ワイルドカード解釈すると一致してしまう罠
        "/etc/passwd", // scope 外
      ];
      for (const cwd of cwds) {
        expect(isPathWithinProjectScope(cwd, scope)).toBe(sqlMatches(scope, cwd));
      }
      // 誤ワイルドカードが無いことを明示 (escape が効いている)。
      expect(isPathWithinProjectScope("/tmp/aXbYc/pkg", scope)).toBe(false);
      expect(sqlMatches(scope, "/tmp/aXbYc/pkg")).toBe(false);
    });

    it("空 scope は両者とも全通し (off = no-op)", () => {
      for (const cwd of ["/a", "/b/c", "/etc"]) {
        expect(isPathWithinProjectScope(cwd, [])).toBe(true);
        expect(sqlMatches([], cwd)).toBe(true);
      }
    });

    it("既知の意図的差異: 非 canonical cwd では JS が normalize し SQL より厳格 (安全側)", () => {
      const scope = parseProjectScope("/home/me/work");
      // 実 cwd には現れない traversal 入り (resolve は任意入力を受けるため JS が防御)。
      const traversal = "/home/me/work/../secret";
      // SQL は col を raw 比較するため LIKE '/home/me/work/%' に literal 一致して **通してしまう**。
      expect(sqlMatches(scope, traversal)).toBe(true);
      // JS は normalize で /home/me/secret へ畳み scope 外と判定 → 拒否 (危険判定はこちらを使う)。
      expect(isPathWithinProjectScope(traversal, scope)).toBe(false);
    });
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
