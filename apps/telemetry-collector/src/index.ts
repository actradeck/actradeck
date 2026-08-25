/**
 * Cloudflare Workers + D1 aggregate-only telemetry collector.
 *
 * Privacy boundary:
 * - accepts only the strict @actradeck/telemetry-contract shape;
 * - HMACs the random installation UUID before persistence;
 * - never persists IP, User-Agent, prompts, commands, paths, repos, or product session/event IDs;
 * - admin responses contain aggregates only and never return installation hashes.
 */
import {
  TELEMETRY_EVENT_NAMES,
  TelemetryBatch,
  isUtcDay,
  nonNegativeCount,
  telemetryRetentionCutoff,
  utcDay,
  type TelemetryBatch as TelemetryBatchValue,
} from "@actradeck/telemetry-contract";

const MAX_BODY_BYTES = 128 * 1024;
const MAX_REPORT_DAYS = 365;
/**
 * SEC-3 (2026-08-13 監査): 受理する occurred_on の窓。sender の lookback は 30 日 + enable 日
 * clamp なので、正当な batch は過去 90 日を要求しない。窓外 (太古/未来日) を 400 で拒否し、
 * pre-seed した未来行・任意過去行での retention/cohort 汚染と unbounded D1 成長の主要 vector を
 * 閉じる (無認証 ingest 自体の poisoning-in-principle は docs の開示どおり残余)。
 */
const ACCEPT_PAST_DAYS = 90;
const ACCEPT_FUTURE_DAYS = 1;
// D1 permits 100 bound parameters per statement. Each row has six parameters.
const ROWS_PER_UPSERT = 16;
const FUNNEL_EVENTS = [
  "install_verified",
  "cockpit_started",
  "cockpit_demo_completed",
  "first_agent_observed",
  "first_governed_session",
] as const;

interface RateLimitBinding {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

export interface Env {
  readonly DB: D1Database;
  /** Worker secret. Generate independently and never commit the value. */
  readonly HASH_SECRET: string;
  /** Worker secret. Only the service operator should possess this value. */
  readonly ADMIN_TOKEN: string;
  readonly RATE_LIMITER: RateLimitBinding;
}

interface WorkerOptions {
  readonly now?: () => Date;
}

type Row = Record<string, unknown>;

interface ParsedBody {
  readonly value?: unknown;
  readonly status?: 400 | 413;
}

function daysBetween(from: string, to: string): number {
  return (
    Math.floor(
      (new Date(`${to}T00:00:00.000Z`).getTime() - new Date(`${from}T00:00:00.000Z`).getTime()) /
        86_400_000,
    ) + 1
  );
}

function parseReportRange(url: URL, now: Date): { from: string; to: string } | undefined {
  const to = url.searchParams.get("to") ?? utcDay(now);
  const from =
    url.searchParams.get("from") ?? utcDay(new Date(now.getTime() - (30 - 1) * 86_400_000));
  if (!isUtcDay(from) || !isUtcDay(to) || from > to) return undefined;
  const span = daysBetween(from, to);
  return span >= 1 && span <= MAX_REPORT_DAYS ? { from, to } : undefined;
}

async function digest(value: string): Promise<Uint8Array> {
  const bytes = new TextEncoder().encode(value);
  return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
}

async function constantTimeToken(expected: string, authorization: string | null): Promise<boolean> {
  const prefix = "Bearer ";
  const supplied = authorization?.startsWith(prefix) ? authorization.slice(prefix.length) : "";
  const [left, right] = await Promise.all([digest(expected), digest(supplied)]);
  let difference = expected.length ^ supplied.length;
  for (let index = 0; index < left.length; index += 1) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return difference === 0;
}

async function installationHash(secret: string, installationId: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, encoder.encode(installationId)),
  );
  return Array.from(signature, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function rate(value: number, eligible: number): number | null {
  return eligible > 0 ? Number((value / eligible).toFixed(4)) : null;
}

function json(value: unknown, status = 200, headers?: HeadersInit): Response {
  return Response.json(value, {
    status,
    headers: {
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      ...headers,
    },
  });
}

function methodNotAllowed(allowed: string): Response {
  return json({ error: "method not allowed" }, 405, { allow: allowed });
}

async function readJsonBody(request: Request): Promise<ParsedBody> {
  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) return { status: 413 };

  const reader = request.body?.getReader();
  if (!reader) return { status: 400 };
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    total += chunk.value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel();
      return { status: 413 };
    }
    chunks.push(chunk.value);
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return { value: JSON.parse(new TextDecoder().decode(bytes)) as unknown };
  } catch {
    return { status: 400 };
  }
}

