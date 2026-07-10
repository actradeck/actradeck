/**
 * Server-side HTTP BFF for Session Replay history.
 *
 * Browsers call same-origin `/realtime/sessions/:id/events`; this proxy attaches REALTIME_TOKEN
 * server-side and forwards to the backend REST route. It never exposes the token to HTML/JS.
 */
import {
  isAllowlistRevokePath,
  isAuditPacketVerifyPath,
  isAuditVerifyPath,
  isCodexSpawnPath,
  isDemoLaunchPath,
  isPolicyResolvePath,
  isPolicySetPath,
  isPolicyUnsetPath,
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

/** POST body の上限 (revoke/policy は小さな JSON のみ・肥大ボディを弾く)。 */
const MAX_POST_BODY_BYTES = 4096;
/**
 * audit verify の body 上限 (AUDIT-VERIFY-SIZE)。旧 512KiB は多忙/長時間セッションの report(最も監査
 * 価値が高い・最大 10000 events で ~5MB(JSON)/base64 ~1.33x)を弾いていた。値は **経験的 calibration**
 * (provable worst-case でない・TDA-2)で measured max + headroom = 16 MiB。病的に巨大なフィールドを持つ
 * report が超過した場合は readBody が reject し verify へ届かない(deny-safe・leak でない)。backend
 * verify route の AUDIT_VERIFY_BODY_LIMIT と手動整合(同値・TDA-1)。
 */
const MAX_VERIFY_BODY_BYTES = 16 * 1024 * 1024;

/** IncomingMessage から body を上限付きで読む (上限超過は reject)。 */
async function readBody(
  req: IncomingMessage,
  maxBytes: number = MAX_POST_BODY_BYTES,
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on("data", (c: Buffer) => {
      total += c.length;
      if (total > maxBytes) {
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
 * PAL-v2 + ADR 019f0c3e Phase 2 CSRF 緩和: mutating POST (allowlist revoke / policy set) を
 * same-origin のみ許す **二段チェック**。
 * 1. Sec-Fetch-Site (現代ブラウザの Fetch Metadata): cross-site/same-site は拒否。同一オリジン fetch は
 *    "same-origin"、ナビゲーションは "none"、非ブラウザ (curl 等) はヘッダ無し。
 * 2. Origin が在れば Host と一致必須 (Fetch Metadata 非対応ブラウザの二段目)。壊れた Origin は拒否。
 * 非ブラウザ (Sec-Fetch-Site も Origin も無い・curl 等の運用経路) は通す。これが唯一の残余。
 *
 * accepted-risk の scope (SEC-3/QA-1・decision 019f0d07): cross-site ブラウザ POST は上記で構造遮断され、
 * 残余は **no-header の非ブラウザ local client** のみ。revoke は除去のみで安全方向だが、**policy set は
 * gate を弱める方向** (enabled=false / category 削減) も可能で revoke の「除去のみ」論拠は転用できない。
 * それでも残余は loopback bind + single-operator 信頼境界内に閉じ (remote exploit 不能・bypass policy の
 * memory-authoritative 床が既に前提とする境界と同一)、policy set 自体は backend で REALTIME_TOKEN +
 * sidecar の controlToken により別途認証される。LAN bind / multi-operator へ広げる際は revisit 必須。
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

  // PAL-v2 + ADR 019f0c3e Phase 2 + 019f0eca: method↔path の整合を厳格化する。POST 可は mutating
  //   (allowlist revoke / policy set / policy unset) と path-carrying read (policy resolve) のみ。
  //   後者は policy を変えないが path を body で運び (query へ載せない=SEC-1)、cross-site の任意パス探索を
  //   防ぐため set/unset と同じ POST-only + CSRF ゲートへ服させる。他の read path は GET-only。
  const isRevoke = isAllowlistRevokePath(req.url ?? "");
  const isPolicyMutating = isPolicySetPath(req.url ?? "") || isPolicyUnsetPath(req.url ?? "");
  const isPolicyResolve = isPolicyResolvePath(req.url ?? "");
  // ADR 019f22a7 P1: セーフティデモ起動も mutating-class (POST-only + CSRF) 扱い。
  const isDemoLaunch = isDemoLaunchPath(req.url ?? "");
  // ADR 019f4206 A段: Codex Managed spawn も実行を起動する mutating-class (POST-only + same-origin CSRF)。
  const isCodexSpawn = isCodexSpawnPath(req.url ?? "");
  // ADR 6点強化 #1: tamper-evidence の検証も POST-only + CSRF。純粋検証だが body で manifest を運ぶ。
  const isAuditVerify = isAuditVerifyPath(req.url ?? "");
  // ADR 6点強化 #2: レビュー・パケット検証も同扱い (POST-only + CSRF + 大 body)。
  const isAuditPacketVerify = isAuditPacketVerifyPath(req.url ?? "");
  const isMutating =
    isRevoke ||
    isPolicyMutating ||
    isPolicyResolve ||
    isDemoLaunch ||
    isCodexSpawn ||
    isAuditVerify ||
    isAuditPacketVerify;
  if (method === "POST" && !isMutating) {
    res.writeHead(405, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "method not allowed" }));
    return;
  }
  if (method === "GET" && isMutating) {
    res.writeHead(405, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "method not allowed (mutating path is POST)" }));
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
      const body = await readBody(
        req,
        isAuditVerify || isAuditPacketVerify ? MAX_VERIFY_BODY_BYTES : MAX_POST_BODY_BYTES,
      );
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
