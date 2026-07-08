/**
 * @actradeck/redaction — T1 canonical secret redactor (INV-REDACTION) + node 専用共有 security primitive。
 *
 * 保存・送信の「前」に適用する secret redactor。sidecar sink choke と backend ingress 床の
 * **単一出所** (ADR 019f2d2c D3・security-gate-reuse-canonical-parser)。event-model のみに依存し、
 * webui バンドルには混入しない (依存方向: sidecar / backend → redaction → event-model)。
 *
 * TDA-1 (裁定 019f3ed6) 註: `tokenEquals` (定数時間トークン比較) は redaction そのものではないが
 * **意図的に本パッケージへ配置**している — node:crypto 依存ゆえ browser 共有の event-model に置けず、
 * sidecar+backend 両方が既依存する node 専用 security パッケージはここだけだから (decision 019f3ec7)。
 * 「redactor に誤配」と誤認して外へ移すと 5 ゲート consolidation が巻き戻る。移す場合は full 監査を通すこと。
 */
export * from "./redactor.js";
export { redactEventWithAuthoritativeCounts } from "./redact-for-persist.js";
export { tokenEquals } from "./token-equals.js";
