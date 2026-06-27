/**
 * @actradeck/backend — Fastify service (Phase 3 core 縦スライス).
 *
 * sidecar → WS Ingestion 受信 → 冪等 Event Store 永続化 → State Engine reducer →
 * session_state projection → Liveness 合成判定。
 *
 * Phase 3 ③: UI 向け Realtime (/realtime/ws) を別経路・別認証 (REALTIME_TOKEN) で追加。
 * backend→UI に session 一覧/詳細を push し、UI→Sidecar の承認・interrupt を中継する
 * (UI コンポーネント自体は Phase 4 / realtime-frontend の領域)。
 * DB 接続文字列は env (DATABASE_URL) 経由。受信認証トークンは env (INGEST_TOKEN / REALTIME_TOKEN)。
 */
import { pathToFileURL } from "node:url";

import { EVENT_MODEL_PACKAGE } from "@actradeck/event-model";

import { createPool } from "./db.js";
import { buildIngestionServer } from "./ingestion-server.js";

export const BACKEND_NAME = "@actradeck/backend" as const;

export function describeBackend(): string {
  return `${BACKEND_NAME} (uses ${EVENT_MODEL_PACKAGE})`;
}

// 公開面 (Phase 3 core)。
export { createPool, isReachable } from "./db.js";
export {
  applyEvent,
  reduceEvents,
  initialProjection,
  type SessionProjection,
  type ReduceResult,
} from "./reducer.js";
export {
  synthesizeLiveness,
  observeFromEvents,
  DEFAULT_STALE_MS,
  type LivenessResult,
  type LivenessObservation,
  type LivenessState,
  type LivenessEvidence,
} from "./liveness.js";
export {
  IngestStore,
  aggregateObservationSql,
  type IngestResult,
  type IngestStoreOptions,
} from "./ingest-store.js";
export { buildIngestionServer, type IngestionServerOptions } from "./ingestion-server.js";
export {
  RealtimeHub,
  UiConnectionHandle,
  type RealtimeSink,
  type SessionListItem,
  type SessionDetail,
  type ServerFrame,
  type ClientFrame,
  // ADR 019e9999 段階②: UI 承認カードが SessionDetail.pending_approvals の要素型を
  // 単一の真実 (reducer.ts 正典・realtime-hub.ts 再export) として type-only import するため、
  // パッケージ entrypoint からも forward する (webui contract.ts の追従先)。
  type PendingApproval,
  // ADR 019ead14 段階1: 横断 Approval Inbox の集約行 DTO。webui contract.ts が type-only 追従する。
  type SessionApprovals,
  // ADR 019ead7a 段階1: Live Wall 横断フィードの DTO。webui contract.ts が type-only 追従する。
  type WallLane,
} from "./realtime-hub.js";
export { RealtimeStore } from "./realtime-store.js";
export {
  ReplayStore,
  DEFAULT_REPLAY_LIMIT,
  MAX_REPLAY_LIMIT,
  decodeReplayCursor,
  encodeReplayCursor,
  normalizeReplayLimit,
  rowToReplayEvent,
} from "./replay-store.js";
export type { ReplayEventDTO, ReplayEventKind, ReplayEventsPage } from "./replay-contract.js";
export { REPLAY_ORDER, type ReplayOrder } from "./replay-contract.js";
export {
  SidecarRegistry,
  isHelloFrame,
  type SidecarLink,
  type RelayResult,
  type ApprovalRelay,
  type AllowlistEntry,
  type AllowlistRelayResult,
} from "./sidecar-registry.js";
export { registerRealtimeRoute, type RealtimeRouteOptions } from "./realtime-server.js";

/**
 * 実プロセス起動 (env から構成)。tsx watch / node dist で使う。
 * REAL DATA ONLY: DATABASE_URL / INGEST_TOKEN が無ければ起動を拒否する。
 */
