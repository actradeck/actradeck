/**
 * Single source for the loopback backend origin used by operator CLIs (TDA-5, 2026-08-13 audit).
 *
 * The wildcard-bind fold (0.0.0.0 / :: → 127.0.0.1) is a small security-relevant judgment: the
 * CLI must talk to loopback even when the backend is configured to bind all interfaces. Keep it
 * here — hand copies drift, and the untested copy becomes the effective behavior.
 */
export function backendOrigin(env = process.env) {
  const rawHost = env.ACTRADECK_BACKEND_HOST || "127.0.0.1";
  const host = rawHost === "0.0.0.0" || rawHost === "::" ? "127.0.0.1" : rawHost;
  const urlHost = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  const port = env.ACTRADECK_BACKEND_PORT || "55410";
  return `http://${urlHost}:${port}`;
}
