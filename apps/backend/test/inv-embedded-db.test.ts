/**
 * INV-EMBEDDED-DB — 埋込 PGlite (ADR 019f1b71) の boot 経路と DB 往復を固定する。
 *
 * REAL DATA ONLY: モック無し。実 PGlite (WASM 上の実 PostgreSQL) + 実 socket + 実 migration +
 * 実 fastify スタック (app.inject は in-process で network を経由しない)。
 *
 * このテストは **実 Postgres (DATABASE_URL / Docker) を必要としない** — PGlite は自己完結ゆえ
 * postgres service 無しで走る (Phase 1c の埋込 test 移行の布石)。
 */
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildIngestionServer, createPool, startFromEnv } from "../src/index.js";
import {
  EMBEDDED_POOL_MAX,
  defaultDataDir,
  startEmbeddedPg,
  type EmbeddedDb,
} from "../src/embedded-db.js";
import { makeEvent } from "./helpers.js";

describe("INV-EMBEDDED-DB: 埋込 PGlite boot + DB 往復", () => {
  let dataDir: string;
  let embedded: EmbeddedDb;
  let pool: Pool;
  let app: FastifyInstance;

  beforeAll(async () => {
    dataDir = join(mkdtempSync(join(tmpdir(), "actradeck-embed-")), "pgdata");
    embedded = await startEmbeddedPg(dataDir);
    pool = createPool({ connectionString: embedded.connectionString, max: EMBEDDED_POOL_MAX });
    app = await buildIngestionServer({
      pool,
      ingestToken: "t-ing",
      realtimeToken: "t-rt",
      logger: false,
    });
  }, 30_000);

  afterAll(async () => {
    await app?.close();
    await pool?.end();
    await embedded?.close();
    if (dataDir) rmSync(join(dataDir, ".."), { recursive: true, force: true });
  });

  it("pool は単一接続に直列化する (PGlite は single-connection)", () => {
    expect(EMBEDDED_POOL_MAX).toBe(1);
  });

  it("defaultDataDir は ACTRADECK_PGDATA を尊重し、無ければ ~/.actradeck/pgdata", () => {
    const prev = process.env.ACTRADECK_PGDATA;
    try {
      process.env.ACTRADECK_PGDATA = "/tmp/custom-pgdata";
      expect(defaultDataDir()).toBe("/tmp/custom-pgdata");
      delete process.env.ACTRADECK_PGDATA;
      expect(defaultDataDir()).toMatch(/[/\\]\.actradeck[/\\]pgdata$/);
    } finally {
      if (prev === undefined) delete process.env.ACTRADECK_PGDATA;
      else process.env.ACTRADECK_PGDATA = prev;
    }
  });

  it("dataDir は 0700 で作成される (local-fs 境界・secret を含みうる at-rest DB)", () => {
    const mode = statSync(dataDir).mode & 0o777;
    expect(mode).toBe(0o700);
  });

  it("SEC-1: 接続は 0700 dir 配下の Unix socket (TCP loopback port でない)", () => {
    // co-tenant TCP 到達を構造 close: connectionString は host=socket dir の Unix socket 形式で、
    // ephemeral TCP loopback (@127.0.0.1:port) を使わない。socket dir は 0700 = fs-uid 境界。
    expect(embedded.connectionString).toContain("?host=");
    expect(embedded.connectionString).not.toMatch(/@127\.0\.0\.1:\d+/);
    const socketMode = statSync(`${dataDir}.sock`).mode & 0o777;
    expect(socketMode).toBe(0o700);
  });

  it("DB read: /realtime/approvals は 200 (pool→socket→PGlite + migration 適用済 schema)", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/realtime/approvals",
      headers: { authorization: "Bearer t-rt" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ approvals: [] });
  });

  it("認証ゲート不変: token 無し read は 401", async () => {
    const res = await app.inject({ method: "GET", url: "/realtime/approvals" });
    expect(res.statusCode).toBe(401);
  });

  it("DB write + 冪等: POST /ingest で append し、再送で duplicate (event_id UNIQUE が socket 経由で有効)", async () => {
    const sid = `sess_embed_${Date.now().toString(36)}`;
    const ev = makeEvent({ session_id: sid, state: "starting", event_type: "session.started" });

    const w1 = await app.inject({
      method: "POST",
      url: "/ingest",
      headers: { authorization: "Bearer t-ing" },
      payload: ev,
    });
    expect(w1.statusCode).toBe(200);
    const b1 = w1.json() as { results: { ok: boolean; inserted: boolean }[] };
    expect(b1.results[0]?.ok).toBe(true);
    expect(b1.results[0]?.inserted).toBe(true);

    const w2 = await app.inject({
      method: "POST",
      url: "/ingest",
      headers: { authorization: "Bearer t-ing" },
      payload: ev,
    });
    const b2 = w2.json() as { results: { inserted: boolean; duplicate?: boolean }[] };
    expect(b2.results[0]?.inserted).toBe(false);
    expect(b2.results[0]?.duplicate).toBe(true);

    // 直接照合: 書込が embedded PGlite に着地 + projection 反映。
    const cnt = await pool.query(`SELECT count(*)::int AS n FROM events WHERE session_id=$1`, [
      sid,
    ]);
    expect(cnt.rows[0].n).toBe(1);
    const st = await pool.query(`SELECT state FROM session_state WHERE session_id=$1`, [sid]);
    expect(st.rows).toHaveLength(1);
  });
});

