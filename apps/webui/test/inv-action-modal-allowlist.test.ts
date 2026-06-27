/**
 * INV-ACTION-MODAL-ALLOWLIST (設計裁定 019eb981 / security.md).
 *
 * アクション単位ビュー & 詳細モーダルの系統 (action-units / action-units-display /
 * ActionTimeline / ActionDetailModal) が **ReplayEventDTO allow-list フィールドのみ**を参照し、
 * 生 payload / tool_input 等の本文チャネルを新設しないことを静的に固定する。
 *
 * backend が redaction 済みで載せた allow-list 値だけを表示へ落とす契約 (current-action-display
 * と同方針)。本文 (stdout / diff) は use-session-body 経由の redaction 済み pull のみで、ここが
 * 緩むと redaction 前提の崩れに直結するため CI を赤化させる。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/** ReplayEventDTO allow-list (backend replay-contract.ts と一致させる)。 */
const ALLOWED_FIELDS = new Set([
  "event_id",
  "provider",
  "source",
  "session_id",
  "event_type",
  "kind",
  "timestamp",
  "state",
  "cwd",
  "summary",
  "display_text",
  "request_id",
  "tool_name",
  "command",
  "path",
  "risk_level",
  "decision",
  "auto_allowed",
  "exit_code",
  "elapsed_ms",
]);

/** allow-list 外で UI が触ったら redaction 前提を崩しうる「生 payload」系フィールド名。 */
const FORBIDDEN_TOKENS = [
  "payload",
  "tool_input",
  "raw_payload",
  ".metrics", // DTO は elapsed_ms に投影済み。生 metrics へ降りない。
  "credential",
];

const FILES = [
  "../src/ui/action-units.ts",
  "../src/ui/action-units-display.ts",
  "../src/ui/ActionTimeline.tsx",
  "../src/ui/ActionDetailModal.tsx",
] as const;

function readSrc(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
}

/** 行コメントとブロックコメントを除いたコードのみを返す (コメント文言の誤検出を避ける)。 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

describe("INV-ACTION-MODAL-ALLOWLIST: 生 payload 経路を作らない", () => {
  for (const rel of FILES) {
    const code = stripComments(readSrc(rel));

    it(`${rel} は生 payload/tool_input 等を参照しない`, () => {
      for (const token of FORBIDDEN_TOKENS) {
        expect(code, `${rel} references forbidden token "${token}"`).not.toContain(token);
      }
    });

    it(`${rel} のイベントプロパティアクセスは DTO allow-list 内のみ`, () => {
      // `e.<field>` / `unit.events[..].<field>` 等で参照される ReplayEventDTO 由来プロパティを抽出する。
      // ヒューリスティック: 識別子 `.snake_case` を集め、allow-list 外の DTO 風 (snake_case 含む) を検出。
      const propRe = /\.([a-z][a-z0-9]*(?:_[a-z0-9]+)+)\b/g;
      let m: RegExpExecArray | null;
      const offenders = new Set<string>();
      while ((m = propRe.exec(code)) !== null) {
        const prop = m[1]!;
        // DTO の snake_case フィールドのみを対象 (camelCase の派生型プロパティ等は別物)。
        if (!ALLOWED_FIELDS.has(prop)) offenders.add(prop);
      }
      // 既知の非 DTO snake_case (本文 pull 応答の redaction 済みフィールド) は許可リストで除外。
      const KNOWN_NON_DTO = new Set([
        "output_excerpt", // OutputBody (redaction 済み)
        "anchor_event_id", // OutputBody
        "not_found", // OutputBody
        "secret_detected", // DiffBody (件数/bool のみ)
        "redaction_count", // DiffBody
      ]);
      const real = [...offenders].filter((p) => !KNOWN_NON_DTO.has(p));
      expect(real, `non-allowlist snake_case props in ${rel}: ${real.join(", ")}`).toEqual([]);
    });
  }
});
