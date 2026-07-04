/**
 * @actradeck/redaction — T1 canonical secret redactor (INV-REDACTION)。
 *
 * 保存・送信の「前」に適用する secret redactor。sidecar sink choke と backend ingress 床の
 * **単一出所** (ADR 019f2d2c D3・security-gate-reuse-canonical-parser)。event-model のみに依存し、
 * webui バンドルには混入しない (依存方向: sidecar / backend → redaction → event-model)。
 */
export * from "./redactor.js";
export { redactEventWithAuthoritativeCounts } from "./redact-for-persist.js";
