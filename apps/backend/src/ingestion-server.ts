/**
 * Ingestion API server (Phase 3 backend core).
 *
 * sidecar の ws-client が送る **redaction 済 NormalizedEvent** を受信し、冪等 append +
 * projection + liveness を回す。経路は 2 つ:
 *  - WS  /ingest/ws : 双方向ストリーム (sidecar からの push)。upgrade 前に token 認証。
 *  - HTTP POST /ingest : fallback (1 イベント / 配列バッチ)。
 *
 * セキュリティ / 堅牢性 (WebSearch 済 + security.md):
 *  - @fastify/websocket は **routes 前に register** する (plugin 初期化順序)。
 *  - **upgrade 前認証**: onRequest フックで Authorization: Bearer を timingSafeEqual 検証し、
 *    不正は 401 で upgrade させない (無認証 peer のイベント注入を遮断)。SEC-1: token は
 *    Bearer ヘッダのみ受理 (?token= はログ漏れの温床のため不可)。
 *  - **payload サイズ上限**: bodyLimit (HTTP) と ws maxPayload (WS) を設定。
 *  - **自前 try-catch**: WS message handler 内は plugin の errorHandler に頼らず try-catch する
 *    (errorHandler は message 処理に効かない)。
 *  - **parseEvent 検証必須**: 受信を信頼し切らず T1 schema で検証し、不正は ack エラー
 *    (接続維持) で拒否する。backend は再 redaction しない (sidecar が choke point)。
 *  - **preClose**: graceful shutdown で接続を閉じる。
 */
import { timingSafeEqual } from "node:crypto";

import fastifyWebsocket from "@fastify/websocket";
import { parseEvent } from "@actradeck/event-model";
import Fastify, {
  type FastifyInstance,
  type FastifyRequest,
  type FastifyServerOptions,
} from "fastify";

import { IngestStore } from "./ingest-store.js";
import { RealtimeHub } from "./realtime-hub.js";
import { RealtimeStore } from "./realtime-store.js";
import { registerRealtimeRoute } from "./realtime-server.js";
import { ReplayStore } from "./replay-store.js";
import { AuditStore } from "./audit-store.js";
import {
  isAllowlistResponseFrame,
  isDiffResponseFrame,
  isHelloFrame,
  isPolicyResponseFrame,
  SidecarRegistry,
  type SidecarLink,
} from "./sidecar-registry.js";
import type { SynthesizeOptions } from "./liveness.js";
import type { Pool } from "pg";

/** WS で受信した 1 イベントへの ack。冪等・順序・不正を呼び元 (sidecar) へ返す。 */
interface IngestAck {
  readonly type: "ack";
  readonly event_id?: string;
  readonly ok: boolean;
  readonly inserted?: boolean;
  readonly duplicate?: boolean;
  readonly monotonic?: boolean;
  readonly state?: string | undefined;
  readonly invalid_transition?: boolean;
  readonly error?: string;
}

export interface IngestionServerOptions {
  readonly pool: Pool;
  /** 接続認証トークン (env から注入)。未設定なら起動を拒否 (無認証受信を作らない)。 */
  readonly ingestToken: string;
  /**
   * UI 向け realtime チャネル (/realtime/ws) の認証トークン。
   * **ingestToken とは別経路・別認証** (sidecar token を UI に配らない)。設定時のみ
   * /realtime/ws を mount する。未設定なら realtime 経路は生やさない (混線防止)。
   */
  readonly realtimeToken?: string;
  /** WS / HTTP の最大ペイロード (bytes)。既定 1 MiB。 */
  readonly maxPayloadBytes?: number;
  /** liveness 判定オプション (テスト用)。 */
  readonly livenessOptions?: SynthesizeOptions;
  /** presence grace 期間 (ms)。既定 5000(ADR 019ea2bf)。テスト/統合で短縮注入用。 */
  readonly presenceGraceMs?: number;
  /** Fastify logger を有効化。 */
  readonly logger?: boolean;
}

const DEFAULT_MAX_PAYLOAD = 1024 * 1024; // 1 MiB

/**
 * 定数時間トークン比較 (タイミング攻撃耐性)。長さ不一致は即 false。
 */