describe("INV-EMBEDDED-DB: 硬化 (0700 締め直し / fail-loud)", () => {
  it("SEC-2: 事前に loose (0755) な dataDir を 0700 へ締め直す", async () => {
    const base = mkdtempSync(join(tmpdir(), "actradeck-embed-loose-"));
    const loose = join(base, "pgdata");
    mkdirSync(loose, { recursive: true });
    chmodSync(loose, 0o755); // umask 非依存で確実に loose 化 (QA-2: 実効 mode を pin)
    expect(statSync(loose).mode & 0o777).toBe(0o755);
    const emb = await startEmbeddedPg(loose);
    try {
      // startEmbeddedPg の無条件 chmod が既存 loose dir を締め直す。
      expect(statSync(loose).mode & 0o777).toBe(0o700);
    } finally {
      await emb.close();
      rmSync(base, { recursive: true, force: true });
    }
  }, 30_000);

  it("QA-3: 早期 boot 失敗を fail-loud に reject する (dataDir が非ディレクトリ)", async () => {
    // dataDir が既存の FILE を指すと mkdir(recursive) が throw → startEmbeddedPg は必ず reject する。
    const base = mkdtempSync(join(tmpdir(), "actradeck-embed-fail-"));
    const notADir = join(base, "pgdata-is-a-file");
    writeFileSync(notADir, "x");
    try {
      await expect(startEmbeddedPg(notADir)).rejects.toThrow();
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("QA-3: PGlite 初期化失敗で partial boot を cleanup して reject する", async () => {
    // 破損 dataDir (非互換 PG_VERSION) を用意 → PGlite.create が throw → catch の cleanup 経路を通り
    // reject する (生成途中リソースを握り潰さず解放・fail-loud)。
    const base = mkdtempSync(join(tmpdir(), "actradeck-embed-corrupt-"));
    const corrupt = join(base, "pgdata");
    mkdirSync(corrupt, { recursive: true });
    writeFileSync(join(corrupt, "PG_VERSION"), "99\n"); // 非互換 version で初期化失敗
    writeFileSync(join(corrupt, "postgresql.conf"), "garbage");
    try {
      await expect(startEmbeddedPg(corrupt)).rejects.toThrow();
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  }, 30_000);
});

describe("INV-EMBEDDED-DB: startFromEnv の DB モード選択", () => {
  it("DATABASE_URL 不在 → dbMode='embedded' で起動し close できる", async () => {
    const prevUrl = process.env.DATABASE_URL;
    const prevPgdata = process.env.ACTRADECK_PGDATA;
    const prevPort = process.env.ACTRADECK_BACKEND_PORT;
    const prevIngest = process.env.INGEST_TOKEN;
    const tmp = join(mkdtempSync(join(tmpdir(), "actradeck-embed-boot-")), "pgdata");
    try {
      delete process.env.DATABASE_URL;
      process.env.ACTRADECK_PGDATA = tmp;
      process.env.ACTRADECK_BACKEND_PORT = "0"; // OS 割当 ephemeral (衝突回避)
      process.env.INGEST_TOKEN = "t-boot";
      const server = await startFromEnv();
      try {
        expect(server.dbMode).toBe("embedded");
      } finally {
        await server.close();
      }
    } finally {
      if (prevUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = prevUrl;
      if (prevPgdata === undefined) delete process.env.ACTRADECK_PGDATA;
      else process.env.ACTRADECK_PGDATA = prevPgdata;
      if (prevPort === undefined) delete process.env.ACTRADECK_BACKEND_PORT;
      else process.env.ACTRADECK_BACKEND_PORT = prevPort;
      if (prevIngest === undefined) delete process.env.INGEST_TOKEN;
      else process.env.INGEST_TOKEN = prevIngest;
      rmSync(join(tmp, ".."), { recursive: true, force: true });
    }
  }, 30_000);
});
