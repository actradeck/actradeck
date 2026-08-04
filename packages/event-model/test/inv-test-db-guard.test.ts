/**
 * INV-TEST-DB-GUARD (SEC-2・裁定 019fc4c6): test harness が production DB へ接続しない。
 *
 * 契約:
 * 1. applyDotenvForTests は .env から DATABASE_URL を採用しない (主修正)。他 key の適用
 *    セマンティクス (既存 env 優先 / quote 剥がし / コメント・空行無視) は旧 setup-env と同一。
 * 2. applyTestDatabaseGuard は最終 DATABASE_URL が production port (55432 既定 +
 *    ACTRADECK_PG_PORT) を指すとき fail-loud に throw する。URL parse に依存しない数字境界
 *    照合ゆえ multi-host / key=value conninfo / 非 URL 形でも検出する。
 * 3. throw メッセージへ接続文字列を echo しない (credential NO-RAW)。
 * 4. ACTRADECK_TEST_DATABASE_URL は明示 opt-in として DATABASE_URL より優先されるが、
 *    それ自身も port ガードの対象 (test URL と称して prod を指す事故も遮断)。
 */
import { describe, expect, it } from "vitest";

import {
  applyDotenvForTests,
  applyTestDatabaseGuard,
  forbiddenTestDbPorts,
  isForbiddenTestDatabaseUrl,
  DEFAULT_PROD_PG_PORT,
  TEST_DB_URL_ENV_KEY,
} from "../src/index.js";

type Env = Record<string, string | undefined>;

describe("INV-TEST-DB-GUARD: applyDotenvForTests", () => {
  it("adopts ordinary keys but never DATABASE_URL from .env", () => {
    const env: Env = {};
    applyDotenvForTests(
      [
        "# comment line",
        "",
        "INGEST_TOKEN=tok-123",
        "DATABASE_URL=postgresql://actradeck:supersecretpw@127.0.0.1:55432/actradeck",
        "ACTRADECK_PG_PORT=55432",
        "not-a-kv-line",
      ].join("\n"),
      env,
    );
    expect(env.INGEST_TOKEN).toBe("tok-123");
    expect(env.ACTRADECK_PG_PORT).toBe("55432");
    // 主修正: production posture の .env から DATABASE_URL を拾わない。
    expect(env.DATABASE_URL).toBeUndefined();
  });

  it("adopts ACTRADECK_TEST_DATABASE_URL from .env (explicit opt-in) and strips quotes", () => {
    const env: Env = {};
    applyDotenvForTests(
      [
        `${TEST_DB_URL_ENV_KEY}="postgresql://t:t@127.0.0.1:5433/actradeck_test"`,
        "SINGLE_QUOTED='abc'",
      ].join("\n"),
      env,
    );
    expect(env[TEST_DB_URL_ENV_KEY]).toBe("postgresql://t:t@127.0.0.1:5433/actradeck_test");
    expect(env.SINGLE_QUOTED).toBe("abc");
  });

  it("does not overwrite keys already present in the environment (CI injection wins)", () => {
    const env: Env = { INGEST_TOKEN: "from-ci" };
    applyDotenvForTests("INGEST_TOKEN=from-dotenv\n", env);
    expect(env.INGEST_TOKEN).toBe("from-ci");
  });
});

describe("INV-TEST-DB-GUARD: forbidden port detection", () => {
  it("always forbids the default production port and honors numeric ACTRADECK_PG_PORT", () => {
    expect(forbiddenTestDbPorts({})).toEqual([DEFAULT_PROD_PG_PORT]);
    expect(forbiddenTestDbPorts({ ACTRADECK_PG_PORT: "6001" })).toEqual([
      DEFAULT_PROD_PG_PORT,
      "6001",
    ]);
    // 既定と同値なら重複しない。非数字 / 空は無視 (RegExp へ interpolate するため数字列のみ)。
    expect(forbiddenTestDbPorts({ ACTRADECK_PG_PORT: "55432" })).toEqual([DEFAULT_PROD_PG_PORT]);
    expect(forbiddenTestDbPorts({ ACTRADECK_PG_PORT: "abc" })).toEqual([DEFAULT_PROD_PG_PORT]);
    expect(forbiddenTestDbPorts({ ACTRADECK_PG_PORT: " " })).toEqual([DEFAULT_PROD_PG_PORT]);
  });

  it("detects the port token across URL, conninfo, and multi-host shapes", () => {
    const env: Env = {};
    expect(isForbiddenTestDatabaseUrl("postgresql://u:p@127.0.0.1:55432/actradeck", env)).toBe(
      "55432",
    );
    expect(isForbiddenTestDatabaseUrl("host=127.0.0.1 port=55432 dbname=x", env)).toBe("55432");
    expect(isForbiddenTestDatabaseUrl("postgresql://u:p@h1:5432,h2:55432/db", env)).toBe("55432");
    // 数字境界: :5432 (CI の使い捨てコンテナ) は 55432 と誤一致しない。
    expect(
      isForbiddenTestDatabaseUrl("postgresql://u:p@localhost:5432/actradeck", env),
    ).toBeUndefined();
    // 逆方向の境界: ACTRADECK_PG_PORT=5432 のとき ":55432" 内の部分列 "5432" に誤一致しない
    //   (先行文字が数字ゆえ境界不成立)。55432 は既定 port として一致する。
    const custom: Env = { ACTRADECK_PG_PORT: "5432" };
    expect(isForbiddenTestDatabaseUrl("postgresql://u:p@h:15432/db", custom)).toBeUndefined();
    expect(isForbiddenTestDatabaseUrl("postgresql://u:p@h:5432/db", custom)).toBe("5432");
  });

  it("over-matches toward safety: the digit-bounded token matches even outside a port position", () => {
    // 文書化された安全側挙動: DB 名等に数字列が現れても拒否する (false positive は安全方向)。
    expect(isForbiddenTestDatabaseUrl("postgresql://u:p@h:5433/db_55432_x", {})).toBe("55432");
  });
});