function tokenEquals(expected: string, provided: string | undefined): boolean {
  if (!provided) return false;
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(provided, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * リクエストから bearer token を抽出する。
 *
 * SEC-1: **`?token=` クエリは受理しない**。query は Fastify req.url ログ (logger:true) に
 * 平文出力されうるため、ActraDeck の stdout collector がそれを自己取り込みして
 * INV-REDACTION の精神 (secret を保存・送信路に残さない) を破る。token は必ず
 * Authorization: Bearer ヘッダ (WS は upgrade リクエストのヘッダ) で受ける。
 */
function extractToken(req: FastifyRequest): string | undefined {
  const auth = req.headers["authorization"];
  if (typeof auth === "string" && auth.startsWith("Bearer ")) {
    return auth.slice("Bearer ".length).trim();
  }
  return undefined;
}

/**
 * Fastify logger オプションを構築する。
 *
 * SEC-1: token / credential を **構造化ログへ一切残さない**ための堅牢化。
 *  - serializers.req: req.url を `split('?')[0]` で path のみへ縮約 (query=secret 漏れ防止)。
 *  - redact: authorization / cookie ヘッダ値を `[Redacted]` 化 (誤付与時の保険)。
 *
 * false 指定時はそのまま logger 無効 (テストの既定)。
 */
function buildLoggerOption(
  logger: IngestionServerOptions["logger"],
): NonNullable<FastifyServerOptions["logger"]> {
  if (!logger) return false; // false / undefined → logger 無効。
  // secret 防御 (serializer + redact)。呼び元が object (例: stream 注入) を渡した場合は
  // その設定を保ちつつ防御をマージする。boolean(true) の場合は防御のみで構成する。
  const defense = {
    redact: {
      paths: ["req.headers.authorization", "req.headers.cookie", "res.headers['set-cookie']"],
      censor: "[Redacted]",
    },
    serializers: {
      req(req: { method?: string; url?: string }) {
        // query string を捨てて path のみ残す (?token= 等の secret をログに出さない)。
        const rawUrl = typeof req.url === "string" ? req.url : "";
        return { method: req.method, url: rawUrl.split("?")[0] };
      },
    },
  };
  if (typeof logger === "object") {
    // 呼び元設定を土台に、防御 (redact/serializers) を上書きで強制する。
    return { ...(logger as Record<string, unknown>), ...defense } as NonNullable<
      FastifyServerOptions["logger"]
    >;
  }
  return defense as NonNullable<FastifyServerOptions["logger"]>;
}

/**
 * Ingestion server を構築する (listen はしない)。テストは inject / 実 listen で使う。
 */
export async function buildIngestionServer(opts: IngestionServerOptions): Promise<FastifyInstance> {
  if (!opts.ingestToken || opts.ingestToken.length === 0) {
    throw new Error("ingestToken is required (no unauthenticated ingestion)");
  }
  const maxPayload = opts.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD;
  const store = new IngestStore({
    pool: opts.pool,
    ...(opts.livenessOptions ? { livenessOptions: opts.livenessOptions } : {}),
  });

  // Realtime (Phase 3 ③): sidecar 接続レジストリ + UI hub + 読み出し層。
  //   - SidecarRegistry: session→sidecar WS の対応付け (UI→Sidecar 中継の戻り経路)。
  //   - RealtimeHub: UI 購読者へ list/detail を push。
  //   - RealtimeStore: 永続 projection から redaction 済 DTO を組む。
  // realtimeToken 未設定でも sidecar レジストリは ingest 経路で session 所有を学習しておく
  // (将来 /realtime/ws を mount した時に即 relay できる)。
  const sidecarRegistry = new SidecarRegistry(
    opts.presenceGraceMs !== undefined ? { graceMs: opts.presenceGraceMs } : {},
  );
  const realtimeHub = new RealtimeHub();
  const realtimeStore = new RealtimeStore(opts.pool);
  const replayStore = new ReplayStore(opts.pool);
  const auditStore = new AuditStore(opts.pool);

  const app = Fastify({
    // SEC-1: logger 有効時、Fastify 既定の req serializer は req.url を **query 込み**で
    //   出力する。たとえ token を query で受けなくても、誤って付与された ?token= や
    //   Authorization ヘッダが stdout ログへ漏れると ActraDeck の stdout collector が
    //   自己取り込みしてしまう。そこで:
    //     - req.url から query string を除去 (path のみログ)。
    //     - authorization / cookie ヘッダを redact (値を出さない)。
    logger: buildLoggerOption(opts.logger ?? false),
    bodyLimit: maxPayload, // HTTP POST のサイズ上限。
  });

  // @fastify/websocket は routes 前に register する (初期化順序の制約)。
  await app.register(fastifyWebsocket, {
    options: { maxPayload }, // ws フレームのサイズ上限。
    // preClose: graceful shutdown で全 WS を閉じる。
    preClose: function preClose() {
      // TDA-3: pending grace タイマを clear し event loop の居座りを防ぐ(app.close() が即返る)。
      sidecarRegistry.dispose();
      for (const client of app.websocketServer.clients) {
        client.close(1001, "server shutting down");
      }
    },
  });

  /**
   * upgrade 前認証: WS / HTTP 双方の /ingest* に onRequest フックを掛ける。
   * token 不一致/不在は 401 で即終了し、WS upgrade に到達させない。
   */
  app.addHook("onRequest", async (req, reply) => {
    if (!req.url.startsWith("/ingest")) return; // health 等は対象外。
    const token = extractToken(req);
    if (!tokenEquals(opts.ingestToken, token)) {
      // WS upgrade 前にここで弾く (handler/upgrade まで進ませない)。
      await reply.code(401).send({ error: "unauthorized" });
    }
  });

  /**
   * ingest 成功 (新規 insert) 後に realtime push を行う。
   * delta.list を全 UI へ broadcast、当該 session の購読者へ delta.detail を送る。
   * 重複 (no-op) では新情報ゼロのため push しない。push 失敗は ingest を妨げない
   * (永続は完了済み。配信はベストエフォート)。
   */
  // presence 述語: 一覧/詳細 DTO の connected(接続在席)を registry から被せる(ADR 019ea2bf)。
  // store は registry を知らない純 DB のため、配信側がこの述語を注入する。
  const isLive = (sid: string): boolean => sidecarRegistry.isLive(sid);

  const pushAfterIngest = async (sessionId: string): Promise<void> => {
    try {
      const item = await realtimeStore.listItem(sessionId, isLive);
      if (item) realtimeHub.broadcastListDelta(item);
      // detail は購読者がいる時だけ組む (無駄な DB 往復回避)。
      if (realtimeHub.subscriberCount(sessionId) > 0) {
        const detail = await realtimeStore.detail(sessionId, isLive);
        if (detail) realtimeHub.pushDetailDelta(sessionId, detail);
      }
    } catch {
      // 配信整形失敗は無視 (ingest は成功している)。
    }
  };

  /**
   * presence(接続在席)変化を UI へ反映する(ADR 019ea2bf の delta 発火源)。
   * ingest と直交な **第2の delta.list トリガ**: 接続 open/close(grace 満了)で connected が
   * 変わった当該 session のみ、最新 DTO(connected 反映済)を broadcast する。新 frame 型は
   * 増やさず既存 delta.list を再利用(front は upsert で冪等)。session_state 行が未だ無い
   * (イベント未着の新規接続)なら listItem は undefined=配信なし(最初のイベントで現れる)。
   */
  const pushPresenceDelta = async (sessionId: string): Promise<void> => {
    try {
      const item = await realtimeStore.listItem(sessionId, isLive);
      if (item) realtimeHub.broadcastListDelta(item);
      if (realtimeHub.subscriberCount(sessionId) > 0) {
        const detail = await realtimeStore.detail(sessionId, isLive);
        if (detail) realtimeHub.pushDetailDelta(sessionId, detail);
      }
    } catch {
      // 配信整形失敗は無視(presence は registry が権威・次の snapshot で整合)。
    }
  };
  // registry: presence membership 変化 → 当該 session のみ delta.list。
  sidecarRegistry.onPresenceChange((sid) => {
    void pushPresenceDelta(sid);
  });

  // --- WS ingestion (sidecar→backend) ------------------------------------
  app.get("/ingest/ws", { websocket: true }, (socket) => {
    // sidecar 接続をレジストリへ登録 (UI→Sidecar 中継の戻り経路として learn)。
    const link: SidecarLink = {
      send: (data: string) => socket.send(data),
      get open() {
        return socket.readyState === socket.OPEN;
      },
    };
    sidecarRegistry.add(link);
    socket.on("message", (raw: Buffer) => {
      // 自前 try-catch: plugin errorHandler は message 処理に効かない。
      void handleWsMessage(socket, raw, store, sidecarRegistry, link, pushAfterIngest);
    });
    socket.on("close", () => sidecarRegistry.remove(link));
  });

  // --- HTTP POST fallback (sidecar→backend) ------------------------------
  app.post("/ingest", async (req, reply) => {
    const body = req.body;
    const items = Array.isArray(body) ? body : [body];
    const acks: IngestAck[] = [];
    for (const item of items) {
      const ack = await ingestOne(store, item);
      acks.push(ack);
      if (ack.ok && ack.inserted && ack.event_id) {
        const sid = sessionIdOf(item);
        if (sid) await pushAfterIngest(sid);
      }
    }
    const allOk = acks.every((a) => a.ok);
    return reply.code(allOk ? 200 : 422).send({ results: acks });
  });

  // --- UI realtime (別経路・別認証) --------------------------------------
  if (opts.realtimeToken && opts.realtimeToken.length > 0) {
    registerRealtimeRoute(app, {
      realtimeToken: opts.realtimeToken,
      hub: realtimeHub,
      store: realtimeStore,
      replayStore,
      auditStore,
      sidecarRegistry,
    });
  }

  // --- health ------------------------------------------------------------
  app.get("/health", async () => ({ status: "ok" }));

  return app;
}

/** 取り込み入力から session_id を安全に取り出す (push 対象判定用)。 */
function sessionIdOf(input: unknown): string | undefined {
  if (input && typeof input === "object" && "session_id" in input) {
    const sid = (input as { session_id?: unknown }).session_id;
    if (typeof sid === "string" && sid.length > 0) return sid;
  }
  return undefined;
}

/**
 * WS の 1 メッセージを処理する。parse 失敗・検証失敗・取り込み失敗を ack で返し、
 * **接続は維持する** (1 件の不正で stream を落とさない)。
 */
async function handleWsMessage(
  socket: { send: (data: string) => void },
  raw: Buffer,
  store: IngestStore,
  registry: SidecarRegistry,
  link: SidecarLink,
  pushAfterIngest: (sessionId: string) => Promise<void>,
): Promise<void> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString("utf8"));
  } catch {
    safeSend(socket, { type: "ack", ok: false, error: "invalid json" });
    return;
  }
  // sidecar handshake: control_token + 所有 session を学習 (UI→Sidecar 中継の認可基盤)。
  if (isHelloFrame(parsed)) {
    registry.handleHello(link, parsed);
    safeSend(socket, { type: "ack", ok: true });
    return;
  }
  // 段階2 (ADR 019ea4ba D2-B): sidecar からの diff 本文応答を pending 要求へ解決する。
  //   本文は sidecar で redaction 済み (backend は再 redaction も永続もしない)。ack 不要
  //   (要求元の HTTP endpoint が Promise 解決で応答する)。event ingest 経路には載せない。
  if (isDiffResponseFrame(parsed)) {
    registry.resolveDiff(parsed);
    return;
  }
  // PAL-v2 (ADR 019ee147): sidecar からの allowlist.response を pending 要求へ解決する。
  //   entries は NO-RAW (sha256 署名/scope/basename のみ・backend は再構築しない)。ack 不要
  //   (要求元の HTTP endpoint が Promise 解決で応答する)。event ingest 経路には載せない。
  if (isAllowlistResponseFrame(parsed)) {
    registry.resolveAllowlist(parsed);
    return;
  }
  // ADR 019f0c3e Phase 2: sidecar からの policy.response を pending 要求へ解決する。
  //   categories は closed enum (NO-RAW)・backend は closed enum へ投影する。ack 不要
  //   (要求元の HTTP endpoint が Promise 解決で応答する)。event ingest 経路には載せない。
  if (isPolicyResponseFrame(parsed)) {
    registry.resolvePolicy(parsed);
    return;
  }
  const ack = await ingestOne(store, parsed);
  safeSend(socket, ack);
  if (ack.ok && ack.event_id) {
    const sid = sessionIdOf(parsed);
    if (sid) {
      registry.observeSession(link, sid); // 所有を学習 (controlToken 無ければ relay は不可)。
      if (ack.inserted) await pushAfterIngest(sid);
    }
  }
}