function requireSecret(value: string | undefined, name: string): void {
  if (!value || value.length < 32) throw new Error(`${name} is not configured`);
}

async function persistBatch(env: Env, batch: TelemetryBatchValue): Promise<void> {
  const hash = await installationHash(env.HASH_SECRET, batch.installation_id);
  const statements: D1PreparedStatement[] = [];
  for (let start = 0; start < batch.events.length; start += ROWS_PER_UPSERT) {
    const events = batch.events.slice(start, start + ROWS_PER_UPSERT);
    const values: unknown[] = [];
    const tuples = events.map((event) => {
      values.push(
        hash,
        event.event_name,
        event.occurred_on,
        event.app_version,
        event.platform,
        event.count,
      );
      return "(?, ?, ?, ?, ?, ?)";
    });
    statements.push(
      env.DB.prepare(
        `INSERT INTO telemetry_daily
           (installation_hash, event_name, occurred_on, app_version, platform, count)
         VALUES ${tuples.join(", ")}
         ON CONFLICT (installation_hash, event_name, occurred_on) DO UPDATE SET
           count = MAX(telemetry_daily.count, excluded.count),
           app_version = excluded.app_version,
           platform = excluded.platform,
           last_received_at = CURRENT_TIMESTAMP`,
      ).bind(...values),
    );
  }
  await env.DB.batch(statements);
}

function resultRows(result: D1Result): Row[] {
  return result.results as Row[];
}

