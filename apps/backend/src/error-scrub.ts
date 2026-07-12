/**
 * グローバル error scrub (SEC・500 本文の内部詳細漏洩防止・監査 SEC-1 同クラス)。
 *
 * audit route は自前 try/catch で静的 500 化済みだが、replay/wall/approvals 等の他の
 * /realtime route と ingest 経路には try/catch が無い。handler 内で未処理例外
 * (例: 生 pg エラー — message + code + stack) が起きると Fastify **既定** error handler が
 * その詳細を認証済みクライアントへ echo し、DB 内部情報 (テーブル名/SQLSTATE/接続先) を
 * 開示しうる。setErrorHandler で 5xx 本文を静的化し、route 側の既存 try/catch と二重防御する。
 *
 * 契約:
 *  - statusCode 400–499 の client エラー (Fastify の malformed-JSON / 415 / 413 等) は
 *    **既定の安全な扱いへ委譲**する (reply.send(err) が Fastify 既定 handler を呼ぶ)。
 *    これらの message は汎用 (secret 非依存) ゆえ挙動変更を最小化し、既存 4xx 応答の
 *    本文・コードを変えない。
 *  - それ以外 (statusCode 無し or >=500) は req.log.error で内部ログのみに記録し、本文は
 *    静的 `{ error: "internal error" }` の 500。err.message / err.code / stack を本文へ載せない。
 *
 * 単一出所: buildIngestionServer が本 helper を app へ適用し、route 単体テストも同じ helper を
 * mount することで、本番配線とテストが同一の scrub 挙動を共有する (ドリフト防止)。
 *
 * 注意 (TDA-B2): audit 系 route の per-route try/catch は本 handler と挙動同値の静的 500 を
 * 返すが、try/catch を持たない route (/ingest・replay/wall/detail 系) は本 handler に**実依存**
 * する。「route 側が 500 化しているから global は不要」と誤って外すと裸 route の leak が復活する
 * (本番配線は INV-500-SCRUB の buildIngestionServer ケースが red-on-removal で pin)。
 */
import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

/**
 * app へグローバル error handler を設定する。root encapsulation へ張るため、以後登録される
 * 全 route (ingest / realtime / audit) の未処理例外を被覆する。
 */
export function installErrorScrubbing(app: FastifyInstance): void {
  app.setErrorHandler((err: FastifyError, req: FastifyRequest, reply: FastifyReply) => {
    const status = typeof err.statusCode === "number" ? err.statusCode : 500;
    if (status >= 400 && status < 500) {
      // client エラーは Fastify 既定 handler へ委譲する (error handler 内の reply.send(err) は
      // 再帰せず既定シリアライズを使う)。generic な message ゆえ内部詳細漏洩に当たらない。
      return reply.send(err);
    }
    // 5xx / statusCode 無し: 内部詳細 (pg message/code/stack) は **本文へ一切載せない**。
    // 診断はサーバ側ログのみ (req.log.error は原文を構造化ログへ残す — 送信路には出さない)。
    req.log.error({ err }, "unhandled route error");
    return reply.code(500).send({ error: "internal error" });
  });
}
