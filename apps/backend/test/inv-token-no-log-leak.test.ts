/**
 * SEC-1 回帰テスト: INGEST_TOKEN を構造化ログへ漏らさない (INV-REDACTION 精神)。
 *
 * 背景: ActraDeck の stdout collector は自プロセスの stdout も観測しうる。Fastify
 * logger:true の既定 req serializer は req.url を **query 込み**で出力するため、
 * `?token=<secret>` や Authorization ヘッダがログに乗ると secret が永続/送信路へ漏れる。
 *
 * 防御 (ingestion-server.ts):
 *  1. extractToken は `?token=` を受理しない (Bearer ヘッダのみ)。
 *  2. logger の req serializer が req.url を `split('?')[0]` で path のみへ縮約。
 *  3. redact で authorization / cookie ヘッダ値を伏せる。
 *
 * このテストは logger を **実際に有効化**し、pino の出力 stream を捕捉して、
 * いかなるログ行にも token 文字列が現れないことを assert する (出れば CI で赤)。
 * 実 PG 接続は不要 (認証は upgrade/onRequest 段でログを生む)。DB 未到達でも実行する
 * ため Pool は使わず、HTTP inject で認証経路を踏む (401/200 双方をログ化)。
 *
 * memory `redaction-redos-and-real-test-gates`: 延期でなく通常 it() で赤→緑をゲートする。
 */
import { Writable } from "node:stream";

import { describe, expect, it } from "vitest";

import { Pool } from "pg";

import { buildIngestionServer } from "../src/ingestion-server.js";
import { makeEvent } from "./helpers.js";

// 実 secret に酷似した、判別容易なトークン文字列 (ログに出れば一発で検出できる)。
const TOKEN = "sk-ingest-SECRET-TOKEN-do-not-log-9f8e7d6c5b4a";

/** pino 出力を 1 行ずつ収集する書き込み可能 stream。 */
function makeCaptureStream(): { stream: Writable; lines: () => string[] } {
  const buf: string[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      buf.push(chunk.toString("utf8"));
      cb();
    },
  });
  return { stream, lines: () => buf.join("").split("\n").filter(Boolean) };
}

describe("SEC-1: INGEST_TOKEN must never appear in structured logs", () => {
  it("logger:true ⇒ authenticated and rejected requests log no token string (req.url stripped, auth redacted)", async () => {
    const cap = makeCaptureStream();
    // Pool は使わないが型のため必要。接続は張らない (認証/ログは onRequest 段で完結)。
    const pool = new Pool({ connectionString: "postgres://unused", max: 1 });

    // logger に capture stream を注入して実際に出力を発生させる。
    const app = await buildIngestionServer({
      pool,
      ingestToken: TOKEN,
      logger: { stream: cap.stream } as unknown as boolean,
    });

    try {
      // (1) 正規の Bearer 認証付きリクエスト (onRequest 通過 → ルートで pool.connect は
      //     unused 接続で失敗するが、それ以前に request/response ログは出る)。
      await app.inject({
        method: "POST",
        url: "/ingest",
        headers: { authorization: `Bearer ${TOKEN}` },
        payload: makeEvent({ session_id: "sess_seclog_ok", event_type: "heartbeat" }),
      });

      // (2) 攻撃的ケース: 誤って ?token=<secret> を URL に付けても、serializer が query を
      //     落とすのでログに出てはならない。認証は Bearer のみなので 401 になる。
      await app.inject({
        method: "POST",
        url: `/ingest?token=${TOKEN}&foo=bar`,
        payload: { garbage: true },
      });

      // (3) Authorization ヘッダ単体も redact 対象。401 でも token を出さない。
      await app.inject({
        method: "POST",
        url: "/ingest",
        headers: { authorization: `Bearer ${TOKEN}` },
        payload: { garbage: true },
      });
    } finally {
      await app.close();
      await pool.end().catch(() => {});
    }

    const lines = cap.lines();
    // ログが実際に出ていること (空ログで誤って緑にしない)。
    expect(lines.length).toBeGreaterThan(0);

    // 全ログ行に token 文字列が出ないこと。
    const leaking = lines.filter((l) => l.includes(TOKEN));
    expect(
      leaking,
      `token leaked into ${leaking.length} log line(s): ${leaking.slice(0, 2).join(" | ")}`,
    ).toEqual([]);

    // query を含む URL がそのままログに出ていないこと (path のみへ縮約済み)。
    const urlWithQuery = lines.filter((l) => l.includes("/ingest?"));
    expect(urlWithQuery).toEqual([]);
  });
});