async function aggregateReport(
  database: D1Database,
  range: { from: string; to: string },
  now: Date,
): Promise<Record<string, unknown>> {
  const [totalsResult, funnelResult, dailyResult, retentionResult] = await database.batch([
    database
      .prepare(
        `SELECT event_name, COALESCE(SUM(count), 0) AS count
           FROM telemetry_daily
          WHERE occurred_on BETWEEN ? AND ?
          GROUP BY event_name`,
      )
      .bind(range.from, range.to),
    database
      .prepare(
        // TDA-12 (2026-08-13 監査): funnel の対象イベントは FUNNEL_EVENTS を bind する
        // (TS 配列と SQL リテラルの二重管理は追加イベントを silent 0 にする drift 源だった)。
        `SELECT event_name, COUNT(DISTINCT installation_hash) AS installations
           FROM telemetry_daily
          WHERE occurred_on BETWEEN ? AND ?
            AND event_name IN (${FUNNEL_EVENTS.map(() => "?").join(", ")})
          GROUP BY event_name`,
      )
      .bind(range.from, range.to, ...FUNNEL_EVENTS),
    database
      .prepare(
        `SELECT occurred_on AS day,
                COUNT(DISTINCT CASE WHEN event_name = 'active_day' THEN installation_hash END)
                  AS active_installations,
                COALESCE(SUM(CASE WHEN event_name = 'governed_session_started' THEN count ELSE 0 END), 0)
                  AS governed_sessions,
                COALESCE(SUM(CASE WHEN event_name = 'approval_requested' THEN count ELSE 0 END), 0)
                  AS approval_requests,
                COALESCE(SUM(CASE WHEN event_name = 'approval_decided' THEN count ELSE 0 END), 0)
                  AS approval_decisions
           FROM telemetry_daily
          WHERE occurred_on BETWEEN ? AND ?
          GROUP BY occurred_on
          ORDER BY occurred_on`,
      )
      .bind(range.from, range.to),
    database
      .prepare(
        `WITH params AS (
           SELECT ? AS from_day, ? AS to_day
         ), cohorts AS (
           SELECT installation_hash, MIN(occurred_on) AS first_day
             FROM telemetry_daily
            WHERE event_name = 'active_day'
            GROUP BY installation_hash
         )
         SELECT COUNT(*) AS cohort_size,
                SUM(CASE WHEN first_day <= date(params.to_day, '-1 day') THEN 1 ELSE 0 END)
                  AS eligible_d1,
                SUM(CASE WHEN first_day <= date(params.to_day, '-1 day') AND EXISTS (
                  SELECT 1 FROM telemetry_daily d
                   WHERE d.installation_hash = cohorts.installation_hash
                     AND d.event_name = 'active_day'
                     AND d.occurred_on = date(cohorts.first_day, '+1 day')
                ) THEN 1 ELSE 0 END) AS retained_d1,
                SUM(CASE WHEN first_day <= date(params.to_day, '-7 days') THEN 1 ELSE 0 END)
                  AS eligible_d7,
                SUM(CASE WHEN first_day <= date(params.to_day, '-7 days') AND EXISTS (
                  SELECT 1 FROM telemetry_daily d
                   WHERE d.installation_hash = cohorts.installation_hash
                     AND d.event_name = 'active_day'
                     AND d.occurred_on = date(cohorts.first_day, '+7 days')
                ) THEN 1 ELSE 0 END) AS retained_d7,
                SUM(CASE WHEN first_day <= date(params.to_day, '-30 days') THEN 1 ELSE 0 END)
                  AS eligible_d30,
                SUM(CASE WHEN first_day <= date(params.to_day, '-30 days') AND EXISTS (
                  SELECT 1 FROM telemetry_daily d
                   WHERE d.installation_hash = cohorts.installation_hash
                     AND d.event_name = 'active_day'
                     AND d.occurred_on = date(cohorts.first_day, '+30 days')
                ) THEN 1 ELSE 0 END) AS retained_d30
           FROM cohorts CROSS JOIN params
          WHERE first_day BETWEEN params.from_day AND params.to_day`,
      )
      .bind(range.from, range.to),
  ]);
  if (!totalsResult || !funnelResult || !dailyResult || !retentionResult) {
    throw new Error("D1 returned an incomplete aggregate result");
  }

  const totals = Object.fromEntries(
    TELEMETRY_EVENT_NAMES.map((name) => [name, 0] as const),
  ) as Record<string, number>;
  for (const row of resultRows(totalsResult)) {
    if (typeof row.event_name === "string" && row.event_name in totals) {
      totals[row.event_name] = nonNegativeCount(row.count);
    }
  }
  const funnel = Object.fromEntries(FUNNEL_EVENTS.map((name) => [name, 0] as const)) as Record<
    string,
    number
  >;
  for (const row of resultRows(funnelResult)) {
    if (typeof row.event_name === "string" && row.event_name in funnel) {
      funnel[row.event_name] = nonNegativeCount(row.installations);
    }
  }
  const retentionRow = resultRows(retentionResult)[0] ?? {};
  const d1 = {
    eligible: nonNegativeCount(retentionRow.eligible_d1),
    retained: nonNegativeCount(retentionRow.retained_d1),
  };
  const d7 = {
    eligible: nonNegativeCount(retentionRow.eligible_d7),
    retained: nonNegativeCount(retentionRow.retained_d7),
  };
  const d30 = {
    eligible: nonNegativeCount(retentionRow.eligible_d30),
    retained: nonNegativeCount(retentionRow.retained_d30),
  };

  return {
    schema_version: 1,
    generated_at: now.toISOString(),
    timezone: "UTC",
    from: range.from,
    to: range.to,
    funnel,
    totals,
    daily: resultRows(dailyResult).map((row) => ({
      day: typeof row.day === "string" ? row.day.slice(0, 10) : "",
      active_installations: nonNegativeCount(row.active_installations),
      governed_sessions: nonNegativeCount(row.governed_sessions),
      approval_requests: nonNegativeCount(row.approval_requests),
      approval_decisions: nonNegativeCount(row.approval_decisions),
    })),
    retention: {
      cohort_size: nonNegativeCount(retentionRow.cohort_size),
      day_1: { ...d1, rate: rate(d1.retained, d1.eligible) },
      day_7: { ...d7, rate: rate(d7.retained, d7.eligible) },
      day_30: { ...d30, rate: rate(d30.retained, d30.eligible) },
    },
  };
}

