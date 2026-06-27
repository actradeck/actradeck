/**
 * event_id の採番・検証 (UUIDv7, T1 正典).
 *
 * 方針 (Phase 0 合意): event_id はアプリ側 (event-model) で UUIDv7 を採番する。
 * - 時系列ソート可能 (timestamp 高位ビット) → DB の B-Tree 局所性 + 順序診断に有利。
 * - DB 側 gen は強制しない (拡張の有無に依存しない / Sidecar 採番も同一実装)。
 *
 * 実装は `uuid` パッケージの v7 を使う。Node v22 には crypto.randomUUIDv7 が未実装
 * のため (WebSearch 確認 2026-06)、外部依存で安定実装を採用する。将来 Node ネイティブ
 * が全対象ランタイムで利用可能になれば差し替え可能なよう、ここに集約する。
 */
import { v7 as uuidv7, validate as uuidValidate, version as uuidVersion } from "uuid";
import { z } from "zod";

/** 新しい event_id (UUIDv7 文字列) を採番する。 */
export function newEventId(): string {
  return uuidv7();
}

/** 文字列が UUIDv7 形式か (妥当な UUID かつ version フィールドが 7)。 */
export function isUuidV7(value: string): boolean {
  return uuidValidate(value) && uuidVersion(value) === 7;
}

/**
 * event_id 用 zod schema (UUIDv7 厳格)。
 * 任意の UUID ではなく v7 であることを要求する (INV-EVENT-ID)。
 */
export const EventId = z.string().refine(isUuidV7, { message: "event_id must be a valid UUIDv7" });
export type EventId = z.infer<typeof EventId>;
