/**
 * Liveness シグナル分類の T1 正典 (single source of truth).
 *
 * 「どの event_type がどの liveness シグナル (stdout / file / modelStream) に寄与するか」を
 * **一箇所**で定義する。backend の TS リファレンス実装 (`observeFromEvents`) と本番の SQL 集約
 * (`aggregateObservation`) が **同じ**この定数を参照することで、両者が分類でドリフトしないよう縛る
 * (TDA-2: SQL/TS parity ガード)。
 *
 * 値は EventType (event-type.ts) の部分集合。EventType を変えたらこの分類も追従させる
 * (parity テストと型が乖離を検出する)。
 */
import type { EventType } from "./event-type.js";

/** stdout 鮮度に寄与する event_type 群 (command / tool の出力 delta)。 */
export const STDOUT_EVENT_TYPES = [
  "command.output.delta",
  "tool.output.delta",
] as const satisfies readonly EventType[];

/** file 鮮度に寄与する event_type 群 (差分の提案/承認/適用)。 */
export const FILE_EVENT_TYPES = [
  "file.change.proposed",
  "file.change.approved",
  "file.change.applied",
  "diff.updated",
] as const satisfies readonly EventType[];

/** model-stream 鮮度に寄与する event_type 群 (本文 / reasoning summary の delta)。 */
export const MODEL_STREAM_EVENT_TYPES = [
  "agent.message.delta",
  "agent.reasoning_summary.delta",
] as const satisfies readonly EventType[];

/** heartbeat の event_type (process 生死シグナルの担い手)。 */
export const HEARTBEAT_EVENT_TYPE = "heartbeat" as const satisfies EventType;

/** heartbeat payload に格納される process 生死フラグのキー。 */
export const PROCESS_ALIVE_PAYLOAD_KEY = "process_alive" as const;
