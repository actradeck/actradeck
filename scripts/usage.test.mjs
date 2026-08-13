// node --test gate for the local usage CLI (QA-9, 2026-08-13 audit).
import assert from "node:assert/strict";
import { test } from "node:test";

import { backendOrigin } from "./lib/backend-origin.mjs";
import { parseArgs } from "./usage.mjs";

test("parseArgs defaults and accepts --since / --json", () => {
  assert.deepEqual(parseArgs([]), { since: "30d", json: false });
  assert.deepEqual(parseArgs(["--since", "7d", "--json"]), { since: "7d", json: true });
  assert.deepEqual(parseArgs(["--since=2026-08-01"]), { since: "2026-08-01", json: false });
});

test("parseArgs rejects unknown options and a missing --since value", () => {
  assert.throws(() => parseArgs(["--nope"]), /unknown option/);
  assert.throws(() => parseArgs(["--since"]), /--since requires/);
});

test("backendOrigin folds wildcard binds to loopback and brackets IPv6 (shared lib)", () => {
  assert.equal(backendOrigin({}), "http://127.0.0.1:55410");
  assert.equal(
    backendOrigin({ ACTRADECK_BACKEND_HOST: "0.0.0.0", ACTRADECK_BACKEND_PORT: "56000" }),
    "http://127.0.0.1:56000",
  );
  assert.equal(backendOrigin({ ACTRADECK_BACKEND_HOST: "::" }), "http://127.0.0.1:55410");
  assert.equal(backendOrigin({ ACTRADECK_BACKEND_HOST: "::1" }), "http://[::1]:55410");
});
