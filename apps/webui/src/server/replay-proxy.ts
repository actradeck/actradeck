/**
 * Server-side HTTP BFF for Session Replay history.
 *
 * Browsers call same-origin `/realtime/sessions/:id/events`; this proxy attaches REALTIME_TOKEN
 * server-side and forwards to the backend REST route. It never exposes the token to HTML/JS.
 */
import {
  isAllowlistRevokePath,
  normalizeReplayRequestPath,
  resolveReplayHttpConfig,
} from "../realtime/bff.js";

import type { IncomingMessage, ServerResponse } from "node:http";

export type FetchLike = (
  url: string,
  init: {
    headers: Readonly<Record<string, string>>;
    method?: string;
    body?: string;
  },
) => Promise<Response>;

/** POST body の上限 (revoke は小さな JSON {signature, repo_scope?} のみ・肥大ボディを弾く)。 */
const MAX_POST_BODY_BYTES = 4096;

/** IncomingMessage から body を上限付きで読む (上限超過は reject)。 */
async function readBody(req: IncomingMessage): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on("data", (c: Buffer) => {
      total += c.length;
      if (total > MAX_POST_BODY_BYTES) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/** ヘッダ値を単一文字列で取り出す (配列は先頭・小文字化はしない)。 */
function headerVal(req: IncomingMessage, name: string): string | undefined {
  const h = req.headers[name];
  return Array.isArray(h) ? h[0] : h;
}

/**
 * PAL-v2 CSRF 緩和 (SEC-1): mutating POST (revoke) を same-origin のみ許す **二段チェック**。
 * 1. Sec-Fetch-Site (現代ブラウザの Fetch Metadata): cross-site/same-site は拒否。同一オリジン fetch は
 *    "same-origin"、ナビゲーションは "none"、非ブラウザ (curl 等) はヘッダ無し。
 * 2. Origin が在れば Host と一致必須 (Fetch Metadata 非対応ブラウザの二段目)。壊れた Origin は拒否。
 * 非ブラウザ (Sec-Fetch-Site も Origin も無い・curl 等の運用経路) は通す。これが唯一の残余で、
 * revoke が除去のみ + 既定 loopback bind ゆえ accepted-risk (ADR 019ee164/SEC-1: LAN bind 時 revisit)。
 */
function isSameOriginPost(req: IncomingMessage): boolean {
  const sfs = headerVal(req, "sec-fetch-site");
  if (sfs !== undefined && sfs !== "same-origin" && sfs !== "none") return false;
  const origin = headerVal(req, "origin");
  if (origin !== undefined && origin !== "null") {
    const host = headerVal(req, "host");
    let originHost: string;
    try {
      originHost = new URL(origin).host;
    } catch {
      return false; // 壊れた Origin ヘッダは拒否 (安全側)。
    }
    if (host === undefined || originHost !== host) return false;
  }
  return true;
}

export function shouldProxyReplayRequest(url: string | undefined): boolean {
  if (!url) return false;
  try {
    normalizeReplayRequestPath(url);
    return true;
  } catch {
    return false;
  }
}

export interface ReplayProxyOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly fetchImpl?: FetchLike;
}

export async function proxyReplayHistory(
  req: IncomingMessage,
  res: ServerResponse,
  opts: ReplayProxyOptions = {},
): Promise<void> {
  const method = req.method ?? "GET";
  if (method !== "GET" && method !== "POST") {
    res.writeHead(405, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "method not allowed" }));
    return;
  }
  if (!shouldProxyReplayRequest(req.url)) {
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
    return;
  }

  // PAL-v2: method↔path の整合を厳格化する。revoke のみ POST 可・他の allow-list path は GET-only。
  const isRevoke = isAllowlistRevokePath(req.url ?? "");
  if (method === "POST" && !isRevoke) {
    res.writeHead(405, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "method not allowed" }));
    return;
  }
  if (method === "GET" && isRevoke) {
    res.writeHead(405, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "method not allowed (revoke is POST)" }));
    return;
  }
  // CSRF 緩和: mutating POST は same-origin のみ (cross-site ブラウザ POST を拒否)。
  if (method === "POST" && !isSameOriginPost(req)) {
    res.writeHead(403, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "cross-site request rejected" }));
    return;
  }

  try {
    const requestPath = normalizeReplayRequestPath(req.url ?? "");
    const cfg = resolveReplayHttpConfig(opts.env ?? process.env, requestPath);
    const init: { headers: Record<string, string>; method?: string; body?: string } = {
      headers: { ...cfg.headers },
    };
    if (method === "POST") {
      const body = await readBody(req);
      init.method = "POST";
      init.body = body;
      init.headers["content-type"] = "application/json";
    }
    const upstream = await (opts.fetchImpl ?? fetch)(cfg.url, init);
    const contentType = upstream.headers.get("content-type") ?? "application/json";
    res.writeHead(upstream.status, { "content-type": contentType });
    res.end(await upstream.text());
  } catch (err) {
    res.writeHead(502, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: (err as Error).name || "replay proxy error" }));
  }
}