export async function startFromEnv(): Promise<{
  address: string;
  port: number;
  host: string;
  close: () => Promise<void>;
}> {
  const ingestToken = process.env.INGEST_TOKEN;
  if (!ingestToken) {
    throw new Error("INGEST_TOKEN is required (no unauthenticated ingestion)");
  }
  // UI 向け realtime は別 token (REALTIME_TOKEN)。未設定なら /realtime/ws を生やさない
  // (sidecar token を UI に流用させない / 無認証配信を作らない)。
  const realtimeToken = process.env.REALTIME_TOKEN;
  const pool = createPool();
  const app = await buildIngestionServer({
    pool,
    ingestToken,
    ...(realtimeToken ? { realtimeToken } : {}),
    logger: true,
  });
  // port=0 を渡すと OS が空きポートを割り当てる (smoke は衝突回避にこれを使う)。
  const port = Number(process.env.ACTRADECK_BACKEND_PORT ?? 55410);
  const host = process.env.ACTRADECK_BACKEND_HOST ?? "127.0.0.1";
  // listen() は実際に bind したアドレス文字列を返す (port=0 のとき実 port を含む)。
  const address = await app.listen({ port, host });
  // 実際に bind した port を server から取り出す (env の 0 ではなく解決後の値)。
  const addr = app.server.address();
  const boundPort = addr && typeof addr === "object" ? addr.port : port;
  return {
    address,
    port: boundPort,
    host,
    close: async () => {
      await app.close();
      await pool.end();
    },
  };
}

/**
 * このモジュールが **エントリポイントとして直接実行された** か (import されたのではなく) を判定する。
 *
 * 背景 (本 commit の defect class): 以前は startFromEnv を export するだけで誰も呼ばず、
 * `pnpm dev`/`start` が server を起動しなかった (型/build/test 緑でも実行時 no-op)。
 *
 * 判定方式 (WebSearch 2ality "Node.js: checking if an ESM module is main" / es-main の手法):
 * ESM には CommonJS の `require.main === module` が無い。代わりに **`import.meta.url` を
 * `pathToFileURL(process.argv[1]).href` と比較**する。
 *  - `import.meta.url` は file URL (`file://...`)、`process.argv[1]` は OS パス文字列なので、
 *    後者を `pathToFileURL` で file URL へ正規化してから比較する (文字列直比較は不可)。
 *  - tsx 経由 (`node --import tsx src/index.ts` / `tsx watch src/index.ts`) でも両者は同じ
 *    ソース .ts に解決され一致する (実測: probe で match=true)。node dist 実行でも同様。
 *  - **import 時 (test が `import { startFromEnv }` する等) は argv[1] が test runner なので
 *    一致せず発火しない** → export 群は副作用ゼロ (listen しない)。
 */
export function isDirectEntrypoint(
  metaUrl: string,
  argv1: string | undefined = process.argv[1],
): boolean {
  if (!argv1) return false;
  let argvUrl: string;
  try {
    argvUrl = pathToFileURL(argv1).href;
  } catch {
    return false;
  }
  return metaUrl === argvUrl;
}

/**
 * CLI から **直接実行されたときだけ** server を起動する (import 時は何もせず null を返す)。
 *
 * QA-1 (M): 旧実装は top-level の `if (isDirectEntrypoint(...)) { startFromEnv()... }` で、
 * 「guard が import 時に発火しない」副作用は同期的に観測できなかった (startFromEnv は async で、
 * unit 実行時点では bind 未完了)。guard 分岐を named 関数の **戻り値** に落とし、negative 分岐
 * (import = 非エントリポイント) が確実に `null` を返す = 起動しないことを await して検証できる。
 * `if(true)` 等で guard を壊すと negative 引数でも startFromEnv が走り、null でない/throw で落ちる。
 *
 * 戻り値: 起動した場合は started server (shutdown 配線済)、エントリポイントでなければ null。
 */
export async function maybeStartFromCli(
  metaUrl: string,
  argv1: string | undefined = process.argv[1],
): Promise<Awaited<ReturnType<typeof startFromEnv>> | null> {
  if (!isDirectEntrypoint(metaUrl, argv1)) return null;
  const server = await startFromEnv();
  // secret は出さない (token / DATABASE_URL を出力しない)。実際に bind した host:port を出す。
  console.log(`[backend] ingestion server ready on http://${server.host}:${server.port}`);
  const shutdown = (signal: string): void => {
    console.log(`[backend] received ${signal}, shutting down`);
    void server.close().then(
      () => process.exit(0),
      (err: unknown) => {
        console.error("[backend] shutdown error:", (err as Error).message);
        process.exit(1);
      },
    );
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  return server;
}

// main-guard: import.meta は ESM トップレベルでのみ有効。直接実行時のみ maybeStartFromCli が起動する
//   (vitest は src/**/*.ts を個別 import するが argv[1] は runner なので発火せず null = listen しない)。
//   起動失敗 (INGEST_TOKEN 不在 / listen 失敗 / DB 接続不能) は非0 exit で可視化する。
void maybeStartFromCli(import.meta.url).catch((err: unknown) => {
  console.error("[backend] failed to start:", (err as Error).message);
  process.exit(1);
});
