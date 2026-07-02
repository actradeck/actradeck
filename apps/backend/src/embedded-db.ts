/**
 * 埋込 PGlite (ADR 019f1b71) — Docker/Postgres を既定導線から外すための in-process DB。
 *
 * `@electric-sql/pglite` (WASM 上の実 PostgreSQL 18.3) を dataDir で永続起動し、
 * `@electric-sql/pglite-socket` の `PGLiteSocketServer` で **Unix domain socket** に Postgres wire
 * protocol で公開する。backend の `createPool()` をこの socket へ向けると、既存の 34 クエリ +
 * 3 store + 9 migration は**無改変**で動く (ORM/ドライバ差替えでなく「ただの Postgres」接続)。
 *
 * 起動順 (重要): PGlite → socket 公開 → **in-process migration (socket 経由)** → 呼び元が pool 生成。
 * migration が socket に 1 接続を張って切断した直後に pool が別接続を張るため、socket への**逐次
 * 2 接続**が起きる。`PGLiteSocketServer.maxConnections` の既定 1 だと 2 本目が
 * "Connection terminated unexpectedly" で落ちるため、余裕を持たせる (note 019f1b78 の実証)。
 *
 * 信頼境界 (SEC-1/TDA-5 硬化・decision 019f1b97): socket は **0700 ディレクトリ配下の Unix domain
 * socket** で公開する。TCP loopback (ephemeral port) は稼働中に同一ホストの別 uid プロセスからも
 * 到達できたが、Unix socket を 0700 dir に置くことで **socket 到達性 == fs 到達性 (uid スコープ)**
 * となり、0700 dataDir の保護意図と runtime も整合する (co-tenant 到達を構造 close・TCP port の
 * TOCTOU も消滅)。信頼境界は single-operator / local-fs (~/.actradeck/pgdata は approval allowlist /
 * policy.json と同格)。PGlite は資格情報を検証しない (trust) ため機密性/完全性は socket dir の
 * 0700 に依存する — password ではない。
 *
 * REAL DATA ONLY: モック無し。実 PGlite・実 socket・実 migration。
 */
import { chmod, mkdir, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";

import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { runMigrations } from "@actradeck/db";

/** PGlite は single-connection エンジン。pool は直列化 (max:1) する。 */
export const EMBEDDED_POOL_MAX = 1 as const;

/**
 * socket サーバの許容接続数。engine は single-connection だが server は query 単位で queue する。
 * pool max=1 ゆえ steady-state は 1 接続、migration→pool 交代の transient で ~2。8 は安全側の固定
 * 天井 (>1 が必須・既定 1 では 2 本目が落ちると note 019f1b78 で実証。expected concurrent ≤2)。
 */
const SOCKET_MAX_CONNECTIONS = 8;

/**
 * Unix socket のファイル名に使う port 番号。pg の unix socket 規約は host=ディレクトリ・
 * 実ファイル名 `.s.PGSQL.<port>`。TCP port ではない (bind しない) ため衝突せず固定でよい
 * (socket dir は dataDir 専用ゆえ他インスタンスと共有しない)。
 */
const SOCKET_PORT = 5432;

export interface EmbeddedDb {
  /** backend の createPool へ渡す接続文字列 (Unix domain socket・host=socket dir)。 */
  readonly connectionString: string;
  /** graceful shutdown: socket 停止 + PGlite close + socket ファイル除去。 */
  readonly close: () => Promise<void>;
}

/**
 * 埋込 PGlite の既定 dataDir。`ACTRADECK_PGDATA` で上書き可。
 * 既定は `~/.actradeck/pgdata` (Docker volume actradeck_pgdata の置換)。
 */
export function defaultDataDir(): string {
  const override = process.env.ACTRADECK_PGDATA;
  // override も resolve して正規化 (SEC-3: 末尾スラッシュ / 相対パスを絶対・正規形に)。
  if (override && override.trim().length > 0) return resolve(override.trim());
  return resolve(homedir(), ".actradeck", "pgdata");
}

/**
 * 埋込 PGlite を起動し、migration 適用済みの Unix socket 接続文字列を返す。
 * dataDir と socket dir はともに 0700 で作成/締め直す (secret を含みうる at-rest DB・local-fs 境界)。
 * boot 途中の失敗では生成済みリソースを解放してから rethrow する (部分 boot leak を防ぐ)。
 */
export async function startEmbeddedPg(inputDataDir: string): Promise<EmbeddedDb> {
  // dataDir を正規化 (SEC-3/TDA-N2): 末尾スラッシュ / 相対パスの env でも socketDir が sibling に
  // なるよう resolve する (`/x/pgdata/` を放置すると `${dataDir}.sock` が dataDir の子になる)。
  const dataDir = resolve(inputDataDir);

  // 前提 (TDA-N4): 1 dataDir につき埋込インスタンスは 1 つ (single-operator・PGlite は single-process)。
  // 同一 dataDir で複数プロセスを並走起動すると後発の pre-bind rm が先発の LIVE socket を unlink し
  // うる (先発の既存接続は生存・新規接続のみ失敗)。single-embedded-instance model 前提で運用する。

  // dataDir を 0700 で用意し、既存が loose (0755 等) でも締め直す
  // (SEC-2: mkdir recursive は既存 dir の mode を変えないため無条件 chmod する)。
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  await chmod(dataDir, 0o700);

  // socket は PGlite のデータファイルと混ぜないよう dataDir 専用の sibling dir (0700) に置く。
  // socket 到達性 == fs 到達性 (uid スコープ) にするのが眼目 (SEC-1)。
  const socketDir = `${dataDir}.sock`;
  await mkdir(socketDir, { recursive: true, mode: 0o700 });
  await chmod(socketDir, 0o700);
  const socketPath = resolve(socketDir, `.s.PGSQL.${SOCKET_PORT}`);
  // 前回 crash 時の残骸 socket で bind が EADDRINUSE になるのを防ぐ。
  await rm(socketPath, { force: true });

  let db: PGlite | undefined;
  let server: PGLiteSocketServer | undefined;
  try {
    db = await PGlite.create(dataDir);
    server = new PGLiteSocketServer({
      db,
      path: socketPath,
      maxConnections: SOCKET_MAX_CONNECTIONS,
    });
    await server.start();

    // pg / node-pg-migrate は host=socketDir + 既定 port で Unix socket に接続する。資格情報は
    // PGlite が trust ゆえ装飾値 (password 検証なし)。socketDir path を URL query に載せるため
    // encodeURIComponent する。
    const connectionString = `postgresql://postgres@localhost/postgres?host=${encodeURIComponent(socketDir)}`;

    // in-process migration (socket 起動後・pool 生成前)。schema が無いと ingest が失敗するため必須。
    await runMigrations(connectionString);

    const startedServer = server;
    const startedDb = db;
    return {
      connectionString,
      close: async () => {
        await startedServer.stop();
        await startedDb.close();
        await rm(socketPath, { force: true }).catch(() => {});
      },
    };
  } catch (err) {
    // 部分 boot cleanup (QA-3): 生成済みリソースを解放してから rethrow (leak 防止・fail-loud 維持)。
    // allSettled は個別失敗で reject せず、未生成 (undefined?.) は no-op になる。
    await Promise.allSettled([server?.stop(), db?.close(), rm(socketPath, { force: true })]);
    throw err;
  }
}