/**
 * 1 イベントを T1 検証 → 取り込み → ack 化する共通経路 (WS / HTTP 共用)。
 * parseEvent で不正 payload を拒否する (受信を信頼し切らない)。
 */
async function ingestOne(store: IngestStore, input: unknown): Promise<IngestAck> {
  let ev;
  try {
    ev = parseEvent(input); // T1 検証 (不正 payload / 型違反を拒否)。
  } catch (err) {
    const eid =
      input && typeof input === "object" && "event_id" in input
        ? String((input as { event_id?: unknown }).event_id)
        : undefined;
    return {
      type: "ack",
      ok: false,
      ...(eid ? { event_id: eid } : {}),
      error: `invalid event: ${err instanceof Error ? err.message : "parse error"}`,
    };
  }

  try {
    const res = await store.ingest(ev);
    return {
      type: "ack",
      event_id: ev.event_id,
      ok: true,
      inserted: res.inserted,
      duplicate: !res.inserted,
      monotonic: res.monotonic,
      state: res.projection.state,
      invalid_transition: res.invalidTransition,
    };
  } catch (err) {
    return {
      type: "ack",
      event_id: ev.event_id,
      ok: false,
      error: `ingest failed: ${err instanceof Error ? err.message : "db error"}`,
    };
  }
}

function safeSend(socket: { send: (data: string) => void }, ack: IngestAck): void {
  try {
    socket.send(JSON.stringify(ack));
  } catch {
    // 送信失敗 (接続断) は無視。store には既に永続化済み (冪等再送で回復)。
  }
}