describe("INV-TEST-DB-GUARD: applyTestDatabaseGuard", () => {
  it("does nothing when DATABASE_URL is unset or blank (skip path preserved)", () => {
    const a: Env = {};
    applyTestDatabaseGuard(a);
    expect(a.DATABASE_URL).toBeUndefined();
    const b: Env = { DATABASE_URL: "  " };
    expect(() => applyTestDatabaseGuard(b)).not.toThrow();
  });

  it("passes a CI-style disposable-container URL through unchanged", () => {
    const env: Env = {
      DATABASE_URL: "postgresql://actradeck:ci_local_only@localhost:5432/actradeck",
    };
    applyTestDatabaseGuard(env);
    expect(env.DATABASE_URL).toBe("postgresql://actradeck:ci_local_only@localhost:5432/actradeck");
  });

  it("throws on a production-port DATABASE_URL without echoing the connection string", () => {
    const secret = "supersecretpw";
    const env: Env = { DATABASE_URL: `postgresql://actradeck:${secret}@127.0.0.1:55432/actradeck` };
    let thrown: Error | undefined;
    try {
      applyTestDatabaseGuard(env);
    } catch (e) {
      thrown = e as Error;
    }
    expect(thrown).toBeDefined();
    expect(thrown?.message).toContain("55432");
    // NO-RAW: credential と接続文字列本体をメッセージへ出さない。
    expect(thrown?.message).not.toContain(secret);
    expect(thrown?.message).not.toContain("postgresql://");
  });

  it("honors ACTRADECK_PG_PORT as an additional forbidden port", () => {
    const env: Env = {
      ACTRADECK_PG_PORT: "6001",
      DATABASE_URL: "postgresql://u:p@127.0.0.1:6001/actradeck",
    };
    expect(() => applyTestDatabaseGuard(env)).toThrow(/6001/);
  });

  it("prefers ACTRADECK_TEST_DATABASE_URL over an ambient DATABASE_URL", () => {
    const env: Env = {
      DATABASE_URL: "postgresql://u:p@127.0.0.1:9999/ambient",
      [TEST_DB_URL_ENV_KEY]: "postgresql://t:t@127.0.0.1:5433/actradeck_test",
    };
    applyTestDatabaseGuard(env);
    expect(env.DATABASE_URL).toBe("postgresql://t:t@127.0.0.1:5433/actradeck_test");
  });

  it("guards the explicit test URL too: a prod-port ACTRADECK_TEST_DATABASE_URL still throws", () => {
    const env: Env = {
      [TEST_DB_URL_ENV_KEY]: "postgresql://t:t@127.0.0.1:55432/actradeck",
    };
    expect(() => applyTestDatabaseGuard(env)).toThrow(/55432/);
  });

  it("ignores a blank ACTRADECK_TEST_DATABASE_URL (does not clobber DATABASE_URL)", () => {
    const env: Env = {
      DATABASE_URL: "postgresql://u:p@localhost:5432/actradeck",
      [TEST_DB_URL_ENV_KEY]: "  ",
    };
    applyTestDatabaseGuard(env);
    expect(env.DATABASE_URL).toBe("postgresql://u:p@localhost:5432/actradeck");
  });

  it("closes the libpq PGPORT fallback: port-less URL + production PGPORT throws", () => {
    // node-pg は接続文字列に port が無いと env PGPORT へフォールバックする — URL だけ見る
    //   ガードの死角になるため、PGPORT も forbidden port 照合の対象。
    const env: Env = {
      DATABASE_URL: "postgresql://actradeck@127.0.0.1/actradeck",
      PGPORT: "55432",
    };
    expect(() => applyTestDatabaseGuard(env)).toThrow(/PGPORT/);
  });

  it("rejects a forbidden PGPORT even when the URL carries an explicit safe port (safe-side)", () => {
    const env: Env = {
      DATABASE_URL: "postgresql://actradeck@127.0.0.1:5455/actradeck",
      PGPORT: "55432",
    };
    expect(() => applyTestDatabaseGuard(env)).toThrow(/PGPORT/);
  });

  it("accepts a disposable PGPORT and ignores a non-numeric one", () => {
    const ok: Env = {
      DATABASE_URL: "postgresql://actradeck@127.0.0.1/actradeck",
      PGPORT: "5455",
    };
    expect(() => applyTestDatabaseGuard(ok)).not.toThrow();
    const junk: Env = {
      DATABASE_URL: "postgresql://actradeck@127.0.0.1/actradeck",
      PGPORT: "not-a-port",
    };
    expect(() => applyTestDatabaseGuard(junk)).not.toThrow();
  });

  it("does not evaluate PGPORT when no DATABASE_URL is set (skip path stays quiet)", () => {
    // DATABASE_URL 不在なら real-PG suites は接続自体を試みない (describe.skipIf)。
    //   PGPORT だけが production を指していても throw せず従来の skip 経路を保つ。
    const env: Env = { PGPORT: "55432" };
    expect(() => applyTestDatabaseGuard(env)).not.toThrow();
  });
});
