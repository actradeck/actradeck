/**
 * WS 契約 (T1) の **単一の真実の再エクスポート**.
 *
 * `ServerFrame` / `ClientFrame` / `SessionListItem` / `SessionDetail` などの WS フレーム型は
 * backend (`apps/backend/src/realtime-hub.ts`) が正典 (T1)。UI 側でこれらを再定義すると
 * ドリフトの温床になる (CLAUDE.md: T1 が勝つ・重複定義禁止)。
 *
 * ここでは `@actradeck/backend` パッケージ entrypoint から **type-only import** で取り込む。
 * `verbatimModuleSyntax` + `import type` のため backend の実行コード (fastify / pg 等) は
 * バンドルに一切混入しない (型だけが消去される)。これで「単一の真実」を満たしつつ
 * ブラウザバンドルを汚さない。
 */
export type {
  ServerFrame,
  ClientFrame,
  SessionListItem,
  SessionDetail,
  PendingApproval,
  SessionApprovals,
  WallLane,
  ReplayEventDTO,
  ReplayEventKind,
  ReplayOrder,
  ReplayEventsPage,
  // PAL-v2 (ADR 019ee147): 永続承認 allowlist エントリ (NO-RAW)。
  AllowlistEntry,
} from "@actradeck/backend";

// liveness 型も backend 正典を再利用 (UI の heartbeat 分解表示が依存する)。
export type { LivenessState, LivenessEvidence } from "@actradeck/backend";
