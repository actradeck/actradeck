/**
 * INV-AUDIT-VERIFY-RATE-LIMIT — the audit-manifest verify routes are rate limited, and only they.
 *
 * Both verify routes recompute a canonical hash chain and an Ed25519 signature over
 * caller-supplied input, so the work per request is chosen by the caller (bounded only by
 * AUDIT_VERIFY_BODY_LIMIT) and, unlike the rest of /realtime, is not gated behind a database
 * round trip. The bearer REALTIME_TOKEN and the loopback / single-operator deployment remain the
 * primary control; the limiter bounds how much CPU one already-authenticated caller can spend.
 *
 * Invariants pinned here (each has a mutation that reddens it):
 *  - **limited**: the ceiling actually refuses. Dropping `config: { rateLimit: … }` from a verify
 *    route, or the `app.register(fastifyRateLimit, { global: false })` call in ingestion-server,
 *    turns the over-budget request back into a handler response instead of 429.
 *  - **opt-in only**: a /realtime route that does not name the config is not limited. Flipping the
 *    plugin to `global: true` would refuse ordinary cockpit traffic — a availability regression
 *    that no other test would catch.
 *  - **auth first**: unauthenticated callers are refused before the limiter counts them, so a
 *    tokenless flood cannot exhaust the operator's budget. This depends on the /realtime auth
 *    hook being a global onRequest hook (which runs ahead of route-level hooks); moving the
 *    limiter ahead of it would let an anonymous caller deny service to the operator.
 *
 * DB-free by construction: the verify routes touch no database, so the pool is a stub whose
 * query path is never reached on the limited routes. The opt-in probe deliberately picks a
 * DB-backed route and asserts only that it is *not* refused, never what it returns.
 */
import { describe, expect, it } from "vitest";
import type { Pool } from "pg";
import type { FastifyInstance } from "fastify";

import { buildIngestionServer } from "../src/ingestion-server.js";

const REALTIME_TOKEN = "test-realtime-token-audit-rate-limit";
const auth = { authorization: `Bearer ${REALTIME_TOKEN}` };

/** Matches AUDIT_VERIFY_RATE_LIMIT.max in realtime-server.ts. */
const MAX_PER_WINDOW = 60;

const VERIFY_ROUTES = ["/realtime/audit/verify", "/realtime/audit/packet/verify"] as const;

/** A pool that never connects: the limited routes must not need one. */
function stubPool(): Pool {
  return {
    connect: async () => {
      throw new Error("stub pool: no database in this suite");
    },
    query: async () => {
      throw new Error("stub pool: no database in this suite");
    },
    on() {
      return this;
    },
    end: async () => {},
  } as unknown as Pool;
}

async function buildApp(): Promise<FastifyInstance> {
  return await buildIngestionServer({
    pool: stubPool(),
    ingestToken: "t-ingest-audit-rate-limit",
    realtimeToken: REALTIME_TOKEN,
  });
}

async function post(
  app: FastifyInstance,
  url: string,
  headers: Record<string, string>,
): Promise<number> {
  const res = await app.inject({ method: "POST", url, headers, payload: {} });
  return res.statusCode;
}

describe("INV-AUDIT-VERIFY-RATE-LIMIT", () => {
  // Both verify routes are asserted: they share one constant, and a future edit that wires only
  // one of them would otherwise leave the other unbounded with the suite still green.
  for (const url of VERIFY_ROUTES) {
    it(`refuses an authenticated caller past the ceiling on ${url}`, async () => {
      const app = await buildApp();
      try {
        const withinBudget: number[] = [];
        for (let i = 0; i < MAX_PER_WINDOW; i += 1) {
          withinBudget.push(await post(app, url, auth));
        }
        // Every request inside the budget reaches the handler, which rejects the empty body as a
        // malformed manifest. The point is that it is the *handler* answering, not the limiter.
        expect(withinBudget).toHaveLength(MAX_PER_WINDOW);
        expect(new Set(withinBudget)).toEqual(new Set([400]));

        expect(await post(app, url, auth)).toBe(429);
      } finally {
        await app.close();
      }
    });
  }

  it("leaves routes that do not opt in unlimited (the plugin is not global)", async () => {
    const app = await buildApp();
    try {
      // A DB-backed /realtime route: with a stub pool it answers 500, and the assertion is only
      // that it never becomes 429 — ordinary cockpit polling must not be throttled.
      const statuses = new Set<number>();
      for (let i = 0; i < MAX_PER_WINDOW + 1; i += 1) {
        const res = await app.inject({
          method: "GET",
          url: "/realtime/audit/coverage",
          headers: auth,
        });
        statuses.add(res.statusCode);
      }
      expect(statuses.has(429)).toBe(false);
    } finally {
      await app.close();
    }
  });

  it("does not spend the budget on unauthenticated callers", async () => {
    const app = await buildApp();
    try {
      const anonymous = new Set<number>();
      for (let i = 0; i < MAX_PER_WINDOW + 1; i += 1) {
        anonymous.add(await post(app, VERIFY_ROUTES[1], {}));
      }
      // Refused by the /realtime auth hook, which runs ahead of the route-level limiter.
      expect(anonymous).toEqual(new Set([401]));

      // The operator's budget is untouched: the first authenticated request still reaches the
      // handler. If the limiter counted anonymous traffic this would already be 429.
      expect(await post(app, VERIFY_ROUTES[1], auth)).toBe(400);
    } finally {
      await app.close();
    }
  });
});