async function handleRequest(request: Request, env: Env, now: () => Date): Promise<Response> {
  const url = new URL(request.url);

  if (url.pathname === "/health") {
    if (request.method !== "GET") return methodNotAllowed("GET");
    return json({ status: "ok" });
  }

  if (url.pathname === "/v1/events") {
    if (request.method !== "POST") return methodNotAllowed("POST");
    requireSecret(env.HASH_SECRET, "HASH_SECRET");
    // Cloudflare supplies this header at the edge. The value is used only as a transient
    // rate-limit key; application code never logs or persists it.
    const rateKey = request.headers.get("CF-Connecting-IP") ?? "local-development";
    const rateResult = await env.RATE_LIMITER.limit({ key: rateKey });
    if (!rateResult.success) return json({ error: "rate limit exceeded" }, 429);
    const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
    if (contentType !== "application/json") {
      return json({ error: "content-type must be application/json" }, 415);
    }

    const body = await readJsonBody(request);
    if (body.status === 413) return json({ error: "request body too large" }, 413);
    if (body.status === 400) return json({ error: "invalid JSON" }, 400);
    const parsed = TelemetryBatch.safeParse(body.value);
    if (!parsed.success) return json({ error: "invalid telemetry batch" }, 400);
    // SEC-3 (2026-08-13 監査): 受理窓外の occurred_on (太古/未来日) は batch ごと 400。
    const requestTime = now();
    const oldestAccepted = utcDay(new Date(requestTime.getTime() - ACCEPT_PAST_DAYS * 86_400_000));
    const newestAccepted = utcDay(
      new Date(requestTime.getTime() + ACCEPT_FUTURE_DAYS * 86_400_000),
    );
    const outOfWindow = parsed.data.events.some(
      (event) => event.occurred_on < oldestAccepted || event.occurred_on > newestAccepted,
    );
    if (outOfWindow) return json({ error: "occurred_on outside accepted window" }, 400);
    await persistBatch(env, parsed.data);
    return json({ accepted: parsed.data.events.length }, 202);
  }

  if (url.pathname === "/v1/admin/report") {
    if (request.method !== "GET") return methodNotAllowed("GET");
    requireSecret(env.ADMIN_TOKEN, "ADMIN_TOKEN");
    if (!(await constantTimeToken(env.ADMIN_TOKEN, request.headers.get("authorization")))) {
      return json({ error: "unauthorized" }, 401);
    }
    const requestTime = now();
    const range = parseReportRange(url, requestTime);
    if (!range) return json({ error: "invalid range (maximum 365 days)" }, 400);
    return json(await aggregateReport(env.DB, range, requestTime));
  }

  return json({ error: "not found" }, 404);
}

/**
 * Retention purge (operator decision 2026-08-26: TELEMETRY_RETENTION_MONTHS in the contract).
 * Deletes rows whose `occurred_on` is strictly older than the cutoff; the cutoff day itself is
 * retained. Runs from the cron trigger declared in wrangler config. Errors are not swallowed:
 * a failed purge must surface in the Worker's error metrics rather than silently retain data.
 */
async function purgeExpiredRows(db: D1Database, now: Date): Promise<number> {
  const cutoff = telemetryRetentionCutoff(now);
  const result = await db
    .prepare("DELETE FROM telemetry_daily WHERE occurred_on < ?")
    .bind(cutoff)
    .run();
  return nonNegativeCount(result.meta?.changes);
}

export function createTelemetryWorker(options: WorkerOptions = {}): ExportedHandler<Env> {
  const now = options.now ?? (() => new Date());
  return {
    async fetch(request, env): Promise<Response> {
      try {
        return await handleRequest(request, env, now);
      } catch {
        // Do not leak D1 errors or secret/configuration details to public clients.
        return json({ error: "service unavailable" }, 503);
      }
    },
    async scheduled(_controller, env): Promise<void> {
      await purgeExpiredRows(env.DB, now());
    },
  };
}

export default createTelemetryWorker();
