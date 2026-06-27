/**
 * Redaction 可視化の表示ヘルパ (強み(a)③ redaction 可視化・UI フェーズ).
 *
 * 役割:
 *  - `secret_redaction_count_by_kind` (kind→件数の DTO map) を、UI で安定描画できる
 *    エントリ配列へ正規化する (壊れ値を graceful に除外し、安定順で並べる)。
 *  - kind 文字列 → i18n ラベルキーへの写像 (表示変換は **UI 層のみ**・データ層は raw 保持)。
 *
 * SEC 不変条件 (INV-REDACTION 隣接):
 *  - 扱うのは **kind 名 (公開 enum 文字列) + 件数 (非負整数) のみ**。秘匿値・原文は一切受け取らない。
 *  - kind 文字列は表示ラベルへ変換するだけで、原文を復元・露出する経路は無い。
 *
 * データ層と表示層の分離 (ユーザー確定方針):
 *  - DTO は kind 文字列を raw のまま運ぶ (event-model の closed-enum 正典)。
 *  - 本モジュール (UI 層) のみが kind → ラベルキーへ写像する。未知 kind は kind 文字列を
 *    そのまま fallback 表示する (forward-compat: 新 sidecar kind を落とさない)。
 */
import { REDACTION_KINDS, isKnownRedactionKind, type RedactionKind } from "@actradeck/event-model";

import type { MessageKey } from "./i18n/messages";

/** 1 kind の表示用エントリ (件数つき)。raw kind 文字列を保持し、表示変換は描画時に行う。 */
export interface RedactionKindEntry {
  /** raw kind 文字列 (公開 enum もしくは未知 kind)。data 層が運ぶ値そのまま。 */
  readonly kind: string;
  /** その kind の累積 redaction 件数 (正の整数のみ; 0/負/非整数は除外済)。 */
  readonly count: number;
}

/**
 * 既知 kind の i18n ラベルキー (`redaction.kind.<kind>`)。`REDACTION_KINDS` 全 kind に対応する
 * ラベルが messages.ts に存在することを inv-i18n / 専用テストで pin する。
 * `RedactionKind` (closed-enum) からのみ生成するため、戻り型は常に有効な MessageKey の部分集合
 * (`redaction.kind.<known>`) になる。
 */
export type RedactionKindLabelKey = `redaction.kind.${RedactionKind}`;

/**
 * 既知 kind → ラベルキー。closed-enum (REDACTION_KINDS) の各値に 1:1。引数を `RedactionKind` に
 * 限ることで、`t()` が要求する MessageKey 互換を型で保証する (未知 kind は呼び出し側で raw 表示)。
 */
export function redactionKindLabelKey(kind: RedactionKind): RedactionKindLabelKey {
  return `redaction.kind.${kind}`;
}

/**
 * 全 `REDACTION_KINDS` のラベルキー一覧 (i18n parity テスト用 / 取りこぼし検出)。
 * MessageKey として静的に存在することは型 (en: Record<MessageKey,string>) でも担保される。
 */
export const REDACTION_KIND_LABEL_KEYS: readonly MessageKey[] = REDACTION_KINDS.map((k) =>
  redactionKindLabelKey(k),
);

/**
 * DTO の `secret_redaction_count_by_kind` を安定順のエントリ配列へ正規化する。
 *
 * graceful 規律 (欠落/空/不正で非表示・クラッシュしない):
 *  - undefined / null / 非オブジェクト → 空配列。
 *  - 値が 非有限 / 非整数 / <= 0 のエントリは除外 (件数 0 を「検出」と誤表示しない)。
 *  - prototype 汚染 key (__proto__ 等) は own enumerable のみ走査で自然に無視。
 *
 * 安定順: 件数 desc → 同数は kind 名 asc (描画ごとに揺れない決定的順序)。未知 kind も同基準で並ぶ。
 */
export function redactionEntries(
  byKind: Readonly<Record<string, number>> | undefined,
): readonly RedactionKindEntry[] {
  if (byKind === undefined || byKind === null || typeof byKind !== "object") return [];
  const out: RedactionKindEntry[] = [];
  for (const [kind, raw] of Object.entries(byKind)) {
    if (typeof raw !== "number" || !Number.isFinite(raw)) continue;
    if (!Number.isInteger(raw) || raw <= 0) continue;
    out.push({ kind, count: raw });
  }
  out.sort((a, b) => b.count - a.count || (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0));
  return out;
}

/** エントリ群の件数合計 (内訳タグの脇に出す by-kind 合計; scalar count とは別物)。 */
export function redactionEntriesTotal(entries: readonly RedactionKindEntry[]): number {
  let n = 0;
  for (const e of entries) n += e.count;
  return n;
}

/**
 * 与えられた kind が公開 enum (既知) か (未知なら fallback 表示を選ぶための判定)。
 * type guard として narrowing を効かせ、true 枝で `redactionKindLabelKey` を型安全に呼べる。
 */
export function isKnownKind(kind: string): kind is RedactionKind {
  return isKnownRedactionKind(kind);
}
