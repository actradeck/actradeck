/**
 * @actradeck/sidecar — Local Sidecar daemon (Phase 2 で実装).
 *
 * Managed Mode (`agentmon claude`): node-pty で claude を子プロセス起動し、
 * hook receiver / process monitor / stdout-stderr collector / git diff watcher /
 * secret redactor (INV-REDACTION) / SQLite append-only / WS client を担う。
 *
 * Phase 0 は骨組みのみ。
 */
import { EVENT_MODEL_PACKAGE } from "@actradeck/event-model";

export const SIDECAR_NAME = "@actradeck/sidecar" as const;

// event-model を import 可能であることの最小確認（Phase 0 配線チェック）。
export function describeSidecar(): string {
  return `${SIDECAR_NAME} (uses ${EVENT_MODEL_PACKAGE})`;
}
