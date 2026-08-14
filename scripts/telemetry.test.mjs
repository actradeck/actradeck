import assert from "node:assert/strict";
import test from "node:test";

import { backendOrigin, parseArgs } from "./telemetry.mjs";

test("telemetry CLI defaults to a human-readable local status", () => {
  assert.deepEqual(parseArgs([]), { action: "status", endpoint: undefined, json: false });
  assert.deepEqual(parseArgs(["preview", "--json"]), {
    action: "preview",
    endpoint: undefined,
    json: true,
  });
});

test("telemetry CLI accepts an endpoint only for explicit enable", () => {
  assert.deepEqual(parseArgs(["enable", "--endpoint", "https://telemetry.example/v1/events"]), {
    action: "enable",
    endpoint: "https://telemetry.example/v1/events",
    json: false,
  });
  assert.throws(() => parseArgs(["status", "--endpoint=https://telemetry.example/v1/events"]));
  assert.throws(() => parseArgs(["raw-events"]));
});

test("backend origin remains loopback for wildcard binds and formats IPv6", () => {
  assert.equal(backendOrigin({}), "http://127.0.0.1:55410");
  assert.equal(
    backendOrigin({ ACTRADECK_BACKEND_HOST: "0.0.0.0", ACTRADECK_BACKEND_PORT: "56010" }),
    "http://127.0.0.1:56010",
  );
  assert.equal(backendOrigin({ ACTRADECK_BACKEND_HOST: "::1" }), "http://[::1]:55410");
});
