/**
 * Backward-compatible backend entrypoint for the shared projection reducer.
 *
 * The reducer logic lives in `@actradeck/projection` so backend ingestion and WebUI Session Replay
 * reconstruct state from one implementation. Existing backend-local imports keep working through
 * this re-export.
 */
export {
  MAX_PENDING_APPROVALS,
  applyEvent,
  initialProjection,
  parsePendingApprovals,
  reduceEvents,
  type PendingApproval,
  type ReduceResult,
  type SessionProjection,
} from "@actradeck/projection";
